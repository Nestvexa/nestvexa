/**
 * `pnpm reset`: deletes the data file and every stored upload in the data
 * directory, deletes the showcase keys in Redis when `REDIS_PORT` is set
 * (only keys under `REDIS_PREFIX`), then writes fresh seed data.
 * S3 objects are not deleted: use a disposable bucket for the showcase.
 */
import { RespConnection } from '@nestvexa/realtime-redis';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory, redis, s3 } from '../config.js';
import { dataFile, writeState } from '../data.js';
import { seedState } from '../seed.js';

rmSync(dataFile, { force: true });
rmSync(join(dataDirectory, 'uploads'), { recursive: true, force: true });
console.log(`Removed data and local uploads in ${dataDirectory}`);

if (redis) {
  const connection = new RespConnection({
    host: redis.host,
    port: redis.port,
    ...(redis.password ? { password: redis.password } : {}),
  });
  try {
    let cursor = '0';
    let removed = 0;
    do {
      // SCAN (never KEYS) so a shared Redis is not blocked.
      const reply = await connection.command(
        'SCAN',
        cursor,
        'MATCH',
        `${redis.prefix}*`,
        'COUNT',
        '200',
      );
      if (
        !Array.isArray(reply) ||
        typeof reply[0] !== 'string' ||
        !Array.isArray(reply[1])
      )
        throw new Error('Unexpected SCAN reply');
      cursor = reply[0];
      const keys = reply[1].filter(
        (key): key is string => typeof key === 'string',
      );
      if (keys.length) {
        await connection.command('DEL', ...keys);
        removed += keys.length;
      }
    } while (cursor !== '0');
    console.log(`Removed ${removed} Redis keys under ${redis.prefix}`);
  } finally {
    await connection.close();
  }
}
if (s3)
  console.log(
    'S3 objects are kept; empty the showcase bucket yourself if needed.',
  );

writeState(seedState());
console.log('Wrote fresh seed data.');
