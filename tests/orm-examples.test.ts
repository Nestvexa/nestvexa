import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp as drizzleApp } from '../examples/orm-drizzle/dist/app.js';
import { createApp as prismaApp } from '../examples/orm-prisma/dist/app.js';
import { createApp as typeormApp } from '../examples/orm-typeorm/dist/app.js';
import {
  ExampleClient,
  liveReference,
  nextReference,
} from './support/example-client.js';

/*
 * DATA-014: the Prisma, TypeORM and Drizzle examples boot in-process against
 * a fresh SQLite file and serve reads and writes through each Nestvexa
 * surface (MVC page, Live component, server action). Ports 4020-4022.
 */

type Factory = typeof drizzleApp;
const examples: readonly (readonly [string, Factory, number])[] = [
  ['orm-prisma', prismaApp, 4020],
  ['orm-typeorm', typeormApp, 4021],
  ['orm-drizzle', drizzleApp, 4022],
];
const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0))
    // SQLite handles close asynchronously on Windows.
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
});

async function boot(factory: Factory, port: number, databaseFile: string) {
  const app = await factory({ port, databaseFile, logger: false });
  await app.listen(port, '127.0.0.1');
  return app;
}

/** The text of every `<li data-note-id>` in the list with this id. */
function listed(html: string, id: string): string[] {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) throw new Error(`Missing #${id}`);
  const section = html.slice(start, html.indexOf('</ul>', start));
  return [...section.matchAll(/<li data-note-id="\d+">([^<]*)<\/li>/g)].map(
    (match) => (match[1] ?? '').trim(),
  );
}

describe.each(examples)(
  '%s example',
  { timeout: 300_000 },
  (name, factory, port) => {
    it('reads and writes through MVC, Live and a server action and persists to SQLite', async () => {
      const directory = await mkdtemp(join(tmpdir(), `nestvexa-${name}-`));
      directories.push(directory);
      const databaseFile = join(directory, 'notes.sqlite');
      const base = `http://127.0.0.1:${port}`;
      let app = await boot(factory, port, databaseFile);
      try {
        const browser = new ExampleClient(base);
        const page = await browser.get('/');
        expect(page.status).toBe(200);
        expect(listed(page.text, 'latest-notes')).toEqual([]);
        let board = liveReference(page.text, 'note-board');

        // Live write: `draft` is a writable state path and `add` persists it.
        const added = await browser.live('note-board', 'add', board, {
          updates: { draft: '  First note from Live  ' },
        });
        expect(added.status, added.text).toBeLessThan(300);
        expect(added.text).toContain('First note from Live');
        expect(added.text).toContain('Note #1 saved.');
        expect(added.text).toContain('1 notes');
        board = nextReference(board, added);

        // Live validation: an empty draft writes nothing.
        const empty = await browser.live('note-board', 'add', board, {
          updates: { draft: '   ' },
        });
        expect(empty.text).toContain('Write something first.');
        board = nextReference(board, empty);

        // Action write and read; the author is the session subject, a
        // client-supplied `author` field is ignored.
        const created = await browser.action(
          'notes/add',
          { body: 'Second note from an action', author: 'mallory' },
          board.csrf,
        );
        expect(created.status, created.text).toBe(200);
        const note = created.json()['data'] as Record<string, unknown>;
        expect(note).toMatchObject({
          id: 2,
          body: 'Second note from an action',
        });
        expect(String(note['author'])).toMatch(/^visitor-[0-9a-f]{8}$/);
        expect(new Date(String(note['createdAt'])).getTime()).toBeGreaterThan(
          0,
        );
        const list = await browser.action('notes/list', undefined, board.csrf);
        expect(list.json()['data']).toMatchObject({
          total: 2,
          notes: [
            { id: 2, body: 'Second note from an action' },
            { id: 1, body: 'First note from Live' },
          ],
        });

        // Negative cases: wrong CSRF token, no Origin, invalid input.
        expect(
          (await browser.action('notes/add', { body: 'x' }, 'x'.repeat(43)))
            .status,
        ).toBe(403);
        expect(
          (
            await browser.request('POST', '/_nestvexa/actions/notes/add', {
              headers: {
                'content-type': 'application/json',
                'x-nestvexa-csrf': board.csrf,
              },
              body: JSON.stringify({ input: { body: 'x' } }),
            })
          ).status,
        ).toBe(403);
        const invalid = await browser.action(
          'notes/add',
          { body: 'x'.repeat(281) },
          board.csrf,
        );
        expect(invalid.status).toBe(400);
        expect(invalid.json()).toMatchObject({
          ok: false,
          error: { code: 'VALIDATION' },
        });
        // Another session cannot replay this session's Live snapshot.
        const stranger = new ExampleClient(base);
        await stranger.get('/');
        const replay = await stranger.live('note-board', 'add', board, {
          updates: { draft: 'replayed' },
        });
        expect(replay.status).toBeGreaterThanOrEqual(400);

        // MVC read: the server-rendered list comes from the same database.
        const reloaded = await browser.get('/');
        expect(listed(reloaded.text, 'latest-notes')).toEqual([
          expect.stringContaining('Second note from an action'),
          expect.stringContaining('First note from Live'),
        ]);
        expect((await browser.get('/api/health')).json()).toEqual({
          status: 'ok',
          notes: 2,
        });

        // The rows are in the SQLite file, not in process memory.
        await app.close();
        app = await boot(factory, port, databaseFile);
        expect(
          (await new ExampleClient(base).get('/api/health')).json(),
        ).toEqual({ status: 'ok', notes: 2 });
      } finally {
        await app.close();
      }
    });
  },
);

describe('ORM examples share Nestvexa code and keep ORMs out of packages', () => {
  const root = new URL('../examples/', import.meta.url);
  const text = async (path: string) =>
    (await readFile(new URL(path, root), 'utf8')).replaceAll('\r\n', '\n');

  it('differ only in the ORM-specific database module', async () => {
    for (const file of [
      'src/app.ts',
      'src/notes.ts',
      'views/layout.hbs',
      'views/home.hbs',
      'views/note-board.hbs',
    ]) {
      const reference = await text(`orm-drizzle/${file}`);
      expect(await text(`orm-prisma/${file}`), file).toBe(reference);
      expect(await text(`orm-typeorm/${file}`), file).toBe(reference);
    }
    for (const [example, orm] of [
      ['orm-prisma', '@prisma/client'],
      ['orm-typeorm', 'typeorm'],
      ['orm-drizzle', 'drizzle-orm'],
    ] as const) {
      expect(await text(`${example}/src/database.ts`)).toContain(
        orm === '@prisma/client' ? './generated/prisma/client.js' : orm,
      );
      expect(await text(`${example}/package.json`)).toContain(`"${orm}"`);
      expect(await text(`${example}/src/notes.ts`)).not.toContain(
        `from '${orm}`,
      );
    }
  });

  it('no package depends on an ORM or a database driver', async () => {
    const orm =
      /^(?:prisma|@prisma\/.+|typeorm|@nestjs\/typeorm|drizzle-orm|drizzle-kit|sequelize|@mikro-orm\/.+|knex|better-sqlite3|sqlite3|sql\.js|@libsql\/.+)$/;
    const packages = new URL('../packages/', import.meta.url);
    for (const entry of await readdir(packages)) {
      const manifest = JSON.parse(
        await readFile(new URL(`${entry}/package.json`, packages), 'utf8'),
      ) as Record<string, Record<string, string> | undefined>;
      const names = [
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
        'devDependencies',
      ].flatMap((field) => Object.keys(manifest[field] ?? {}));
      expect(
        names.filter((dependency) => orm.test(dependency)),
        entry,
      ).toEqual([]);
    }
  });
});
