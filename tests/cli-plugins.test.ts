import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLUGIN_CAPABILITIES } from '../packages/core/dist/index.js';
import { pluginCapabilities, run } from '../packages/cli/dist/index.js';
import { boot, freshApp, json, ok, read, tsc } from './support/cli-fixture.js';
import type { BootedApp } from './support/cli-fixture.js';

// Extensions/CLI round 4 port range 3970-3979.
const port = 3971;
const plugin = '@acme/nestvexa-audit';

/**
 * A plugin package the developer installed: a NestvexaExtension plus the
 * `nestvexa` manifest in package.json. Importing it writes a marker file, so
 * the tests can prove the CLI never executes plugin code.
 */
function installPlugin(
  root: string,
  manifest: Record<string, unknown>,
  name = plugin,
  version = '1.2.0',
): void {
  const directory = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name,
      version,
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
      nestvexa: manifest,
    }),
  );
  writeFileSync(
    join(directory, 'index.js'),
    `import { writeFileSync } from 'node:fs';
import { defineExtension, definePlugin } from 'nestvexa';

writeFileSync('plugin-imported.txt', 'imported');
export const extension = defineExtension({
  name: 'acme-audit',
  version: '1.2.0',
  nestvexa: '^0.1.0-alpha.0',
  register() {
    writeFileSync('plugin-registered.txt', 'registered');
  },
});
export const second = defineExtension({ name: 'acme-second' });
// The deprecated plugin contract, adapted with pluginExtension().
export const legacy = definePlugin({
  manifest: { name: '${name}', version: '${version}', nestvexa: '^0.1.0-alpha.0', capabilities: ['instrumentation'] },
  setup() {
    writeFileSync('plugin-legacy.txt', 'setup');
  },
});
`,
  );
  writeFileSync(
    join(directory, 'index.d.ts'),
    "import type { NestvexaExtension, NestvexaPlugin } from 'nestvexa';\nexport declare const extension: NestvexaExtension;\nexport declare const second: NestvexaExtension;\nexport declare const legacy: NestvexaPlugin;\n",
  );
}
const manifest = {
  name: plugin,
  version: '1.2.0',
  nestvexa: '^0.1.0-alpha.0',
  capabilities: ['instrumentation'],
  description: 'Audit trail',
};
function declare(root: string, name: string): void {
  const pkg = JSON.parse(read(root, 'package.json')) as {
    dependencies: Record<string, string>;
  };
  pkg.dependencies[name] = '1.2.0';
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
  );
}

describe('nestvexa add plugin', { timeout: 300_000 }, () => {
  let root = '';
  let app: BootedApp | undefined;
  beforeAll(() => {
    root = freshApp('plugin-app', { directory: 'cli-plugins' });
    ok(run(['init'], root));
  }, 120_000);
  afterAll(() => app?.stop());

  it('accepts only the capabilities of the core plugin contract', () => {
    expect([...pluginCapabilities]).toEqual([...PLUGIN_CAPABILITIES]);
  });

  it('refuses paths, URLs, undeclared, missing and invalid plugins without writing', () => {
    const before = read(root, 'src/app.module.ts');
    for (const name of [
      '',
      '../evil',
      './local-plugin',
      'https://evil.example/plugin.tgz',
      'git+ssh://git@github.com/acme/plugin.git',
      'file:../plugin',
      'Acme',
    ])
      expect(run(['add', 'plugin', name], root).exitCode, name).toBe(2);
    expect(
      run(['add', 'plugin', plugin, '--export', 'not-valid'], root).exitCode,
    ).toBe(2);
    const undeclared = run(['add', 'plugin', plugin], root);
    expect(undeclared.exitCode).toBe(1);
    expect(undeclared.stderr.join('\n')).toContain(
      'the CLI never downloads plugins',
    );
    declare(root, plugin);
    expect(run(['add', 'plugin', plugin], root).stderr.join('\n')).toContain(
      'is declared but not installed',
    );
    const refused = (
      value: Record<string, unknown> | undefined,
      text: string,
    ) => {
      installPlugin(root, value ?? {});
      if (value === undefined) {
        const file = join(
          root,
          'node_modules',
          '@acme',
          'nestvexa-audit',
          'package.json',
        );
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<
          string,
          unknown
        >;
        delete pkg['nestvexa'];
        writeFileSync(file, JSON.stringify(pkg));
      }
      const result = run(['add', 'plugin', plugin], root);
      expect(result.exitCode, text).toBe(1);
      expect(result.stderr.join('\n')).toContain(text);
    };
    refused(undefined, 'is not a Nestvexa plugin');
    refused({ ...manifest, name: '@acme/other' }, 'is not the package name');
    refused({ ...manifest, version: '9.9.9' }, 'is not the installed version');
    refused(
      { ...manifest, nestvexa: '^2.0.0' },
      'supports Nestvexa ^2.0.0, not the installed',
    );
    refused({ ...manifest, capabilities: ['remote-code'] }, 'capabilities');
    refused({ ...manifest, capabilities: [] }, 'capabilities');
    refused({ ...manifest, entry: './index.js' }, 'unknown key "entry"');
    expect(read(root, 'src/app.module.ts')).toBe(before);
    expect(existsSync(join(root, 'src/nestvexa/extensions.ts'))).toBe(false);
    expect(existsSync(join(root, 'plugin-imported.txt'))).toBe(false);
  });

  it('wires an installed extension into the kernel registration once, without running it', () => {
    installPlugin(root, manifest);
    const dry = run(['add', 'plugin', plugin, '--dry-run'], root);
    ok(dry);
    expect(existsSync(join(root, 'src/nestvexa/extensions.ts'))).toBe(false);
    const result = json(run(['add', 'plugin', plugin, '--json'], root));
    expect(result.ok).toBe(true);
    expect(result.messages?.[0]).toContain(
      'Installed @acme/nestvexa-audit@1.2.0 (instrumentation; supports Nestvexa ^0.1.0-alpha.0) as acmeNestvexaAuditExtension',
    );
    ok(run(['add', 'plugin', plugin, '--export', 'second'], root));
    ok(
      run(
        ['add', 'plugin', plugin, '--export', 'legacy', '--legacy-plugin'],
        root,
      ),
    );
    expect(json(run(['add', 'plugin', plugin, '--json'], root))).toMatchObject({
      ok: true,
      changes: [],
    });
    const extensions = read(root, 'src/nestvexa/extensions.ts');
    expect(extensions).toContain(
      "import { extension as acmeNestvexaAuditExtension, second as acmeNestvexaAuditSecond, legacy as acmeNestvexaAuditLegacy } from '@acme/nestvexa-audit';",
    );
    expect(extensions).toContain("import { pluginExtension } from 'nestvexa';");
    expect(extensions).toMatch(
      /acmeNestvexaAuditExtension,\n\s+acmeNestvexaAuditSecond,\n\s+pluginExtension\(acmeNestvexaAuditLegacy\),\n\s+\/\/ nestvexa:extensions/,
    );
    const module = read(root, 'src/app.module.ts');
    expect(module).toContain(
      'NestvexaModule.forRoot(nestvexaOptions, nestvexaLive, nestvexaKernel)',
    );
    expect(module.match(/nestvexaKernel/g)).toHaveLength(2);
    // Static wiring only: the plugin module was never imported by the CLI.
    expect(existsSync(join(root, 'plugin-imported.txt'))).toBe(false);
    const compiled = tsc(root);
    expect(compiled.status, compiled.output).toBe(0);
  });

  it('runs the extension hooks when the application starts', async () => {
    app = await boot(root, port);
    expect(existsSync(join(root, 'plugin-imported.txt'))).toBe(true);
    expect(read(root, 'plugin-registered.txt')).toBe('registered');
    // The legacy plugin's setup ran through the unified extension host.
    expect(read(root, 'plugin-legacy.txt')).toBe('setup');
    expect((await fetch(`${app.origin}/nestvexa`)).status).toBe(200);
  });
});
