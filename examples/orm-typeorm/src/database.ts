import { Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Repository } from 'typeorm';
import { CreateNotes1794100000000 } from './migrations/1794100000000-create-notes.js';
import { NoteEntity } from './note.entity.js';
import { NOTES_STORE } from './notes.js';
import type { Note, NotesStore } from './notes.js';

/*
 * TypeORM with the `sqljs` driver: SQLite compiled to WebAssembly (sql.js),
 * so there is no native module or install script. `location` + `autoSave`
 * persist the database to a file after every write. The schema comes from a
 * versioned migration run at startup (`synchronize` stays off).
 */

const DATA_SOURCE = Symbol('DATA_SOURCE');

@Injectable()
export class TypeOrmNotesStore implements NotesStore, OnModuleDestroy {
  readonly #notes: Repository<NoteEntity>;
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {
    this.#notes = dataSource.getRepository(NoteEntity);
  }
  async list(limit: number): Promise<Note[]> {
    const rows = await this.#notes.find({ order: { id: 'DESC' }, take: limit });
    return rows.map(toNote);
  }
  async add(note: { author: string; body: string }): Promise<Note> {
    const row = await this.#notes.save(
      this.#notes.create({ ...note, createdAt: new Date() }),
    );
    return toNote(row);
  }
  count(): Promise<number> {
    return this.#notes.count();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}

function toNote(row: NoteEntity): Note {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

@Module({})
export class DatabaseModule {
  /** Opens the database file and applies pending migrations before the app starts. */
  static forRoot(options: { file: string }): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DATA_SOURCE,
          useFactory: () =>
            new DataSource({
              type: 'sqljs',
              location: options.file,
              autoSave: true,
              entities: [NoteEntity],
              migrations: [CreateNotes1794100000000],
              migrationsRun: true,
              synchronize: false,
              logging: false,
            }).initialize(),
        },
        { provide: NOTES_STORE, useClass: TypeOrmNotesStore },
      ],
      exports: [NOTES_STORE],
    };
  }
}
