import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ActionsModule } from '@nestvexa/actions';
import { NestvexaModule, configureNestvexa } from 'nestvexa';
import type { LiveIdentity } from 'nestvexa';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseModule } from './database.js';
import { NoteBoard, NotesActions, PagesController, authorOf } from './notes.js';
import type { SessionRequest } from './notes.js';

/*
 * ORM-neutral bootstrap, byte-identical across the three ORM examples. The
 * database module is the only ORM-specific import.
 */

export interface AppOptions {
  /** Listening port; also fixes the exact Origin accepted by Live and actions. */
  readonly port: number;
  /** SQLite database file (created with its directory when missing). */
  readonly databaseFile: string;
  /** Nest log levels; tests pass `false`. */
  readonly logger?: false | ('error' | 'warn' | 'log')[];
}

const views = fileURLToPath(new URL('../views', import.meta.url));
const liveActions = new Set(['$mount', '$sync', 'add']);

/** The session of a request that has been issued a CSRF token. */
function sessionOf(request: object): SessionRequest | undefined {
  const value = request as Partial<SessionRequest>;
  return value.session?.csrf && value.sessionID
    ? (value as SessionRequest)
    : undefined;
}

function appModule(options: AppOptions): DynamicModule {
  const origin = `http://127.0.0.1:${options.port}`;
  const database = DatabaseModule.forRoot({ file: options.databaseFile });
  @Module({})
  class AppModule {}
  return {
    module: AppModule,
    imports: [
      database,
      NestvexaModule.forRoot(
        { views: { root: views, layout: 'layout' }, live: { enabled: true } },
        {
          components: [NoteBoard],
          imports: [database],
          useFactory: () => ({
            origin,
            maxRequestsPerMinute: 240,
            // Visitor identity bound to the session: a snapshot from one
            // session is refused in any other.
            resolveIdentity: (request: object): LiveIdentity => {
              const value = sessionOf(request);
              if (!value?.session.csrf) throw new Error('Missing session');
              return {
                binding: `${authorOf(value)}:session:${value.sessionID}`,
                csrfToken: value.session.csrf,
              };
            },
            authorize: (_identity, component, action) =>
              component === 'note-board' && liveActions.has(action),
          }),
        },
      ),
      ActionsModule.register({
        groups: [NotesActions],
        imports: [database],
        origin,
        resolveIdentity: (request) => {
          const value = sessionOf(request);
          if (!value?.session.csrf) return null;
          return { subject: authorOf(value), csrfToken: value.session.csrf };
        },
        authorize: (_identity, action) => action.group === 'notes',
      }),
    ],
    controllers: [PagesController],
  };
}

/** Builds the configured application without listening (tests and main.ts). */
export async function createApp(
  options: AppOptions,
): Promise<NestExpressApplication> {
  mkdirSync(dirname(options.databaseFile), { recursive: true });
  const app = await NestFactory.create<NestExpressApplication>(
    appModule(options),
    { logger: options.logger ?? ['error', 'warn'] },
  );
  // Local demonstration: production hosts use a persistent session store, a
  // deployment secret and Secure cookies over HTTPS.
  app.use(
    session({
      name: 'notes.sid',
      secret: randomBytes(48).toString('base64url'),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: false },
    }),
  );
  await configureNestvexa(app);
  app.enableShutdownHooks();
  return app;
}
