import type { ActionIssue } from './shared/protocol.js';

/** Structural issue shape produced by Zod and similar validators. */
export interface ActionSchemaIssue {
  readonly path?: readonly unknown[];
  readonly message?: string;
}
export type ActionSchemaParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error?: { readonly issues?: readonly ActionSchemaIssue[] };
    };

/**
 * Any runtime validator exposing `safeParseAsync`, `safeParse` or `parse`
 * (Zod-compatible structurally). Nestvexa never depends on a schema library.
 */
export type ActionSchema<T = unknown> =
  | {
      readonly safeParseAsync: (
        value: unknown,
      ) => Promise<ActionSchemaParseResult<T>>;
    }
  | { readonly safeParse: (value: unknown) => ActionSchemaParseResult<T> }
  | { readonly parse: (value: unknown) => T };

export function isActionSchema(value: unknown): value is ActionSchema {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  )
    return false;
  return ['safeParseAsync', 'safeParse', 'parse'].some(
    (name) => typeof Reflect.get(value, name) === 'function',
  );
}

export type SchemaOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly ActionIssue[] };

function issuesFrom(source: unknown): ActionIssue[] {
  const list: unknown =
    typeof source === 'object' && source !== null
      ? Reflect.get(source, 'issues')
      : undefined;
  if (!Array.isArray(list) || list.length === 0)
    return [{ path: [], message: 'Invalid value' }];
  return list.slice(0, 50).map((issue: unknown) => {
    const path: unknown =
      typeof issue === 'object' && issue !== null
        ? Reflect.get(issue, 'path')
        : undefined;
    const message: unknown =
      typeof issue === 'object' && issue !== null
        ? Reflect.get(issue, 'message')
        : undefined;
    return {
      path: Array.isArray(path)
        ? path.slice(0, 32).map((segment: unknown) => {
            if (typeof segment === 'number' && Number.isSafeInteger(segment))
              return segment;
            if (typeof segment === 'string') return segment.slice(0, 128);
            // Standard Schema path segments may be `{ key }` objects.
            const key: unknown =
              typeof segment === 'object' && segment !== null
                ? Reflect.get(segment, 'key')
                : segment;
            return typeof key === 'number' && Number.isSafeInteger(key)
              ? key
              : String(key).slice(0, 128);
          })
        : [],
      message:
        typeof message === 'string' && message.length > 0
          ? message.slice(0, 500)
          : 'Invalid value',
    };
  });
}

/** Runs a schema; validator exceptions from `parse` become issues, other faults propagate. */
export async function runSchema(
  schema: ActionSchema,
  value: unknown,
): Promise<SchemaOutcome> {
  let result: ActionSchemaParseResult<unknown>;
  if ('safeParseAsync' in schema && typeof schema.safeParseAsync === 'function')
    result = await schema.safeParseAsync(value);
  else if ('safeParse' in schema && typeof schema.safeParse === 'function')
    result = schema.safeParse(value);
  else if ('parse' in schema && typeof schema.parse === 'function') {
    try {
      return { ok: true, value: await schema.parse(value) };
    } catch (error) {
      return { ok: false, issues: issuesFrom(error) };
    }
  } else throw new TypeError('Invalid action schema');
  if (typeof result !== 'object' || result === null)
    throw new TypeError('Action schema returned an invalid parse result');
  if (result.success === true) return { ok: true, value: result.data };
  return { ok: false, issues: issuesFrom(result.error) };
}
