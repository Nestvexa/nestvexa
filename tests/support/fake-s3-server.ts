/**
 * TEST DOUBLE runner — starts the in-memory S3-compatible server from
 * `fake-s3.ts` as its own process for browser tests of examples/upload-to-s3:
 *
 *   FAKE_S3_PORT=3118 FAKE_S3_CORS_ORIGIN=http://127.0.0.1:3117 \
 *     pnpm exec tsx tests/support/fake-s3-server.ts
 *
 * The credentials below are public test values, not secrets. The listing route
 * `GET /__fake/objects` is unauthenticated and exists only in this double.
 */
import { startFakeS3 } from './fake-s3.js';

const port = Number(process.env['FAKE_S3_PORT'] ?? 3118);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error('FAKE_S3_PORT must be a TCP port');
const fake = await startFakeS3({
  port,
  bucket: process.env['S3_BUCKET'] ?? 'nestvexa-example',
  region: process.env['S3_REGION'] ?? 'us-test-1',
  accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'NESTVEXAEXAMPLEKEY',
  secretAccessKey:
    process.env['S3_SECRET_ACCESS_KEY'] ?? 'nestvexa-example-secret-0123456789',
  inspection: true,
  ...(process.env['FAKE_S3_CORS_ORIGIN']
    ? { cors: process.env['FAKE_S3_CORS_ORIGIN'] }
    : {}),
});
console.log(`Fake S3 test double listening at ${fake.url}`);
const stop = () => void fake.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
