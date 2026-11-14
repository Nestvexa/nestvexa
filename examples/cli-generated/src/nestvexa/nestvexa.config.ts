import { UnauthorizedException } from '@nestjs/common';
import type { ModuleMetadata } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { LiveIdentity } from 'nestvexa';
import { CounterComponent } from './components/counter.component.js';
import { ContactForm } from './forms/contact.form.js';
import { TaskModule } from '../task/task.module.js';
import { TaskTableComponent } from '../task/task-table.component.js';
import { RealtimeService } from '@nestvexa/realtime';

/** Components registered with Nestvexa Live. `nestvexa make:component` appends here. */
export const liveComponents = [
  CounterComponent,
  ContactForm,
  TaskTableComponent,
  // nestvexa:components
];
/** Modules whose providers Live components inject. `nestvexa make:resource` appends here. */
export const liveImports: NonNullable<ModuleMetadata['imports']> = [
  TaskModule,
  // nestvexa:imports
];

/**
 * Host-owned security policy. This starter uses the express-session guest session
 * created in main.ts. Replace it with your authentication, a persistent session
 * store, HTTPS cookies and resource-level authorization before production.
 */
export function liveIdentity(request: object): LiveIdentity {
  const session: unknown = Reflect.get(request, 'session');
  const id: unknown = Reflect.get(request, 'sessionID');
  const csrf: unknown =
    session && typeof session === 'object'
      ? Reflect.get(session, 'csrf')
      : undefined;
  if (typeof id !== 'string' || typeof csrf !== 'string')
    throw new UnauthorizedException();
  return { binding: `session:${id}`, csrfToken: csrf };
}
/** Explicit allowlist: component name → actions (`$mount`, `$sync` and registered actions). */
export const liveActions: Record<string, readonly string[]> = {
  counter: ['$mount', 'increment'],
  'contact-form': ['$mount', '$sync', 'submit'],
  'task-table': ['$mount', '$sync', 'create', 'previous', 'next'],
  // nestvexa:actions
};

/**
 * Session signing secret: SESSION_SECRET (at least 32 characters) is required in
 * production; development falls back to a per-process random secret.
 */
export function sessionSecret(): string {
  const secret = process.env['SESSION_SECRET'];
  if (secret !== undefined && secret.length >= 32) return secret;
  if (process.env['NODE_ENV'] === 'production')
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters in production',
    );
  return randomBytes(48).toString('base64url');
}

export const nestvexaOptions = {
  views: { root: resolve(process.cwd(), 'views'), layout: 'layout' },
  live: { enabled: true },
};
export const nestvexaLive = {
  components: liveComponents,
  imports: liveImports,
  inject: [RealtimeService],
  useFactory: (realtime: RealtimeService) => ({
    origin: process.env['NESTVEXA_ORIGIN'] ?? 'http://localhost:3000',
    resolveIdentity: liveIdentity,
    authorize: (_identity: LiveIdentity, component: string, action: string) =>
      liveActions[component]?.includes(action) ?? false,
    realtime,
  }),
  browser: {
    realtime: { endpoint: '/_nestvexa/realtime' },
    uploads: { endpoint: '/_nestvexa/uploads' },
  },
};
