import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HbsEngine } from '../../packages/engine-hbs/dist/index.js';
import type { LiveRuntimeFactoryOptions } from '../../packages/live/dist/index.js';

/** Shared Express/Fastify harness for Live integration suites (ephemeral ports). */
export const origin = 'http://localhost:3340';
export const csrf = 'live-fixture-csrf-0123456789012345678901234567890';
export type Platform = 'express' | 'fastify';
export const platforms = ['express', 'fastify'] as const;

interface Resource {
  readonly root: string;
  readonly renderer: HbsEngine;
  app?: INestApplication;
}
const resources: Resource[] = [];

export async function cleanup(): Promise<void> {
  for (const resource of resources.splice(0)) {
    await resource.app?.close();
    await resource.renderer.dispose();
    // Only directories created by this fixture under the OS temp root are removed.
    if (
      dirname(resolve(resource.root)) !== resolve(tmpdir()) ||
      !resource.root.includes('nestvexa-live-fixture-')
    )
      throw new Error('Unsafe fixture cleanup path');
    await rm(resource.root, { recursive: true, force: true });
  }
}

/** Writes trusted fixture templates and returns a module exporting the engine. */
export async function renderer(templates: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-live-fixture-'));
  for (const [name, source] of Object.entries(templates))
    await writeFile(join(root, `${name}.hbs`), source);
  const engine = new HbsEngine({ root });
  await engine.initialize();
  const resource: Resource = { root, renderer: engine };
  resources.push(resource);
  @Module({
    providers: [{ provide: HbsEngine, useValue: engine }],
    exports: [HbsEngine],
  })
  class RendererModule {}
  return { engine, module: RendererModule, resource };
}

/** Fixed fixture identity: exercises transport, not production authentication. */
export function policies(
  engine: HbsEngine,
  allow: (component: string, action: string) => boolean = () => true,
  binding = 'live-fixture/session/principal',
): LiveRuntimeFactoryOptions {
  return {
    renderer: engine,
    origin,
    maxRequestsPerMinute: 1_000,
    resolveIdentity: () => ({ binding, csrfToken: csrf }),
    authorize: (_identity, component, action) => allow(component, action),
  };
}

export async function application(
  platform: Platform,
  imports: (DynamicModule | Type<object>)[],
  controllers: Type<object>[],
  resource: Resource,
  configure?: (app: INestApplication) => void,
): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports,
    controllers,
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resource.app = app;
  configure?.(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

export interface Reply {
  readonly status: number;
  readonly body: string;
  json(): Record<string, unknown>;
}
export async function send(
  app: INestApplication,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const base = new URL(await app.getUrl());
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<Reply>((done, reject) => {
    const outgoing = request(
      {
        hostname: base.hostname,
        port: base.port,
        path,
        method: text === undefined ? 'GET' : 'POST',
        headers: {
          ...(text === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(text)),
                origin,
                'x-nestvexa-csrf': csrf,
              }),
          ...headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          done({
            status: incoming.statusCode ?? 0,
            body: raw,
            json() {
              const value: unknown = JSON.parse(raw);
              if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new Error('Expected a JSON object');
              return value as Record<string, unknown>;
            },
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(15_000, () =>
      outgoing.destroy(new Error('Live fixture HTTP timeout')),
    );
    outgoing.end(text);
  });
}

/** The mounted root (or the root of the named component) of an HTML page. */
export function marker(html: string, name?: string) {
  const pattern = name
    ? new RegExp(`<div [^>]*data-nv-name="${name}"[^>]*>`)
    : /<div [^>]*data-nv-component=[^>]*>/;
  const tag = pattern.exec(html)?.[0];
  const snapshot = tag && /data-nv-snapshot="([^"]+)"/.exec(tag)?.[1];
  const revision = tag && /data-nv-revision="(\d+)"/.exec(tag)?.[1];
  if (!snapshot || revision === undefined)
    throw new Error('Missing Live component marker');
  return { snapshot, revision: Number(revision) };
}

export function envelope(
  reference: { snapshot: string; revision: number },
  extra: {
    input?: unknown;
    updates?: Record<string, unknown>;
    requestId?: string;
  } = {},
) {
  return {
    protocol: 'nestvexa-live/1',
    requestId: extra.requestId ?? randomUUID(),
    snapshot: reference.snapshot,
    revision: reference.revision,
    updates: extra.updates ?? {},
    ...(extra.input === undefined ? {} : { input: extra.input }),
  };
}

export function deferred() {
  let release: () => void = () => {
    throw new Error('Missing deferred resolver');
  };
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release: () => release() };
}

/** Resolve when a predicate holds, polling the event loop (bounded). */
export async function until(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
