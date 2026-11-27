import { expectReply } from './resp.js';
import type {
  RespConnection,
  RespConnectionOptions,
  RespReply,
} from './resp.js';

/**
 * Optimistic transaction on a dedicated connection: WATCH `watch`, let `plan`
 * read current values and return the commands to queue (or null to abort),
 * then MULTI/EXEC. Resolves null when aborted or when a watched key changed
 * before EXEC. I/O failures and error replies reject; callers map them.
 */
export async function atomic(
  connection: RespConnection,
  watch: readonly string[],
  plan: (
    run: (...parts: string[]) => Promise<RespReply>,
  ) => Promise<readonly (readonly string[])[] | null>,
): Promise<RespReply[] | null> {
  return connection.exclusive(async () => {
    const run = async (...parts: string[]) =>
      expectReply(await connection.command(...parts));
    let watching = false;
    let queued = false;
    try {
      if (watch.length) {
        await run('WATCH', ...watch);
        watching = true;
      }
      const commands = await plan(run);
      if (!commands) return null;
      await run('MULTI');
      queued = true;
      for (const parts of commands) await run(...parts);
      const result = await run('EXEC');
      queued = false;
      watching = false;
      return Array.isArray(result) ? result : null;
    } finally {
      // Leave the dedicated connection clean for the next transaction.
      if (queued) await connection.command('DISCARD').catch(() => undefined);
      else if (watching)
        await connection.command('UNWATCH').catch(() => undefined);
    }
  });
}

/** The connection subset of adapter options, without `undefined` members. */
export function connectionOptions(
  options: RespConnectionOptions,
): RespConnectionOptions {
  return {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.username === undefined ? {} : { username: options.username }),
    ...(options.password === undefined ? {} : { password: options.password }),
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.circuitBreaker === undefined
      ? {}
      : { circuitBreaker: options.circuitBreaker }),
  };
}
