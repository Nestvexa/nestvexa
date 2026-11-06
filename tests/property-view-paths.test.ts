import fc from 'fast-check';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EjsEngine } from '../packages/engine-ejs/dist/index.js';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { NunjucksEngine } from '../packages/engine-nunjucks/dist/index.js';
import { PugEngine } from '../packages/engine-pug/dist/index.js';
import {
  normalizeViewId,
  resolveTemplateReference,
} from '../packages/views/dist/adapter-kit.js';
import { ViewError } from '../packages/views/dist/index.js';

/**
 * Property-based traversal checks for every first-party view engine. A secret
 * template lives next to (not inside) each engine root and in a sibling
 * directory whose name shares the root's prefix. No view name, partial alias
 * target or template-authored include may ever render it.
 */
const marker = 'SECRET-MARKER';
const runs = { numRuns: 120 };
const segment = fc.oneof(
  fc.constantFrom(
    '..',
    '.',
    '',
    '...',
    '.. ',
    ' ..',
    '..\\',
    '..%2f',
    '%2e%2e',
    '\uff0e\uff0e',
    '\u2025',
    'secret',
    'root-evil',
    'root',
    'page',
    'partials',
    'C:',
    'c:\\',
    '\\\\?\\',
    '\u0000',
    'secret.hbs::$DATA',
    'CON',
    'nul',
    '~',
    'file:',
    // Aborts Node 22/24 on Windows (libuv idna assertion) if it reaches fs.
    String.fromCodePoint(0x10ffff),
    String.fromCodePoint(0xfffe),
    String.fromCharCode(0xd800),
  ),
  fc.stringMatching(/^[a-z]{1,6}$/),
);
const hostileName = fc.oneof(
  fc
    .tuple(
      fc.array(segment, { minLength: 1, maxLength: 6 }),
      fc.constantFrom('/', '\\', '//', '/./'),
      fc.boolean(),
    )
    .map(
      ([parts, separator, leading]) =>
        (leading ? separator : '') + parts.join(separator),
    ),
  fc.string({ unit: 'binary', maxLength: 40 }),
);

let base: string;
const engines: {
  readonly name: string;
  readonly extension: string;
  render(view: string): Promise<string>;
  /** A template-controlled include/partial reference. */
  include(reference: string): Promise<string>;
  dispose(): Promise<void>;
}[] = [];

async function write(file: string, source: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
}
async function attempt(render: () => Promise<string>): Promise<string> {
  try {
    return await render();
  } catch (error) {
    // Rejections must be errors, never silent fallbacks to another file.
    expect(error).toBeInstanceOf(Error);
    return '';
  }
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'nestvexa-view-fuzz-'));
  const sources: Record<string, { page: string; secret: string }> = {
    hbs: { page: 'PAGE-OK', secret: marker },
    ejs: { page: 'PAGE-OK', secret: marker },
    njk: { page: 'PAGE-OK', secret: marker },
    pug: { page: 'p PAGE-OK', secret: `p ${marker}` },
  };
  for (const [extension, source] of Object.entries(sources)) {
    const root = path.join(base, extension, 'root');
    await write(path.join(root, `page.${extension}`), source.page);
    await write(path.join(root, `partials/inc.${extension}`), source.page);
    await write(
      path.join(base, extension, `secret.${extension}`),
      source.secret,
    );
    await write(path.join(base, `secret.${extension}`), source.secret);
    await write(
      path.join(base, extension, `root-evil/secret.${extension}`),
      source.secret,
    );
    await write(path.join(root, '..', 'secret.txt'), marker);
  }
  await write(path.join(base, 'ejs/root/dynamic.ejs'), '<%- include(name) %>');
  await write(path.join(base, 'njk/root/dynamic.njk'), '{% include name %}');
  await write(path.join(base, 'hbs/root/dynamic.hbs'), '{{> target}}');

  const hbs = new HbsEngine({
    root: path.join(base, 'hbs/root'),
    cache: false,
  });
  await hbs.initialize();
  engines.push({
    name: 'hbs',
    extension: 'hbs',
    render: (view) => hbs.render(view, {}, { layout: false }),
    include: (reference) =>
      hbs.render(
        'dynamic',
        {},
        { layout: false, partials: { target: reference } },
      ),
    dispose: () => hbs.dispose(),
  });
  const ejs = new EjsEngine({
    root: path.join(base, 'ejs/root'),
    cache: false,
  });
  await ejs.initialize();
  engines.push({
    name: 'ejs',
    extension: 'ejs',
    render: (view) => ejs.render(view, {}, { layout: false }),
    include: (reference) =>
      ejs.render('dynamic', { name: reference }, { layout: false }),
    dispose: () => ejs.dispose(),
  });
  const njk = new NunjucksEngine({
    root: path.join(base, 'njk/root'),
    cache: false,
  });
  await njk.initialize();
  engines.push({
    name: 'nunjucks',
    extension: 'njk',
    render: (view) => njk.render(view, {}, { layout: false }),
    include: (reference) =>
      njk.render('dynamic', { name: reference }, { layout: false }),
    dispose: () => njk.dispose(),
  });
  const pugRoot = path.join(base, 'pug/root');
  const pugEngine = new PugEngine({ root: pugRoot, cache: false });
  await pugEngine.initialize();
  let counter = 0;
  engines.push({
    name: 'pug',
    extension: 'pug',
    render: (view) => pugEngine.render(view, {}, { layout: false }),
    // Pug includes are static, so each case writes a template that names the reference.
    async include(reference) {
      if (/[\r\n]/.test(reference)) return '';
      const view = `generated-${counter++}`;
      await writeFile(
        path.join(pugRoot, `${view}.pug`),
        `include ${reference}`,
      );
      return pugEngine.render(view, {}, { layout: false });
    },
    dispose: () => pugEngine.dispose(),
  });
});

afterAll(async () => {
  for (const engine of engines) await engine.dispose();
  await rm(base, { recursive: true, force: true });
});

describe('view identifier properties', () => {
  it('accepts only root-relative forward-slash IDs that stay inside any root', () => {
    fc.assert(
      fc.property(hostileName, (view) => {
        let id: string;
        try {
          id = normalizeViewId(view, '.hbs');
        } catch (error) {
          expect(error).toBeInstanceOf(ViewError);
          return;
        }
        expect(id).not.toMatch(/[\\:\p{Cc}]/u);
        expect(id.startsWith('/')).toBe(false);
        expect(id.split('/')).not.toContain('..');
        const root = path.resolve(base, 'root');
        const resolved = path.resolve(root, id);
        expect(resolved.startsWith(root + path.sep)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('resolves template references to IDs that stay inside the root', () => {
    fc.assert(
      fc.property(
        fc.option(fc.stringMatching(/^[a-z]{1,4}(?:\/[a-z]{1,4}){0,3}$/), {
          nil: undefined,
        }),
        hostileName,
        (parent, reference) => {
          let id: string;
          try {
            id = resolveTemplateReference(parent, reference);
          } catch (error) {
            expect(error).toBeInstanceOf(ViewError);
            return;
          }
          const root = path.resolve(base, 'root');
          expect(path.resolve(root, id).startsWith(root + path.sep)).toBe(true);
          expect(id.split('/')).not.toContain('..');
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('engine traversal properties', () => {
  it('regression: EJS include references never reach filesystem existence probes', async () => {
    // EJS's own include probes fs.existsSync with the raw reference before any
    // includer runs: a UNC reference would contact an SMB host on Windows and
    // U+10FFFF aborted the process. The engine now owns `include`.
    const ejs = engines.find((engine) => engine.name === 'ejs');
    if (!ejs) throw new Error('EJS engine missing');
    const probe = vi.spyOn(fs, 'existsSync');
    try {
      for (const reference of [
        '\\\\evil.invalid\\share\\x',
        '//evil.invalid/share/x',
        'C:/Windows/win',
        '../../outside',
        'sub/../../x',
        `partials/inc${String.fromCodePoint(0x10ffff)}`,
      ])
        await expect(ejs.include(reference)).rejects.toThrow();
      expect(probe).not.toHaveBeenCalled();
      expect(await ejs.include('partials/inc')).toContain('PAGE-OK');
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
  });

  it('regression: namespaced and themed EJS includes stay contained without fs probes', async () => {
    const root = path.join(base, 'ejs-scoped', 'root');
    const admin = path.join(base, 'ejs-scoped', 'admin');
    const dark = path.join(base, 'ejs-scoped', 'dark');
    await write(path.join(root, 'page.ejs'), '<%- include(name) %>');
    await write(path.join(root, 'shared.ejs'), 'ROOT-SHARED');
    await write(path.join(admin, 'users/row.ejs'), 'ADMIN-ROW');
    await write(
      path.join(admin, 'users/list.ejs'),
      "<%- include('row') %>|<%- include('/shared') %>",
    );
    await write(path.join(dark, 'shared.ejs'), 'DARK-SHARED');
    await write(path.join(base, 'ejs-scoped', 'secret.ejs'), marker);
    const engine = new EjsEngine({
      root,
      cache: false,
      namespaces: { admin },
      themes: { dark },
    });
    await engine.initialize();
    const probe = vi.spyOn(fs, 'existsSync');
    try {
      const render = (name: string, theme?: string) =>
        engine.render(
          'page',
          { name },
          theme === undefined ? { layout: false } : { layout: false, theme },
        );
      // Namespace references, relative includes inside a namespace and theme overrides.
      expect(await render('admin::users/list')).toBe('ADMIN-ROW|ROOT-SHARED');
      expect(await render('admin::users/list', 'dark')).toBe(
        'ADMIN-ROW|DARK-SHARED',
      );
      for (const reference of [
        'admin::../secret',
        'admin::../../secret',
        'admin::C:/secret',
        'admin::\\\\evil.invalid\\share\\x',
        `admin::users/row${String.fromCodePoint(0x10ffff)}`,
        'unknown::users/row',
        'Admin::users/row',
        '__proto__::x',
      ])
        for (const theme of [undefined, 'dark']) {
          const html = await render(reference, theme).then(
            (value) => value,
            () => '',
          );
          expect(html).not.toContain(marker);
        }
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
      await engine.dispose();
    }
  });

  it('sanity: each engine renders its in-root page and include', async () => {
    for (const engine of engines) {
      expect(await engine.render('page')).toContain('PAGE-OK');
      expect(await engine.include('partials/inc')).toContain('PAGE-OK');
    }
  });

  it('regression: refuses U+10FFFF, noncharacters, surrogates and controls before touching the filesystem', async () => {
    // Before the fix this aborted the whole Windows process (exit 0xC0000409).
    for (const character of [
      String.fromCodePoint(0x10ffff),
      String.fromCodePoint(0x1fffe),
      String.fromCharCode(0xfdd0),
      String.fromCharCode(0xdc00),
      String.fromCharCode(0x85),
      String.fromCharCode(0x1b),
    ]) {
      expect(() => normalizeViewId(`page${character}`, '.ejs')).toThrow(
        ViewError,
      );
      for (const engine of engines) {
        await expect(engine.render(`page${character}`)).rejects.toThrow(
          ViewError,
        );
        await expect(
          engine.include(`partials/inc${character}`),
        ).rejects.toThrow();
      }
    }
    // Ordinary non-ASCII template names remain valid identifiers.
    expect(normalizeViewId('páginas/日本', '.ejs')).toBe('páginas/日本.ejs');
  });

  it('never renders a template outside the root for any view name', async () => {
    await fc.assert(
      fc.asyncProperty(hostileName, async (view) => {
        for (const engine of engines)
          expect(await attempt(() => engine.render(view))).not.toContain(
            marker,
          );
      }),
      runs,
    );
  }, 120_000);

  it('never renders outside the root through partial aliases or includes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          hostileName,
          fc.constantFrom(
            '../secret',
            '../../secret',
            '/../secret',
            '../root-evil/secret',
            '../secret.txt',
            '..\\secret',
            path.join(base, 'secret'),
            path.join(base, 'ejs', 'secret.ejs'),
            `file://${path.join(base, 'secret')}`,
          ),
        ),
        async (reference) => {
          for (const engine of engines)
            expect(
              await attempt(() => engine.include(reference)),
            ).not.toContain(marker);
        },
      ),
      runs,
    );
  }, 120_000);
});
