import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const port = Number(process.env['PORT'] ?? 4021);
// One SQLite file per example; DATABASE_FILE overrides it.
const databaseFile =
  process.env['DATABASE_FILE'] ??
  fileURLToPath(new URL('../data/notes.sqlite', import.meta.url));

const app = await createApp({ port, databaseFile });
await app.listen(port, '127.0.0.1');
console.log(`Notes example: ${await app.getUrl()}`);
