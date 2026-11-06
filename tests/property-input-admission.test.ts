import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  inspectJsonInput,
  stableStringify,
  toJsonSafe,
} from '../packages/actions/src/shared/json.js';
import type { JsonValue } from '../packages/actions/src/shared/protocol.js';
import { parseFormBody } from '../packages/forms/src/body.js';
import { FormInputError } from '../packages/forms/src/errors.js';
import { hardenInput } from '../packages/forms/src/harden.js';
import { redact } from '../packages/observability/src/instrumentation.js';

/**
 * Property-based checks for request-body admission: universal server action
 * JSON inspection (prototype keys, depth, node budget), action output
 * serialization, idempotency fingerprints, and form hardening/bracket parsing.
 */
const runs = { numRuns: 300 };
const forbidden = ['__proto__', 'constructor', 'prototype'];
const json = fc.jsonValue({ maxDepth: 6 });

interface Shape {
  readonly nodes: number;
  readonly deepest: number;
  readonly polluted: boolean;
}
function shape(value: unknown, depth = 1): Shape {
  // Reference model: containers count toward depth (top-level is depth 1).
  let nodes = 1;
  let deepest = value !== null && typeof value === 'object' ? depth : 0;
  let polluted = false;
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries) {
      if (!Array.isArray(value) && forbidden.includes(key)) polluted = true;
      const nested: Shape = shape(child, depth + 1);
      nodes += nested.nodes;
      deepest = Math.max(deepest, nested.deepest);
      polluted ||= nested.polluted;
    }
  }
  return { nodes, deepest, polluted };
}
function withForbiddenKey(
  value: unknown,
  key: string,
  path: number[],
): unknown {
  // Rebuild through JSON text so `__proto__` becomes an own property, as a body parser does.
  const text = JSON.stringify(value);
  const injected = `{${JSON.stringify(key)}:${text}}`;
  let wrapped = injected;
  for (const index of path) wrapped = `[${'0,'.repeat(index % 3)}${wrapped}]`;
  return JSON.parse(wrapped) as unknown;
}

describe('server action JSON admission properties', () => {
  it('agrees with the reference model of depth, node count and prototype keys', () => {
    fc.assert(
      fc.property(
        json,
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 60 }),
        (value, maxDepth, maxNodes) => {
          const model = shape(value);
          const result = inspectJsonInput(value, { maxDepth, maxNodes });
          const problems = [
            ...(model.nodes > maxNodes ? ['NODES'] : []),
            ...(model.deepest > maxDepth ? ['DEPTH'] : []),
            ...(model.polluted ? ['FORBIDDEN_KEY'] : []),
          ];
          if (problems.length === 0) expect(result).toEqual({ ok: true });
          else {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(problems).toContain(result.problem);
          }
        },
      ),
      runs,
    );
  });

  it('finds prototype keys at any depth without polluting Object.prototype', () => {
    fc.assert(
      fc.property(
        json,
        fc.constantFrom(...forbidden),
        fc.array(fc.nat(5), { maxLength: 5 }),
        (value, key, path) => {
          const body = withForbiddenKey(value, key, path);
          const result = inspectJsonInput(body, {
            maxDepth: 64,
            maxNodes: 100_000,
          });
          expect(result).toEqual({ ok: false, problem: 'FORBIDDEN_KEY' });
          expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
        },
      ),
      runs,
    );
  });

  it('inspects adversarial nesting iteratively without exhausting the stack', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: 50_000 }),
        fc.boolean(),
        (depth, objects) => {
          const text = objects
            ? `${'{"a":'.repeat(depth)}0${'}'.repeat(depth)}`
            : `${'['.repeat(depth)}0${']'.repeat(depth)}`;
          const result = inspectJsonInput(JSON.parse(text), {
            maxDepth: 1_000_000,
            maxNodes: 1_000_000,
          });
          expect(result).toEqual({ ok: true });
          expect(
            inspectJsonInput(JSON.parse(text), {
              maxDepth: 32,
              maxNodes: 1_000_000,
            }),
          ).toEqual({ ok: false, problem: 'DEPTH' });
        },
      ),
      { numRuns: 20 },
    );
  });

  it('rejects non-JSON values and never invokes accessors', () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withDate: true,
          withMap: true,
          withSet: true,
          withTypedArray: true,
          withBoxedValues: true,
          withSparseArray: true,
        }),
        (value) => {
          const result = inspectJsonInput(value, {
            maxDepth: 64,
            maxNodes: 10_000,
          });
          if (result.ok)
            // Whatever is admitted must survive a JSON round trip unchanged.
            expect(JSON.stringify(JSON.parse(JSON.stringify(value)))).toBe(
              JSON.stringify(value),
            );
        },
      ),
      runs,
    );
    let evaluated = false;
    const hostile = Object.defineProperty({}, 'input', {
      enumerable: true,
      get() {
        evaluated = true;
        return 1;
      },
    });
    expect(inspectJsonInput(hostile, { maxDepth: 4, maxNodes: 10 })).toEqual({
      ok: false,
      problem: 'NOT_JSON',
    });
    expect(evaluated).toBe(false);
  });
});

describe('server action output and fingerprint properties', () => {
  it('returns JSON-equal detached copies of JSON output', () => {
    fc.assert(
      fc.property(json, (value) => {
        fc.pre(!shape(value).polluted);
        const result = toJsonSafe(value, { maxDepth: 64, maxNodes: 100_000 });
        expect(result.ok).toBe(true);
        if (result.ok)
          expect(JSON.stringify(result.value)).toBe(JSON.stringify(value));
      }),
      runs,
    );
  });

  it('never throws for arbitrary output values; rejections carry a path', () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withDate: true,
          withMap: true,
          withSet: true,
          withTypedArray: true,
          withSparseArray: true,
        }),
        (value) => {
          const result = toJsonSafe(value, { maxDepth: 16, maxNodes: 10_000 });
          if (!result.ok) expect(result.path.startsWith('$')).toBe(true);
        },
      ),
      runs,
    );
  });

  it('produces key-order independent idempotency fingerprints', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 6 }), json, { maxKeys: 8 }),
        (dictionary) => {
          fc.pre(!Object.hasOwn(dictionary, '__proto__'));
          const value = JSON.parse(JSON.stringify(dictionary)) as JsonValue;
          const reversed = JSON.parse(
            JSON.stringify(
              Object.fromEntries(Object.entries(dictionary).reverse()),
            ),
          ) as JsonValue;
          expect(stableStringify(reversed)).toBe(stableStringify(value));
          expect(JSON.parse(stableStringify(value))).toEqual(
            JSON.parse(JSON.stringify(value)),
          );
        },
      ),
      runs,
    );
  });
});

describe('form hardening properties', () => {
  const safeKey = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,8}$/);
  // Leaves are non-empty strings; containers are non-empty, as in real form posts.
  const { tree } = fc.letrec((tie) => ({
    tree: fc.dictionary(safeKey, tie('node'), { minKeys: 1, maxKeys: 4 }),
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.string({ minLength: 1, maxLength: 8 }),
      tie('tree'),
      fc.array(fc.string({ minLength: 1, maxLength: 4 }), {
        minLength: 1,
        maxLength: 4,
      }),
    ),
  }));
  function flatten(
    value: unknown,
    prefix: string,
    out: Record<string, string>,
  ) {
    if (typeof value === 'string') out[prefix] = value;
    else if (Array.isArray(value))
      value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
    else
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      ))
        flatten(child, prefix ? `${prefix}[${key}]` : key, out);
    return out;
  }

  it('reassembles flat bracket-encoded bodies into the submitted structure', () => {
    fc.assert(
      fc.property(tree, (value) => {
        const flat = flatten(value, '', {});
        fc.pre(Object.keys(flat).length <= 200);
        fc.pre(!Object.keys(flat).some((key) => /^\d/.test(key)));
        expect(parseFormBody(flat, { limits: { maxDepth: 16 } })).toEqual(
          value,
        );
      }),
      runs,
    );
  });

  it('throws only FormInputError for hostile flat keys and never pollutes prototypes', () => {
    const hostileKey = fc
      .array(
        fc.oneof(
          safeKey,
          fc.constantFrom(
            ...forbidden,
            '',
            '0',
            '499',
            '500',
            '999999999',
            'a.b',
            ']',
            '[',
          ),
        ),
        { minLength: 1, maxLength: 5 },
      )
      .chain((parts) =>
        fc.constantFrom(
          parts.join('.'),
          `${parts[0] ?? ''}${parts
            .slice(1)
            .map((part) => `[${part}]`)
            .join('')}`,
          `${parts.join('][')}[]`,
        ),
      );
    fc.assert(
      fc.property(
        fc.dictionary(
          hostileKey,
          fc.oneof(fc.string(), fc.array(fc.string())),
          {
            maxKeys: 6,
          },
        ),
        (body) => {
          try {
            const parsed = parseFormBody(body);
            expect(hardenInput(parsed)).toEqual(parsed);
          } catch (error) {
            expect(error).toBeInstanceOf(FormInputError);
          }
          for (const target of [Object.prototype, Array.prototype])
            expect(Object.keys(target)).toEqual([]);
        },
      ),
      runs,
    );
  });

  it('hardens JSON with safe keys into an equal ordinary object graph', () => {
    fc.assert(
      fc.property(tree, (value) => {
        const hardened = hardenInput(JSON.parse(JSON.stringify(value)), {
          maxDepth: 16,
        });
        expect(hardened).toEqual(value);
        expect(Object.getPrototypeOf(hardened)).toBe(Object.prototype);
      }),
      runs,
    );
  });
});

describe('log redaction properties', () => {
  const sensitiveKey = fc.constantFrom(
    'password',
    'csrfToken',
    'snapshot',
    'Authorization',
    'session_id',
    'apiKey',
    'binding',
  );
  function findLeak(value: unknown, depth: number): boolean {
    if (value === null || typeof value !== 'object' || depth > 8) return false;
    for (const [key, item] of Object.entries(value)) {
      if (
        /pass(word)?|secret|token|cookie|authorization|session|csrf|snapshot|binding|api[-_]?key|credential/i.test(
          key,
        ) &&
        item !== '[redacted]'
      )
        return true;
      if (findLeak(item, depth + 1)) return true;
    }
    return false;
  }
  it('redacts sensitive keys at any depth and keeps an own __proto__ field as data', () => {
    fc.assert(
      fc.property(
        json,
        sensitiveKey,
        fc.string({ maxLength: 20 }),
        fc.array(fc.nat(3), { maxLength: 4 }),
        (value, key, secret, path) => {
          let text = `{${JSON.stringify(key)}:${JSON.stringify(secret)},"__proto__":{"inner":${JSON.stringify(value)}}}`;
          for (const index of path) text = `[${'0,'.repeat(index)}${text}]`;
          const output = redact(JSON.parse(text) as unknown);
          expect(findLeak(output, 0)).toBe(false);
          let cursor: unknown = output;
          for (const index of [...path].reverse())
            cursor = (cursor as unknown[])[index];
          expect(Object.getPrototypeOf(cursor)).toBe(Object.prototype);
          expect(Object.hasOwn(cursor as object, '__proto__')).toBe(true);
        },
      ),
      runs,
    );
  });
});
