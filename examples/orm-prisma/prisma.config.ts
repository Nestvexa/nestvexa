import { defineConfig } from 'prisma/config';

// Prisma CLI configuration. `prisma generate` needs no database; the
// migrate commands read DATABASE_URL (for example file:./data/notes.sqlite).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env['DATABASE_URL'] ?? 'file:./data/notes.sqlite',
  },
});
