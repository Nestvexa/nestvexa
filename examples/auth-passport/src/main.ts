import { createApp } from './app.js';

const port = Number(process.env['PORT'] ?? 4023);
const origin = process.env['PUBLIC_ORIGIN'];
const app = await createApp({
  port,
  ...(origin ? { origin } : {}),
  trustProxy: process.env['TRUST_PROXY'] === '1',
});
await app.listen(port, '127.0.0.1');
console.log(`Auth starter: ${await app.getUrl()}`);
