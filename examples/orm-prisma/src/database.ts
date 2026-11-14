import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  DynamicModule,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PrismaClient } from './generated/prisma/client.js';
import type { Note as NoteRow } from './generated/prisma/client.js';
import { NOTES_STORE } from './notes.js';
import type { Note, NotesStore } from './notes.js';

/*
 * Prisma ORM 7 (`@prisma/client`) with the libSQL driver adapter: SQLite with
 * prebuilt binaries and no install scripts. `prisma generate` runs in the
 * build and writes the typed client to src/generated/prisma (git-ignored).
 * The Nest recipe applies: one PrismaClient provider that connects on module
 * init and disconnects on shutdown.
 */

const DATABASE_FILE = Symbol('DATABASE_FILE');
const migrations = fileURLToPath(
  new URL('../prisma/migrations', import.meta.url),
);

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Inject(DATABASE_FILE) file: string) {
    super({ adapter: new PrismaLibSql({ url: pathToFileURL(file).href }) });
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.applyMigrations();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
  /**
   * Demonstration only: a new SQLite file receives the committed migration
   * SQL from prisma/migrations. Deployed databases run `prisma migrate
   * deploy` instead, which also records which migrations were applied.
   */
  private async applyMigrations(): Promise<void> {
    const existing = await this.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'",
    );
    if (existing.length > 0) return;
    for (const directory of (await readdir(migrations)).sort()) {
      if (!/^\d{14}_[a-z0-9_]+$/.test(directory)) continue;
      const sql = await readFile(
        join(migrations, directory, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql.split(';'))
        if (statement.replace(/--.*$/gm, '').trim())
          await this.$executeRawUnsafe(statement);
    }
  }
}

@Injectable()
export class PrismaNotesStore implements NotesStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async list(limit: number): Promise<Note[]> {
    const rows = await this.prisma.note.findMany({
      orderBy: { id: 'desc' },
      take: limit,
    });
    return rows.map(toNote);
  }
  async add(note: { author: string; body: string }): Promise<Note> {
    return toNote(
      await this.prisma.note.create({
        data: { ...note, createdAt: new Date() },
      }),
    );
  }
  count(): Promise<number> {
    return this.prisma.note.count();
  }
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

@Module({})
export class DatabaseModule {
  /** Connects to the database file and prepares the schema before the app starts. */
  static forRoot(options: { file: string }): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE_FILE, useValue: options.file },
        PrismaService,
        { provide: NOTES_STORE, useClass: PrismaNotesStore },
      ],
      exports: [NOTES_STORE],
    };
  }
}
