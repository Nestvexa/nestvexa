// Real external service checks (not part of `pnpm test`): Redis pub/sub across
// two processes and a broker restart, S3-compatible storage and clamd.
// Each section runs only when its environment variables are present; the
// report records exactly which services were exercised. See
// docs/guides/production-services.md for the Docker commands.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { RespRealtimeBroker } from '../packages/realtime/dist/index.js';
import { ClamdScanner, S3Storage } from '../packages/uploads/dist/index.js';

const env = process.env;
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  passed: false,
  services: [],
};
const check = async (name, run) => {
  const entry = { name, passed: false, steps: [] };
  report.services.push(entry);
  try {
    await run((step) => entry.steps.push(step));
    entry.passed = true;
    console.log(`${name}: passed (${entry.steps.length} steps)`);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    console.error(`${name}: FAILED: ${entry.error}`);
  }
};
const waitFor = async (predicate, label, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for ' + label);
};
const text = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

if (env.NESTVEXA_REDIS_PORT)
  await check('redis', async (step) => {
    const port = Number(env.NESTVEXA_REDIS_PORT);
    const prefix = 'nvcheck' + randomBytes(4).toString('hex') + ':';
    // A second OS process subscribes; this process publishes.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { RespRealtimeBroker } from ${JSON.stringify(new URL('../packages/realtime/dist/index.js', import.meta.url).href)};
const broker = new RespRealtimeBroker({ port: ${port}, prefix: ${JSON.stringify(prefix)} });
await broker.subscribe('board:1', (event) => console.log(JSON.stringify(event.data)));
console.log('"ready"');
process.stdin.on('end', () => broker.close().then(() => process.exit(0)));
process.stdin.resume();`,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const lines = [];
    let partial = '';
    child.stdout.on('data', (chunk) => {
      partial += chunk;
      const parts = partial.split('\n');
      partial = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean).map((line) => JSON.parse(line)));
    });
    try {
      await waitFor(() => lines.includes('ready'), 'subscriber process');
      await delay(200);
      const publisher = new RespRealtimeBroker({ port, prefix });
      await publisher.publish('board:1', { revision: 1 });
      await waitFor(
        () => lines.some((line) => line?.revision === 1),
        'cross-process delivery',
      );
      step('cross-process publish delivered to a second Node process');
      if (env.NESTVEXA_REDIS_CONTAINER) {
        const restart = spawnSync(
          'docker',
          ['restart', env.NESTVEXA_REDIS_CONTAINER],
          { encoding: 'utf8', timeout: 60_000 },
        );
        if (restart.status !== 0)
          throw new Error('docker restart failed: ' + restart.stderr);
        // Events published while the subscriber is disconnected are lost by
        // design; after reconnecting, new events must flow again.
        let delivered = false;
        const end = Date.now() + 20_000;
        for (let revision = 2; Date.now() < end && !delivered; revision++) {
          await publisher
            .publish('board:1', { revision })
            .catch(() => undefined);
          await delay(250);
          delivered = lines.some((line) => (line?.revision ?? 0) >= 2);
        }
        if (!delivered) throw new Error('No delivery after broker restart');
        step(
          'subscriber resubscribed and received events after a broker restart',
        );
      }
      await publisher.close();
    } finally {
      child.stdin.end();
      child.kill();
    }
  });

if (env.NESTVEXA_S3_ENDPOINT)
  await check('s3', async (step) => {
    const storage = new S3Storage({
      endpoint: env.NESTVEXA_S3_ENDPOINT,
      region: env.NESTVEXA_S3_REGION ?? 'us-east-1',
      bucket: env.NESTVEXA_S3_BUCKET ?? 'nestvexa-check',
      credentials: {
        accessKeyId: env.NESTVEXA_S3_ACCESS_KEY ?? '',
        secretAccessKey: env.NESTVEXA_S3_SECRET_KEY ?? '',
      },
    });
    const directory = await mkdtemp(join(tmpdir(), 'nestvexa-s3-'));
    try {
      const body = 'hello object storage ' + randomBytes(8).toString('hex');
      const path = join(directory, 'file.txt');
      await writeFile(path, body);
      const key =
        randomBytes(2).toString('base64url').slice(0, 2) +
        '/' +
        randomBytes(32).toString('base64url').slice(0, 43);
      const stored = await storage.put(key, {
        path,
        size: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        contentType: 'text/plain',
      });
      if (stored.size !== Buffer.byteLength(body)) throw new Error('size');
      step('signed PUT');
      if ((await storage.stat(key))?.size !== stored.size)
        throw new Error('stat size mismatch');
      step('signed HEAD');
      if ((await text(await storage.open(key))) !== body)
        throw new Error('GET body mismatch');
      if (
        (await text(await storage.open(key, { start: 0, end: 4 }))) !== 'hello'
      )
        throw new Error('ranged GET mismatch');
      step('signed GET and Range GET');
      const url = await storage.presignDownload(key, {
        filename: 'report.txt',
        contentType: 'text/plain',
      });
      const download = await fetch(url);
      if (!download.ok || (await download.text()) !== body)
        throw new Error('presigned GET failed: ' + download.status);
      if (!/attachment/.test(download.headers.get('content-disposition') ?? ''))
        throw new Error('presigned GET lacks attachment disposition');
      step('presigned GET with attachment disposition');
      const directKey =
        key.slice(0, 3) + randomBytes(32).toString('base64url').slice(0, 43);
      const target = await storage.presignUpload(directKey, {
        contentType: 'text/plain',
        size: 5,
        expiresInSeconds: 60,
      });
      const put = await fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body: 'direct',
      });
      if (put.ok) throw new Error('presigned PUT accepted a wrong length');
      const ok = await fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body: 'bytes',
      });
      if (!ok.ok) throw new Error('presigned PUT failed: ' + ok.status);
      step('presigned PUT enforces the signed length');
      await storage.delete(key);
      await storage.delete(directKey);
      if (await storage.stat(key)) throw new Error('object survived delete');
      step('signed DELETE');
      const forged = new S3Storage({
        endpoint: env.NESTVEXA_S3_ENDPOINT,
        region: env.NESTVEXA_S3_REGION ?? 'us-east-1',
        bucket: env.NESTVEXA_S3_BUCKET ?? 'nestvexa-check',
        credentials: {
          accessKeyId: env.NESTVEXA_S3_ACCESS_KEY ?? '',
          secretAccessKey: 'wrong-secret',
        },
      });
      const accepted = await forged
        .put(key, {
          path,
          size: Buffer.byteLength(body),
          sha256: createHash('sha256').update(body).digest('hex'),
          contentType: 'text/plain',
        })
        .then(
          () => true,
          () => false,
        );
      if (accepted)
        throw new Error('server accepted a request signed with a wrong secret');
      step('request signed with a wrong secret is rejected');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

if (env.NESTVEXA_CLAMD_PORT)
  await check('clamd', async (step) => {
    const scanner = new ClamdScanner({
      host: env.NESTVEXA_CLAMD_HOST ?? '127.0.0.1',
      port: Number(env.NESTVEXA_CLAMD_PORT),
      timeoutMs: 60_000,
    });
    const scan = (bytes) =>
      scanner.scan(
        {
          name: 'file.txt',
          contentType: 'text/plain',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          open: async () => Readable.from([bytes]),
        },
        AbortSignal.timeout(60_000),
      );
    const clean = await scan(Buffer.from('plain business document'));
    if (clean.status !== 'clean')
      throw new Error('clean file: ' + JSON.stringify(clean));
    step('clean file reported clean');
    // The industry-standard EICAR antivirus test string (harmless by design).
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const infected = await scan(eicar);
    if (infected.status !== 'infected')
      throw new Error('EICAR file: ' + JSON.stringify(infected));
    step('EICAR test file reported infected: ' + (infected.signature ?? ''));
  });

report.passed =
  report.services.length > 0 && report.services.every((s) => s.passed);
await mkdir('artifacts/reports', { recursive: true });
await writeFile(
  'artifacts/reports/services.json',
  JSON.stringify(report, null, 2),
);
if (!report.services.length)
  console.error(
    'No service configured: set NESTVEXA_REDIS_PORT, NESTVEXA_S3_ENDPOINT or NESTVEXA_CLAMD_PORT.',
  );
if (!report.passed) process.exitCode = 1;
