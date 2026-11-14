import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** The Drizzle schema; drizzle-kit generates the SQL migrations in ../drizzle from it. */
export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  author: text('author').notNull(),
  body: text('body').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
