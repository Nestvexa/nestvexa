import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { configureNestvexa } from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { createAppModule } from './app.js';

// Fastify platform. examples/express-host runs the identical src/app.ts on Express.
const port = Number(process.env['PORT'] ?? 3121);
// Local demonstration: a per-process secret invalidates guest cookies on restart.
// Production supplies a stable, rotated deployment secret instead.
const secret = process.env['GUEST_COOKIE_SECRET']
  ? Buffer.from(process.env['GUEST_COOKIE_SECRET'], 'utf8')
  : randomBytes(32);

const app = await NestFactory.create<NestFastifyApplication>(
  createAppModule({ platform: 'fastify', port, secret }),
  new FastifyAdapter(),
  { logger: ['error', 'warn'] },
);
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Fastify host: ${await app.getUrl()}`);
