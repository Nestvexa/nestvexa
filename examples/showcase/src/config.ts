import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Every setting comes from the environment, is validated once at startup and
 * is never derived from a request. Defaults run the showcase standalone: one
 * process, memory realtime broker, local upload storage, test mail transport.
 */

const env = process.env;

/** The example directory (`examples/showcase`), from the compiled `dist/`. */
export const exampleRoot = fileURLToPath(new URL('..', import.meta.url));

function integer(name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export const port = integer('PORT', 3124, 1, 65_535);
/** Bind address. Containers set `HOST=0.0.0.0`; local runs stay on loopback. */
export const host = env['HOST'] ?? '127.0.0.1';
/** The origin browsers use; Live, actions and uploads check `Origin` against it. */
export const origin = env['PUBLIC_ORIGIN'] ?? `http://127.0.0.1:${port}`;
if (!/^https?:\/\/[^/?#]+$/.test(origin))
  throw new Error(
    'PUBLIC_ORIGIN must be an origin such as https://app.example',
  );
/** Shown in the page footer and `/api/health` so multi-instance runs are visible. */
export const instance = env['SHOWCASE_INSTANCE'] ?? 'standalone';
if (!/^[a-z0-9-]{1,32}$/.test(instance))
  throw new Error('SHOWCASE_INSTANCE must match [a-z0-9-]{1,32}');

/** Seeded JSON data and private uploads (outside any served directory). */
export const dataDirectory = (() => {
  const raw = env['SHOWCASE_DATA_DIR'];
  if (!raw) return join(tmpdir(), `nestvexa-showcase-${port}`);
  return isAbsolute(raw) ? raw : resolve(exampleRoot, raw);
})();

export type MailMode = 'memory' | 'console';
export const mailMode: MailMode = (() => {
  const value = env['MAIL_TRANSPORT'] ?? 'memory';
  if (value !== 'memory' && value !== 'console')
    throw new Error('MAIL_TRANSPORT must be memory or console');
  return value;
})();

export interface RedisSettings {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly prefix: string;
}
/** Redis is optional: set `REDIS_PORT` to share realtime events and metrics. */
export const redis: RedisSettings | undefined = env['REDIS_PORT']
  ? {
      host: env['REDIS_HOST'] ?? '127.0.0.1',
      port: integer('REDIS_PORT', 6379, 1, 65_535),
      ...(env['REDIS_PASSWORD'] ? { password: env['REDIS_PASSWORD'] } : {}),
      prefix: (() => {
        const value = env['REDIS_PREFIX'] ?? 'showcase:';
        if (!/^[a-z0-9:._-]{1,48}$/.test(value))
          throw new Error('REDIS_PREFIX must match [a-z0-9:._-]{1,48}');
        return value;
      })(),
    }
  : undefined;

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}
const s3Variables = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;
/** S3-compatible storage is optional; a partial configuration fails fast. */
export const s3: S3Settings | undefined = (() => {
  const present = s3Variables.filter((name) => env[name]);
  if (present.length === 0) return undefined;
  const missing = s3Variables.filter((name) => !env[name]);
  if (missing.length)
    throw new Error(
      `S3 storage is partially configured. Missing: ${missing.join(', ')}`,
    );
  return {
    endpoint: env['S3_ENDPOINT'] ?? '',
    region: env['S3_REGION'] ?? 'us-east-1',
    bucket: env['S3_BUCKET'] ?? '',
    accessKeyId: env['S3_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: env['S3_SECRET_ACCESS_KEY'] ?? '',
  };
})();

/**
 * Secrets of at least 32 bytes. Without one a random value is generated, which
 * is fine for one process; replicas behind one load balancer must share them.
 */
export function secret(name: string): string {
  const value = env[name];
  if (value !== undefined && value !== '') {
    if (Buffer.byteLength(value) < 32)
      throw new Error(`${name} must be at least 32 bytes`);
    return value;
  }
  return randomBytes(48).toString('base64url');
}

export type SessionStoreMode = 'memory' | 'file';
/**
 * `memory` (default): sessions end when the process stops. `file`: sessions
 * survive a restart of this one process (`<data dir>/sessions.json`).
 */
export const sessionStore: SessionStoreMode = (() => {
  const value = env['SESSION_STORE'] ?? 'memory';
  if (value !== 'memory' && value !== 'file')
    throw new Error('SESSION_STORE must be memory or file');
  return value;
})();
export const sessionFile = join(dataDirectory, 'sessions.json');

/**
 * `SHOWCASE_TEST_FAULTS=1` adds `/__faults/error`, a route that fails on
 * purpose (the browser tests' 500 page). Refused in production.
 */
export const testFaults = env['SHOWCASE_TEST_FAULTS'] === '1';
if (testFaults && env['NODE_ENV'] === 'production')
  throw new Error('SHOWCASE_TEST_FAULTS must not be set in production');
