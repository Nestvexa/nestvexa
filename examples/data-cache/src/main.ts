import { fileURLToPath } from 'node:url';
import { createDataCacheApp } from './app.js';

const port = Number(process.env['PORT'] ?? 4000);
const databasePath =
  process.env['LIVE_DATABASE'] ??
  fileURLToPath(new URL('../live-state.db', import.meta.url));
const { app } = await createDataCacheApp({
  port,
  databasePath,
  assetVersion: process.env['ASSET_VERSION'] ?? 'dev',
});
await app.listen(port, '127.0.0.1');
console.log(`Data cache example: ${await app.getUrl()}`);
