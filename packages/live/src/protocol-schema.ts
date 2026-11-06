import { LIVE_LIMITS, LIVE_PROTOCOL } from './protocol.js';

/**
 * Published JSON Schemas (draft 2020-12) for `nestvexa-live/1`. They describe
 * the wire contract for non-JavaScript clients, proxies and contract tests;
 * the server itself validates with `parseLiveRequest`, which is stricter
 * (byte/depth/node budgets, canonical tokens, descriptor checks).
 */
type Schema = Readonly<Record<string, unknown>>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const identifier = '^[A-Za-z_$][A-Za-z0-9_$]{0,127}$';
const componentName = '^[a-z][a-z0-9-]{0,63}$';
const snapshotToken = '^[A-Za-z0-9_-]{43}$';
const uuid =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

export const LIVE_REQUEST_SCHEMA: Schema = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nestvexa.dev/schemas/nestvexa-live-1/request.json',
  title: `${LIVE_PROTOCOL} request`,
  description: `POST body for <endpoint>/<component>/<action|_sync>. At most ${LIVE_LIMITS.maxBytes} bytes, ${LIVE_LIMITS.maxDepth} levels and ${LIVE_LIMITS.maxNodes} JSON nodes.`,
  type: 'object',
  additionalProperties: false,
  required: ['protocol', 'requestId', 'snapshot', 'revision', 'updates'],
  properties: {
    protocol: { const: LIVE_PROTOCOL },
    requestId: { type: 'string', pattern: uuid },
    snapshot: { type: 'string', pattern: snapshotToken },
    revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    updates: {
      type: 'object',
      propertyNames: { pattern: identifier },
      description:
        'Top-level writable @State fields; values keep their JSON kind.',
    },
    input: {
      description: 'Action input for @ActionInput; absent or null otherwise.',
    },
  },
});

export const LIVE_RESPONSE_SCHEMA: Schema = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nestvexa.dev/schemas/nestvexa-live-1/response.json',
  title: `${LIVE_PROTOCOL} response`,
  description:
    'Successful action or $sync response (HTTP 201). Clients must ignore unknown optional fields.',
  type: 'object',
  additionalProperties: false,
  required: ['protocol', 'requestId', 'component', 'snapshot', 'state', 'html'],
  properties: {
    protocol: { const: LIVE_PROTOCOL },
    requestId: { type: 'string', pattern: uuid },
    component: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'revision'],
      properties: {
        id: { type: 'string', pattern: uuid },
        name: { type: 'string', pattern: componentName },
        revision: { type: 'integer', minimum: 0 },
      },
    },
    snapshot: { type: 'string', pattern: snapshotToken },
    state: { type: 'object', propertyNames: { pattern: identifier } },
    html: { type: 'string', maxLength: 1_048_576 },
    renderless: { const: true },
    replayed: {
      const: true,
      description:
        'Present when an idempotent action returned the stored result of an earlier identical request.',
    },
    url: { type: 'array', maxItems: 64 },
    events: { type: 'array', maxItems: 16 },
    redirect: { type: 'string', pattern: '^/(?!/)', maxLength: 2048 },
    download: {
      type: 'object',
      additionalProperties: false,
      required: ['url', 'filename'],
      properties: {
        url: { type: 'string', pattern: '/_download/[A-Za-z0-9_-]{43}$' },
        filename: { type: 'string', minLength: 1, maxLength: 180 },
      },
    },
    realtime: { type: 'string', maxLength: 8192 },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description:
        '@Title value after a rendered action; the client sets document.title for top-level components.',
    },
  },
});

export const LIVE_ERROR_SCHEMA: Schema = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nestvexa.dev/schemas/nestvexa-live-1/error.json',
  title: `${LIVE_PROTOCOL} error`,
  description:
    'Error body for Live admission/runtime failures. Application HttpExceptions and exception filters keep their own bodies.',
  type: 'object',
  additionalProperties: false,
  required: ['statusCode', 'code'],
  properties: {
    statusCode: { type: 'integer', minimum: 400, maximum: 599 },
    code: { type: 'string', pattern: '^[A-Z][A-Z_]{1,63}$' },
    correlationId: {
      type: 'string',
      pattern: '^[A-Za-z0-9._:-]{8,128}$',
      description:
        'Added by NestvexaExceptionFilter (@nestvexa/core); equals the x-request-id response header.',
    },
  },
});
