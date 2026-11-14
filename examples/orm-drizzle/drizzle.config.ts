import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` writes SQL migrations for src/schema.ts to ./drizzle.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
});
