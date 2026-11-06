/** JSON-only public state. Dates, BigInt, classes and custom serializers are not supported yet. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const LIVE_PROTOCOL = 'nestvexa-live/1' as const;
/** Request envelope limits enforced before any component code runs. */
export const LIVE_LIMITS = Object.freeze({
  maxBytes: 65_536,
  maxDepth: 16,
  maxNodes: 5_000,
});
/**
 * Optional, versioned behaviours a client may request with the
 * `x-nestvexa-capabilities` header. The protocol major (`nestvexa-live/1`)
 * changes only for incompatible envelopes; additive behaviour is negotiated
 * per request through these tokens and never changes the default response.
 */
export const LIVE_CAPABILITIES = Object.freeze(['renderless-v1'] as const);
export type LiveCapability = (typeof LIVE_CAPABILITIES)[number];
const capabilityToken = /^[a-z][a-z0-9-]{0,47}-v[1-9][0-9]{0,2}$/;

/** Safe protocol diagnostics: never embed tokens, state, bindings or thrown action details. */
export class LiveProtocolError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LiveProtocolError';
  }
}

export interface LiveRequest {
  readonly protocol: typeof LIVE_PROTOCOL;
  readonly requestId: string;
  readonly snapshot: string;
  readonly revision: number;
  readonly updates: Readonly<Record<string, JsonValue>>;
  readonly input?: JsonValue;
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(message = 'Invalid Live request'): never {
  throw new LiveProtocolError('INVALID_REQUEST', 400, message);
}
function oversized(): never {
  throw new LiveProtocolError(
    'PAYLOAD_TOO_LARGE',
    413,
    'Live payload exceeds structural or byte limits',
  );
}
interface Budget {
  bytes: number;
  nodes: number;
  active: Set<object>;
}
function addBytes(budget: Budget, count: number): void {
  budget.bytes += count;
  if (budget.bytes > LIVE_LIMITS.maxBytes) oversized();
}
function jsonString(value: string, budget: Budget): void {
  if (value.length > LIVE_LIMITS.maxBytes) oversized();
  addBytes(budget, Buffer.byteLength(JSON.stringify(value), 'utf8'));
}

/** Descriptor inspection prevents getters/toJSON from executing during validation. */
function copy(value: unknown, budget: Budget, depth: number): JsonValue {
  if (++budget.nodes > LIVE_LIMITS.maxNodes || depth > LIVE_LIMITS.maxDepth)
    oversized();
  if (value === null || typeof value === 'boolean') {
    addBytes(budget, value === null ? 4 : value ? 4 : 5);
    return value;
  }
  if (typeof value === 'string') {
    jsonString(value, budget);
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    addBytes(budget, JSON.stringify(value).length);
    return value;
  }
  if (typeof value !== 'object')
    invalid('Live values must be finite JSON data');
  if (budget.active.has(value)) invalid('Cyclic Live data is not supported');
  const isArray = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    isArray
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    invalid('Live values must be plain JSON data');
  const keys = Reflect.ownKeys(value);
  if (keys.length > LIVE_LIMITS.maxNodes + (isArray ? 1 : 0)) oversized();
  budget.active.add(value);
  addBytes(budget, 2);
  if (isArray) {
    if (value.length > LIVE_LIMITS.maxNodes || keys.length !== value.length + 1)
      invalid('Sparse or augmented Live arrays are unsupported');
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        invalid('Live array entries must be own data properties');
      if (index > 0) addBytes(budget, 1);
      result.push(copy(descriptor.value, budget, depth + 1));
    }
    budget.active.delete(value);
    return result;
  }
  const result = Object.create(null) as Record<string, JsonValue>;
  let index = 0;
  for (const key of keys) {
    if (typeof key !== 'string' || forbidden.has(key))
      invalid('Unsafe Live data property');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      invalid('Live properties must be enumerable data');
    if (index++ > 0) addBytes(budget, 1);
    jsonString(key, budget);
    addBytes(budget, 1);
    result[key] = copy(descriptor.value, budget, depth + 1);
  }
  budget.active.delete(value);
  return result;
}

/** Clone and validate a public state object; the returned clone is mutable and detached. */
export function cloneState(input: unknown): Record<string, JsonValue> {
  const result = copy(input, { bytes: 0, nodes: 0, active: new Set() }, 0);
  if (result === null || typeof result !== 'object' || Array.isArray(result))
    invalid('Live state must be an object');
  return result;
}

/** Deep freeze validated JSON without getters or cycles. */
export function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeJson(nested);
    Object.freeze(value);
  }
  return value;
}

/** Canonical unpadded base64url encoding of exactly 32 bytes. */
export function isSnapshotToken(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
    return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value;
}

/** Strict envelope parser; middleware must enforce the same byte limit before JSON parsing. */
export function parseLiveRequest(input: unknown): LiveRequest {
  const object = cloneState(input);
  const required = ['protocol', 'requestId', 'snapshot', 'revision', 'updates'];
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some(
      (key) => !required.includes(key) && key !== 'input',
    )
  )
    invalid();
  if (object['protocol'] !== LIVE_PROTOCOL)
    throw new LiveProtocolError(
      'UNSUPPORTED_PROTOCOL',
      426,
      'Unsupported Live protocol; reload the page',
    );
  const requestId = object['requestId'];
  const snapshot = object['snapshot'];
  const revision = object['revision'];
  const updates = object['updates'];
  if (
    typeof requestId !== 'string' ||
    !uuid.test(requestId) ||
    !isSnapshotToken(snapshot)
  )
    invalid();
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    invalid();
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates))
    invalid('Live updates must be an object');
  if (
    Object.keys(updates).some(
      (key) => !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(key),
    )
  )
    invalid('Live updates must name top-level state fields');
  const request: LiveRequest = {
    protocol: LIVE_PROTOCOL,
    requestId,
    snapshot,
    revision,
    updates: freezeJson(updates),
    ...(Object.hasOwn(object, 'input')
      ? { input: freezeJson(object['input'] as JsonValue) }
      : {}),
  };
  return Object.freeze(request);
}

/**
 * Parse a comma-separated capability header. Absent or empty means none.
 * Well-formed tokens this server does not implement are ignored so newer
 * clients keep working against older servers; malformed or oversized headers
 * are rejected with 400 `INVALID_CAPABILITIES` before any component runs.
 */
export function parseLiveCapabilities(
  header: unknown,
): ReadonlySet<LiveCapability> {
  const accepted = new Set<LiveCapability>();
  if (header === undefined || header === '') return accepted;
  if (typeof header !== 'string' || header.length > 512)
    throw new LiveProtocolError(
      'INVALID_CAPABILITIES',
      400,
      'Invalid Live capability header',
    );
  const tokens = header.split(',').map((token) => token.trim());
  if (
    tokens.length > 16 ||
    tokens.some((token) => !capabilityToken.test(token))
  )
    throw new LiveProtocolError(
      'INVALID_CAPABILITIES',
      400,
      'Invalid Live capability header',
    );
  const known: readonly string[] = LIVE_CAPABILITIES;
  for (const token of tokens)
    if (known.includes(token)) accepted.add(token as LiveCapability);
  return accepted;
}
