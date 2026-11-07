import { HttpException } from '@nestjs/common';
import fc from 'fast-check';
import { propertyRuns } from './support/property-runs.js';
import { describe, expect, it } from 'vitest';
import {
  cloneState,
  isSnapshotToken,
  LIVE_LIMITS,
  LIVE_PROTOCOL,
  LiveProtocolError,
  parseLiveRequest,
  type JsonValue,
} from '../packages/live/src/protocol.js';
import { parseTextStreamRequest } from '../packages/live/src/text-stream.js';
import {
  beginEffects,
  downloadLive,
  safeFilename,
  takeEffects,
} from '../packages/live/src/effects.js';

/**
 * Property-based checks for the Live request trust boundary. Every generated
 * value is attacker-controlled JSON (or a hostile in-process object), so the
 * parser must either return a detached frozen copy or throw a protocol error.
 */
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const runs = propertyRuns(300);

const fieldName = fc.stringMatching(/^[A-Za-z_$][A-Za-z0-9_$]{0,20}$/);
const token = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('base64url'));
const requestId = fc.uuid({ version: [1, 2, 3, 4, 5, 6, 7, 8] });
const json = fc.jsonValue({ maxDepth: 5, stringUnit: 'binary' });

function hasForbiddenKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  return Object.keys(value).some(
    (key) =>
      forbidden.has(key) ||
      hasForbiddenKey((value as Record<string, unknown>)[key]),
  );
}
/** Independent reference model of the documented structural limits. */
function measure(value: unknown, depth = 0): { nodes: number; depth: number } {
  if (value === null || typeof value !== 'object') return { nodes: 1, depth };
  const children = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  let nodes = 1;
  let deepest = depth;
  for (const child of children) {
    const nested = measure(child, depth + 1);
    nodes += nested.nodes;
    deepest = Math.max(deepest, nested.depth);
  }
  return { nodes, depth: deepest };
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function outcome(operation: () => unknown): string {
  try {
    operation();
    return 'ok';
  } catch (error) {
    if (!(error instanceof LiveProtocolError)) throw error;
    return error.code;
  }
}
function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return (
    Object.isFrozen(value) &&
    Object.values(value as Record<string, unknown>).every(deepFrozen)
  );
}

describe('Live envelope parser properties', () => {
  it('accepts every well-formed envelope and returns an equal, frozen, detached copy', () => {
    fc.assert(
      fc.property(
        requestId,
        token,
        fc.nat(),
        fc.dictionary(fieldName, json, { maxKeys: 8 }),
        fc.option(json, { nil: undefined }),
        (id, snapshot, revision, updates, input) => {
          fc.pre(!hasForbiddenKey(updates) && !hasForbiddenKey(input));
          const envelope = {
            protocol: LIVE_PROTOCOL,
            requestId: id,
            snapshot,
            revision,
            updates,
            ...(input === undefined ? {} : { input }),
          };
          fc.pre(
            bytes(envelope) <= LIVE_LIMITS.maxBytes &&
              measure(envelope).nodes <= LIVE_LIMITS.maxNodes,
          );
          const wire = JSON.parse(JSON.stringify(envelope)) as unknown;
          const parsed = parseLiveRequest(wire);
          expect(JSON.parse(JSON.stringify(parsed))).toEqual(wire);
          expect(deepFrozen(parsed)).toBe(true);
          // Mutating the source after parsing never reaches the parsed copy.
          (wire as { updates: Record<string, unknown> }).updates['injected'] =
            1;
          expect(Object.hasOwn(parsed.updates, 'injected')).toBe(false);
          expect(Object.getPrototypeOf(parsed.updates)).toBe(null);
        },
      ),
      runs,
    );
  });

  it('throws only LiveProtocolError for arbitrary hostile values', () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withBoxedValues: true,
          withDate: true,
          withMap: true,
          withNullPrototype: true,
          withObjectString: true,
          withSet: true,
          withSparseArray: true,
          withTypedArray: true,
          withUnicodeString: true,
        }),
        (value) => {
          expect(['ok', 'INVALID_REQUEST', 'PAYLOAD_TOO_LARGE']).toContain(
            outcome(() => cloneState(value)),
          );
          expect(outcome(() => parseLiveRequest(value))).not.toBe('ok');
        },
      ),
      runs,
    );
  });

  it('rejects any mutation of a single envelope field to an arbitrary value', () => {
    const valid = {
      protocol: LIVE_PROTOCOL,
      requestId: 'd85e7c20-72ac-4e71-8baf-210dbe79e912',
      snapshot: Buffer.alloc(32, 7).toString('base64url'),
      revision: 0,
      updates: {},
    };
    fc.assert(
      fc.property(
        fc.constantFrom('protocol', 'requestId', 'snapshot', 'revision'),
        fc.oneof(
          fc.anything(),
          fc.string({ unit: 'binary' }),
          fc.double(),
          fc.integer({ max: -1 }),
        ),
        (field, replacement) => {
          fc.pre(
            !(field === 'revision' && Number.isSafeInteger(replacement)) ||
              (typeof replacement === 'number' && replacement < 0),
          );
          fc.pre(
            !(field === 'requestId' || field === 'snapshot') ||
              typeof replacement !== 'string' ||
              (field === 'snapshot'
                ? !isSnapshotToken(replacement)
                : !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    replacement,
                  )),
          );
          fc.pre(field !== 'protocol' || replacement !== LIVE_PROTOCOL);
          const code = outcome(() =>
            parseLiveRequest({ ...valid, [field]: replacement }),
          );
          expect(['INVALID_REQUEST', 'UNSUPPORTED_PROTOCOL']).toContain(code);
        },
      ),
      runs,
    );
  });

  it('rejects unknown top-level keys and non-identifier update names', () => {
    const valid = {
      protocol: LIVE_PROTOCOL,
      requestId: 'd85e7c20-72ac-4e71-8baf-210dbe79e912',
      snapshot: Buffer.alloc(32, 7).toString('base64url'),
      revision: 0,
      updates: {},
    };
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', minLength: 1, maxLength: 40 }),
        (key) => {
          fc.pre(!forbidden.has(key));
          if (!Object.hasOwn(valid, key) && key !== 'input')
            expect(
              outcome(() => parseLiveRequest({ ...valid, [key]: 1 })),
            ).toBe('INVALID_REQUEST');
          const update = outcome(() =>
            parseLiveRequest({ ...valid, updates: { [key]: 1 } }),
          );
          expect(update).toBe(
            /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(key)
              ? 'ok'
              : 'INVALID_REQUEST',
          );
        },
      ),
      runs,
    );
  });

  it('rejects prototype keys at any depth of updates or input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...forbidden),
        fc.array(fc.oneof(fieldName, fc.nat({ max: 3 })), { maxLength: 6 }),
        fc.boolean(),
        (key, path, inInput) => {
          // JSON.parse creates an own `__proto__` property exactly like a request body parser.
          let nested = `{${JSON.stringify(key)}:{"polluted":true}}`;
          for (const segment of [...path].reverse())
            nested =
              typeof segment === 'number'
                ? `[${'0,'.repeat(segment)}${nested}]`
                : `{${JSON.stringify(segment)}:${nested}}`;
          const body = `{"protocol":"${LIVE_PROTOCOL}","requestId":"d85e7c20-72ac-4e71-8baf-210dbe79e912","snapshot":"${Buffer.alloc(32, 7).toString('base64url')}","revision":0,${
            inInput
              ? `"updates":{},"input":${nested}`
              : `"updates":{"a":${nested}}`
          }}`;
          expect(outcome(() => parseLiveRequest(JSON.parse(body)))).toBe(
            'INVALID_REQUEST',
          );
          expect(
            (Object.prototype as Record<string, unknown>)['polluted'],
          ).toBeUndefined();
        },
      ),
      runs,
    );
  });

  it('never evaluates getters, toJSON or proxies-like accessors while validating', () => {
    fc.assert(
      fc.property(
        fc.array(fieldName, { minLength: 1, maxLength: 5 }),
        (path) => {
          let evaluated = false;
          const root: Record<string, unknown> = {};
          let cursor = root;
          for (const segment of path.slice(0, -1)) {
            const next: Record<string, unknown> = {};
            cursor[segment] = next;
            cursor = next;
          }
          Object.defineProperty(cursor, path.at(-1) ?? 'x', {
            enumerable: true,
            get() {
              evaluated = true;
              return 1;
            },
          });
          expect(outcome(() => cloneState(root))).toBe('INVALID_REQUEST');
          expect(evaluated).toBe(false);
        },
      ),
      runs,
    );
  });
});

describe('Live structural budget properties', () => {
  it('matches the reference model of bytes, nodes and depth exactly at the byte boundary', () => {
    fc.assert(
      fc.property(
        fc.jsonValue({ maxDepth: 6, stringUnit: 'binary' }),
        fc.integer({ min: -3, max: 3 }),
        (value, delta) => {
          fc.pre(!hasForbiddenKey(value));
          // {"p":"<pad>","v":<value>} has exactly 13 bytes of framing.
          const pad = LIVE_LIMITS.maxBytes - bytes(value) - 13 + delta;
          fc.pre(pad >= 0);
          const candidate = { p: 'x'.repeat(pad), v: value };
          expect(bytes(candidate)).toBe(LIVE_LIMITS.maxBytes + delta);
          const shape = measure(candidate);
          const expected =
            delta <= 0 &&
            shape.nodes <= LIVE_LIMITS.maxNodes &&
            shape.depth <= LIVE_LIMITS.maxDepth
              ? 'ok'
              : 'PAYLOAD_TOO_LARGE';
          expect(outcome(() => cloneState(candidate))).toBe(expected);
        },
      ),
      propertyRuns(200),
    );
  });

  it('enforces nesting depth and node counts independently of byte size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.boolean(),
        (depth, arrays) => {
          let value: JsonValue = 0;
          for (let level = 0; level < depth; level++)
            value = arrays ? [value] : { k: value };
          const state = { v: value };
          // Root object is depth 0; the leaf sits at depth + 1.
          expect(outcome(() => cloneState(state))).toBe(
            depth + 1 <= LIVE_LIMITS.maxDepth ? 'ok' : 'PAYLOAD_TOO_LARGE',
          );
        },
      ),
    );
    fc.assert(
      fc.property(fc.integer({ min: 4_900, max: 5_100 }), (count) => {
        const state = { list: Array.from({ length: count - 2 }, () => 0) };
        expect(outcome(() => cloneState(state))).toBe(
          count <= LIVE_LIMITS.maxNodes ? 'ok' : 'PAYLOAD_TOO_LARGE',
        );
      }),
      propertyRuns(50),
    );
  });

  it('round-trips arbitrary JSON state through the JSON wire unchanged', () => {
    fc.assert(
      fc.property(fc.dictionary(fieldName, json, { maxKeys: 10 }), (state) => {
        fc.pre(!hasForbiddenKey(state));
        fc.pre(bytes(state) <= LIVE_LIMITS.maxBytes);
        const clone = cloneState(JSON.parse(JSON.stringify(state)));
        expect(JSON.stringify(clone)).toBe(JSON.stringify(state));
      }),
      runs,
    );
  });
});

describe('Snapshot token properties', () => {
  it('accepts exactly the canonical unpadded base64url encodings of 32 bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (raw) => {
        expect(isSnapshotToken(Buffer.from(raw).toString('base64url'))).toBe(
          true,
        );
      }),
      runs,
    );
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (value) => {
        if (isSnapshotToken(value)) {
          const decoded = Buffer.from(value, 'base64url');
          expect(decoded).toHaveLength(32);
          expect(decoded.toString('base64url')).toBe(value);
        }
      }),
      runs,
    );
  });

  it('rejects alternate spellings of the final character and other lengths', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 31 }),
        (raw, unusedBits, other) => {
          const canonical = Buffer.from(raw).toString('base64url');
          const alphabet =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
          const last = alphabet.indexOf(canonical.at(-1) ?? 'A');
          // 256 bits in 43 sextets leave the two low bits of the last one unused.
          const spelled =
            canonical.slice(0, -1) + (alphabet[last ^ unusedBits] ?? 'A');
          expect(isSnapshotToken(spelled)).toBe(false);
          const resized = Buffer.from(raw.subarray(0, other)).toString(
            'base64url',
          );
          expect(isSnapshotToken(resized)).toBe(false);
          expect(isSnapshotToken(`${canonical}=`)).toBe(false);
        },
      ),
      runs,
    );
  });
});

describe('Text stream request parser properties', () => {
  it('rejects arbitrary values with a 400 HttpException only', () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true }), (value) => {
        try {
          parseTextStreamRequest(value);
        } catch (error) {
          expect(error).toBeInstanceOf(HttpException);
          expect((error as HttpException).getStatus()).toBe(400);
        }
      }),
      runs,
    );
  });

  it('accepts valid stream envelopes and rejects any extra key', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
        token,
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 12 }),
        (id, snapshot, revision, extra) => {
          const request = {
            protocol: 'nestvexa-stream/1',
            requestId: id,
            snapshot,
            revision,
          };
          expect(
            parseTextStreamRequest(JSON.parse(JSON.stringify(request))),
          ).toEqual(request);
          fc.pre(!Object.hasOwn(request, extra));
          expect(() =>
            parseTextStreamRequest({ ...request, [extra]: 1 }),
          ).toThrow(HttpException);
        },
      ),
      runs,
    );
  });
});

describe('Live download effect properties', () => {
  function download(options: { filename: string; contentType?: string }) {
    const component = {};
    beginEffects(component);
    try {
      downloadLive(component, { ...options, body: 'x' });
      return takeEffects(component).download;
    } finally {
      takeEffects(component);
    }
  }
  it('reduces any host filename to a well-formed, separator-free, unspoofable name', () => {
    const spoofing = new RegExp(
      `[${String.fromCharCode(0x61c)}${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2060)}-${String.fromCharCode(0x2064)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}${String.fromCharCode(0xfeff)}]`,
      'u',
    );
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (name) => {
        let cleaned: string;
        try {
          cleaned = safeFilename(name);
        } catch (error) {
          expect(String(error)).toMatch(/empty after sanitization/);
          return;
        }
        expect(cleaned.length).toBeGreaterThan(0);
        expect([...cleaned].length).toBeLessThanOrEqual(180);
        expect(cleaned).not.toMatch(/[/\\:*?"<>|]/);
        expect(cleaned).not.toMatch(/\p{Cc}|\p{Cs}/u);
        expect(cleaned).not.toMatch(spoofing);
        // Header encoding of the result can never throw.
        expect(() => encodeURIComponent(cleaned)).not.toThrow();
      }),
      runs,
    );
  });
  it('regression: accepts only RFC 6838 media types for downloads', () => {
    for (const contentType of [
      'text/csv; charset=utf-8',
      'application/vnd.ms-excel',
      'image/svg+xml',
      'application/x-www-form-urlencoded',
    ])
      expect(download({ filename: 'a.txt', contentType })?.contentType).toBe(
        contentType,
      );
    // These passed the corrupted character class before the fix.
    for (const contentType of [
      'text/html, text/plain',
      'text/html extra',
      'a/b/c',
      'text/*',
      'text/ html',
    ])
      expect(() => download({ filename: 'a.txt', contentType })).toThrow(
        /simple media type/,
      );
  });
  it('regression: lone surrogates and bidi overrides cannot reach the download header', () => {
    expect(safeFilename(`a${String.fromCharCode(0xd800)}.csv`)).toBe(
      `a${String.fromCharCode(0xfffd)}.csv`,
    );
    expect(safeFilename(`invoice${String.fromCharCode(0x202e)}fdp.exe`)).toBe(
      'invoicefdp.exe',
    );
    const emoji = String.fromCodePoint(0x1f600);
    expect(safeFilename(`${'a'.repeat(179)}${emoji}b`)).toBe(
      `${'a'.repeat(179)}${emoji}`,
    );
  });
});
