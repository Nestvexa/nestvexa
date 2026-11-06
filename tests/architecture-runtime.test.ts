import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Imports server packages in a fresh, plain Node process (no test runner, no
 * DOM shim) and reports every module URL resolved, browser globals, new global
 * keys, process listeners and active handles created by the import alone.
 */
const probe = `
import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
const { port1, port2 } = new MessageChannel();
const seen = [];
port1.on('message', (url) => seen.push(url));
register(
  'data:text/javascript,' +
    encodeURIComponent(
      'let port; export function initialize(data) { port = data.port; }' +
        ' export async function resolve(specifier, context, next) {' +
        ' const result = await next(specifier, context); port.postMessage(result.url); return result; }',
    ),
  { data: { port: port2 }, transferList: [port2] },
);
const events = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];
const listeners = () => Object.fromEntries(events.map((name) => [name, process.listenerCount(name)]));
const globalsBefore = new Set(Reflect.ownKeys(globalThis).map(String));
const listenersBefore = listeners();
const handlesBefore = process.getActiveResourcesInfo().length;
for (const target of JSON.parse(process.argv[1])) await import(target);
const handlesAfter = process.getActiveResourcesInfo().length;
const listenersAfter = listeners();
const addedGlobals = Reflect.ownKeys(globalThis).map(String).filter((key) => !globalsBefore.has(key));
await new Promise((done) => setTimeout(done, 100));
port1.close();
process.stdout.write(JSON.stringify({
  seen,
  window: typeof globalThis.window,
  document: typeof globalThis.document,
  addedGlobals,
  listenersBefore,
  listenersAfter,
  handlesBefore,
  handlesAfter,
}));
`;

interface Report {
  readonly seen: string[];
  readonly window: string;
  readonly document: string;
  readonly addedGlobals: string[];
  readonly listenersBefore: Record<string, number>;
  readonly listenersAfter: Record<string, number>;
  readonly handlesBefore: number;
  readonly handlesAfter: number;
}

function run(entries: readonly string[]): Promise<Report> {
  const targets = entries.map((entry) => pathToFileURL(resolve(entry)).href);
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', probe, JSON.stringify(targets)],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message, { cause: error }));
        else done(JSON.parse(stdout) as Report);
      },
    );
  });
}

const browserOrFrontend =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:react|react-dom|vue|svelte|alpinejs|@alpinejs|jsdom|happy-dom|@inertiajs)\/|\/packages\/(?:client|alpine|react|vue|svelte|inertia|islands)\//;

describe('server packages in a plain Node process', () => {
  it.each([
    ['@nestvexa/core', ['packages/core/dist/index.js']],
    ['@nestvexa/live', ['packages/live/dist/index.js']],
  ])(
    '%s loads without DOM, frontend frameworks or import side effects',
    async (_name, entries) => {
      const report = await run(entries);
      expect(report.seen.length).toBeGreaterThan(0);
      const offending = report.seen.filter((url) =>
        browserOrFrontend.test(url.replaceAll('\\', '/')),
      );
      expect(offending).toEqual([]);
      expect(report.window).toBe('undefined');
      expect(report.document).toBe('undefined');
      // @nestjs/common loads tslib, whose CommonJS build installs its __helpers
      // as globals; Node lazily creates its undici dispatcher symbol when
      // @nestjs/core touches fetch. reflect-metadata only extends Reflect.
      // Nestvexa itself adds no global.
      expect(
        report.addedGlobals.filter(
          (key) =>
            !/^__[a-zA-Z]+$/.test(key) &&
            !/^Symbol\(undici\.globalDispatcher\.\d+\)$/.test(key),
        ),
      ).toEqual([]);
      expect(report.listenersAfter).toEqual(report.listenersBefore);
      expect(report.handlesAfter).toBe(report.handlesBefore);
    },
    90_000,
  );
  it('keeps the kernel free of Live, template engines and views', async () => {
    const report = await run(['packages/core/dist/index.js']);
    const workspace = report.seen
      .map((url) => url.replaceAll('\\', '/'))
      .filter((url) => /\/packages\/[^/]+\/dist\//.test(url))
      .map((url) => /\/packages\/([^/]+)\/dist\//.exec(url)?.[1]);
    expect(new Set(workspace)).toEqual(new Set(['core']));
    expect(
      report.seen.some((url) => /handlebars|ejs|pug|nunjucks/.test(url)),
    ).toBe(false);
  }, 90_000);
});
