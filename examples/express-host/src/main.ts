import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureNestvexa } from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { createAppModule } from './app.js';

// Express platform. examples/fastify-host runs the identical src/app.ts on Fastify.
const port = Number(process.env['PORT'] ?? 3120);
// Local demonstration: a per-process secret invalidates guest cookies on restart.
// Production supplies a stable, rotated deployment secret instead.
const secret = process.env['GUEST_COOKIE_SECRET']
  ? Buffer.from(process.env['GUEST_COOKIE_SECRET'], 'utf8')
  : randomBytes(32);

const app = await NestFactory.create<NestExpressApplication>(
  createAppModule({ platform: 'express', port, secret }),
  { logger: ['error', 'warn'] },
);
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Express host: ${await app.getUrl()}`);
