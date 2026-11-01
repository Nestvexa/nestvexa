import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for S3-compatible object storage, implemented with
 * node:crypto so default installs need no cloud SDK. Paths use S3 rules: each
 * segment is URI-encoded once and not normalized.
 */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}
export interface SignatureScope {
  readonly credentials: AwsCredentials;
  readonly region: string;
  readonly service: string;
  readonly date: Date;
}
export interface SignRequestOptions extends SignatureScope {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign. `host` is added from the URL when absent. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
}
export interface PresignOptions extends SignatureScope {
  readonly method: string;
  readonly url: URL;
  readonly expiresInSeconds: number;
  /** Extra headers the client must send (for example content-type, content-length). */
  readonly headers?: Readonly<Record<string, string>>;
}

export const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}
/** RFC 3986 encoding as specified by SigV4: only A-Z a-z 0-9 - _ . ~ stay literal. */
export function uriEncode(value: string, encodeSlash = true): string {
  let result = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    if (
      /[A-Za-z0-9\-_.~]/.test(character) ||
      (!encodeSlash && character === '/')
    )
      result += character;
    else result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return result;
}
export function amzDate(date: Date): {
  readonly stamp: string;
  readonly day: string;
} {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()))
    throw new Error('Invalid signing date');
  const stamp = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { stamp, day: stamp.slice(0, 8) };
}
function canonicalPath(url: URL): string {
  // URL.pathname is already percent-encoded by WHATWG rules; decode then
  // re-encode each segment with the stricter SigV4 alphabet.
  const path = url.pathname || '/';
  return path
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/');
}
function canonicalQuery(
  url: URL,
  extra: readonly (readonly [string, string])[] = [],
): string {
  const pairs: [string, string][] = [];
  // Parse the raw query: URLSearchParams turns '+' into spaces, which S3 does not.
  const raw = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (raw)
    for (const part of raw.split('&')) {
      if (!part) continue;
      const index = part.indexOf('=');
      const key = index < 0 ? part : part.slice(0, index);
      const value = index < 0 ? '' : part.slice(index + 1);
      pairs.push([
        uriEncode(decodeURIComponent(key)),
        uriEncode(decodeURIComponent(value)),
      ]);
    }
  for (const [key, value] of extra)
    pairs.push([uriEncode(key), uriEncode(value)]);
  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey < rightKey
      ? -1
      : leftKey > rightKey
        ? 1
        : leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0,
  );
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}
function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  readonly canonical: string;
  readonly signed: string;
} {
  const entries = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase().trim();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n]/.test(value))
      throw new Error('Invalid header for signing');
    const normalized = String(value).trim().replace(/\s+/g, ' ');
    entries.set(
      key,
      entries.has(key) ? `${entries.get(key) ?? ''},${normalized}` : normalized,
    );
  }
  const names = [...entries.keys()].sort();
  return {
    canonical: names
      .map((name) => `${name}:${entries.get(name) ?? ''}\n`)
      .join(''),
    signed: names.join(';'),
  };
}
export function credentialScope(
  day: string,
  region: string,
  service: string,
): string {
  return `${day}/${region}/${service}/aws4_request`;
}
export function signingKey(
  secretAccessKey: string,
  day: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, day);
  return hmac(hmac(hmac(dateKey, region), service), 'aws4_request');
}
function validateScope(scope: SignatureScope): void {
  const { credentials, region, service } = scope;
  if (
    !credentials ||
    typeof credentials.accessKeyId !== 'string' ||
    !/^[A-Za-z0-9+/=_-]{1,256}$/.test(credentials.accessKeyId) ||
    typeof credentials.secretAccessKey !== 'string' ||
    credentials.secretAccessKey.length < 1 ||
    (credentials.sessionToken !== undefined &&
      typeof credentials.sessionToken !== 'string') ||
    typeof region !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(region) ||
    typeof service !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(service)
  )
    throw new Error('Invalid SigV4 credentials or scope');
}

/** Build the canonical request string (exported for test-vector verification). */
export function canonicalRequest(
  method: string,
  url: URL,
  headers: Readonly<Record<string, string>>,
  payloadHash: string,
  extraQuery: readonly (readonly [string, string])[] = [],
): { readonly text: string; readonly signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(headers);
  return {
    text: [
      method.toUpperCase(),
      canonicalPath(url),
      canonicalQuery(url, extraQuery),
      canonical,
      signed,
      payloadHash,
    ].join('\n'),
    signedHeaders: signed,
  };
}

function withHost(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = { ...headers };
  if (!Object.keys(result).some((name) => name.toLowerCase() === 'host'))
    result['host'] = url.host;
  return result;
}

/** Sign a request with an Authorization header. Returns all headers to send. */
export function signRequest(
  options: SignRequestOptions,
): Record<string, string> {
  validateScope(options);
  const { stamp, day } = amzDate(options.date);
  const headers = withHost(options.url, options.headers);
  headers['x-amz-date'] = stamp;
  if (options.service === 's3')
    headers['x-amz-content-sha256'] = options.payloadHash;
  if (options.credentials.sessionToken)
    headers['x-amz-security-token'] = options.credentials.sessionToken;
  const request = canonicalRequest(
    options.method,
    options.url,
    headers,
    options.payloadHash,
  );
  const scope = credentialScope(day, options.region, options.service);
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    sha256Hex(request.text),
  ].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(
      options.credentials.secretAccessKey,
      day,
      options.region,
      options.service,
    ),
  )
    .update(toSign, 'utf8')
    .digest('hex');
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${request.signedHeaders}, Signature=${signature}`;
  return headers;
}

/** Create a query-string presigned URL (UNSIGNED-PAYLOAD), max 7 days. */
export function presignUrl(options: PresignOptions): URL {
  validateScope(options);
  if (
    !Number.isSafeInteger(options.expiresInSeconds) ||
    options.expiresInSeconds < 1 ||
    options.expiresInSeconds > 604_800
  )
    throw new Error('Presigned URL lifetime must be 1–604800 seconds');
  const { stamp, day } = amzDate(options.date);
  const headers = withHost(options.url, options.headers ?? {});
  const scope = credentialScope(day, options.region, options.service);
  const { signed } = canonicalHeaders(headers);
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${options.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(options.expiresInSeconds)],
    ...(options.credentials.sessionToken
      ? ([['X-Amz-Security-Token', options.credentials.sessionToken]] as [
          string,
          string,
        ][])
      : []),
    ['X-Amz-SignedHeaders', signed],
  ];
  const request = canonicalRequest(
    options.method,
    options.url,
    headers,
    UNSIGNED_PAYLOAD,
    query,
  );
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    sha256Hex(request.text),
  ].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(
      options.credentials.secretAccessKey,
      day,
      options.region,
      options.service,
    ),
  )
    .update(toSign, 'utf8')
    .digest('hex');
  const result = new URL(options.url.href);
  const existing = result.search.startsWith('?') ? result.search.slice(1) : '';
  const appended = [
    ...query,
    ['X-Amz-Signature', signature] as [string, string],
  ]
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&');
  result.search = existing ? `${existing}&${appended}` : appended;
  return result;
}
