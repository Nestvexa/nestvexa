import { S3Storage } from '@nestvexa/uploads';

/** Storage settings come only from the environment, never from requests. */
export interface S3Settings {
  readonly endpoint: string;
  readonly origin: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string | undefined;
  readonly storage: S3Storage;
}

const required = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

/**
 * Read and validate the S3-compatible storage configuration. Fails before the
 * server listens, naming every missing variable but never printing a value.
 */
export function readS3Settings(
  environment: NodeJS.ProcessEnv = process.env,
): S3Settings {
  const missing = required.filter((name) => !environment[name]);
  if (missing.length)
    throw new Error(
      `upload-to-s3 needs S3-compatible storage settings. Missing: ${missing.join(', ')}. See examples/upload-to-s3/README.md.`,
    );
  const value = (name: (typeof required)[number]): string =>
    environment[name] ?? '';
  const endpoint = value('S3_ENDPOINT');
  const prefix = environment['S3_PREFIX'] || undefined;
  // S3Storage rejects endpoints with credentials, paths or queries, unsafe
  // bucket names and prefixes, so a bad setting also fails here.
  const storage = new S3Storage({
    endpoint,
    region: value('S3_REGION'),
    bucket: value('S3_BUCKET'),
    credentials: {
      accessKeyId: value('S3_ACCESS_KEY_ID'),
      secretAccessKey: value('S3_SECRET_ACCESS_KEY'),
    },
    ...(prefix === undefined ? {} : { prefix }),
  });
  return {
    endpoint,
    origin: new URL(endpoint).origin,
    region: value('S3_REGION'),
    bucket: value('S3_BUCKET'),
    prefix,
    storage,
  };
}
