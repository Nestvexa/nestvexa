import { createApp } from './app.js';
import { port } from './config.js';

const app = await createApp();
await app.listen(port, '127.0.0.1');
console.log(`Multi-tenant example: ${await app.getUrl()}`);
