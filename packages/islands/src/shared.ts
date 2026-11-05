/**
 * Island contract shared by the server registry, the build-time manifest
 * writer and the browser loader. No Node, Nest or DOM imports.
 */
export type IslandFramework = 'react' | 'vue' | 'svelte' | 'custom';
export type IslandStrategy = 'immediate' | 'visible' | 'idle' | 'interaction';

export const ISLAND_FRAMEWORKS: readonly IslandFramework[] = [
  'react',
  'vue',
  'svelte',
  'custom',
];
export const ISLAND_STRATEGIES: readonly IslandStrategy[] = [
  'immediate',
  'visible',
  'idle',
  'interaction',
];
export const ISLAND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** Same-origin absolute module path such as `/islands/react-chart-AB12CD34.js`. */
export const ISLAND_BUNDLE_PATTERN =
  /^\/(?!\/)(?:[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*\/)*[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*\.m?js$/;
export const DEFAULT_MAX_PROPS_BYTES = 32_768;
export const MAX_PROPS_BYTES = 262_144;
export const CONTEXT_ELEMENT_ID = 'nv-islands-context';

/**
 * Closed JSON-schema subset for island props. Objects never accept
 * undeclared keys, so an accidentally passed entity (with secrets) fails at
 * render time instead of reaching markup.
 */
export type IslandPropSchema =
  | {
      readonly type: 'string';
      readonly maxLength?: number;
      readonly enum?: readonly string[];
    }
  | {
      readonly type: 'number' | 'integer';
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: 'boolean' }
  | { readonly type: 'null' }
  | {
      readonly type: 'array';
      readonly items: IslandPropSchema;
      readonly maxItems?: number;
    }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, IslandPropSchema>>;
      readonly required?: readonly string[];
    }
  | { readonly anyOf: readonly IslandPropSchema[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a problem description, or undefined when `value` matches. */
export function checkIslandProps(
  schema: IslandPropSchema,
  value: unknown,
  path = '$',
  depth = 0,
): string | undefined {
  if (depth > 32) return `${path} is nested too deeply`;
  if ('anyOf' in schema) {
    for (const option of schema.anyOf)
      if (checkIslandProps(option, value, path, depth + 1) === undefined)
        return undefined;
    return `${path} matches no allowed shape`;
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        return `${path} is longer than ${schema.maxLength}`;
      if (schema.enum !== undefined && !schema.enum.includes(value))
        return `${path} is not an allowed value`;
      return undefined;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `${path} must be a finite number`;
      if (schema.type === 'integer' && !Number.isInteger(value))
        return `${path} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum)
        return `${path} is below ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum)
        return `${path} is above ${schema.maximum}`;
      return undefined;
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : `${path} must be a boolean`;
    case 'null':
      return value === null ? undefined : `${path} must be null`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        return `${path} has more than ${schema.maxItems} items`;
      for (const [index, item] of value.entries()) {
        const problem = checkIslandProps(
          schema.items,
          item,
          `${path}[${index}]`,
          depth + 1,
        );
        if (problem) return problem;
      }
      return undefined;
    }
    case 'object': {
      if (!isRecord(value)) return `${path} must be an object`;
      for (const key of Object.keys(value))
        if (!Object.hasOwn(schema.properties, key))
          return `${path}.${key} is not a declared prop`;
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
      for (const [key, item] of Object.entries(value)) {
        const property = schema.properties[key];
        if (!property) continue;
        const problem = checkIslandProps(
          property,
          item,
          `${path}.${key}`,
          depth + 1,
        );
        if (problem) return problem;
      }
      return undefined;
    }
  }
}

/** Validates a schema document (from a manifest file) structurally. */
export function isIslandPropSchema(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 32) return false;
  if (Object.hasOwn(value, 'anyOf'))
    return (
      Array.isArray(value['anyOf']) &&
      value['anyOf'].length > 0 &&
      value['anyOf'].every((option) => isIslandPropSchema(option, depth + 1))
    );
  const bound = (key: string) =>
    value[key] === undefined ||
    (typeof value[key] === 'number' && Number.isFinite(value[key]));
  switch (value['type']) {
    case 'string':
      return (
        bound('maxLength') &&
        (value['enum'] === undefined ||
          (Array.isArray(value['enum']) &&
            value['enum'].every((entry) => typeof entry === 'string')))
      );
    case 'number':
    case 'integer':
      return bound('minimum') && bound('maximum');
    case 'boolean':
    case 'null':
      return true;
    case 'array':
      return bound('maxItems') && isIslandPropSchema(value['items'], depth + 1);
    case 'object': {
      const properties = value['properties'];
      const required = value['required'];
      return (
        isRecord(properties) &&
        Object.values(properties).every((property) =>
          isIslandPropSchema(property, depth + 1),
        ) &&
        (required === undefined ||
          (Array.isArray(required) &&
            required.every(
              (key) =>
                typeof key === 'string' && Object.hasOwn(properties, key),
            )))
      );
    }
    default:
      return false;
  }
}

/** Build-time island manifest entry (written by `@nestvexa/islands/build`). */
export interface IslandManifestEntry {
  readonly framework: IslandFramework;
  readonly strategy: IslandStrategy;
  /** Same-origin module path of the island's entry chunk. */
  readonly bundle: string;
  readonly maxPropsBytes: number;
  readonly props?: IslandPropSchema;
  /** Server-signed props (`data-nv-props-token`). */
  readonly signed?: boolean;
  /** Gzip budget in bytes for the island's chunk graph (checked by scripts). */
  readonly budgetBytes?: number;
}
export interface IslandManifest {
  readonly version: 1;
  readonly islands: Readonly<Record<string, IslandManifestEntry>>;
}

/** Strict manifest parser shared by server and browser. */
export function parseIslandManifest(value: unknown): IslandManifest {
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['islands']))
    throw new Error('Invalid island manifest');
  const islands: Record<string, IslandManifestEntry> = {};
  for (const [id, entry] of Object.entries(value['islands'])) {
    if (!ISLAND_ID_PATTERN.test(id) || !isRecord(entry))
      throw new Error(`Invalid island manifest entry ${id}`);
    const framework = entry['framework'];
    const strategy = entry['strategy'];
    const bundle = entry['bundle'];
    const maxPropsBytes = entry['maxPropsBytes'];
    const props = entry['props'];
    const signed = entry['signed'];
    const budgetBytes = entry['budgetBytes'];
    if (
      !ISLAND_FRAMEWORKS.includes(framework as IslandFramework) ||
      !ISLAND_STRATEGIES.includes(strategy as IslandStrategy) ||
      typeof bundle !== 'string' ||
      !ISLAND_BUNDLE_PATTERN.test(bundle) ||
      typeof maxPropsBytes !== 'number' ||
      !Number.isSafeInteger(maxPropsBytes) ||
      maxPropsBytes < 2 ||
      maxPropsBytes > MAX_PROPS_BYTES ||
      (props !== undefined && !isIslandPropSchema(props)) ||
      (signed !== undefined && typeof signed !== 'boolean') ||
      (budgetBytes !== undefined &&
        (typeof budgetBytes !== 'number' ||
          !Number.isSafeInteger(budgetBytes) ||
          budgetBytes < 1))
    )
      throw new Error(`Invalid island manifest entry ${id}`);
    islands[id] = Object.freeze({
      framework: framework as IslandFramework,
      strategy: strategy as IslandStrategy,
      bundle,
      maxPropsBytes,
      ...(props === undefined ? {} : { props: props as IslandPropSchema }),
      ...(signed === undefined ? {} : { signed }),
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    });
  }
  return Object.freeze({ version: 1, islands: Object.freeze(islands) });
}

/** Page-level, user-safe context shared by every island (theme, locale, user). */
export interface IslandSharedContext {
  readonly locale?: string;
  readonly direction?: 'ltr' | 'rtl';
  /** Design tokens; applied to island roots as `--nv-<name>` custom properties. */
  readonly theme?: Readonly<Record<string, string>>;
  /** Display data about the viewer. Never authorization input. */
  readonly user?: Readonly<Record<string, string | number | boolean | null>>;
}

export const TOKEN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
// Token values become CSS custom property values: no declarations, blocks,
// markup or escapes that could break out of the property.
export const TOKEN_VALUE_PATTERN = /^[^;{}<>\\"'`]{1,256}$/;
export const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;
export const SENSITIVE_KEY =
  /password|passwd|^pass$|secret|token|api[-_]?key|credential|session|cookie|authorization|csrf|private[-_]?key/i;

/** Validates and freezes a shared context; throws on unsafe content. */
export function parseSharedContext(value: unknown): IslandSharedContext {
  if (!isRecord(value)) throw new Error('Island context must be an object');
  for (const key of Object.keys(value))
    if (!['locale', 'direction', 'theme', 'user'].includes(key))
      throw new Error(`Unknown island context field ${key}`);
  const result: {
    locale?: string;
    direction?: 'ltr' | 'rtl';
    theme?: Readonly<Record<string, string>>;
    user?: Readonly<Record<string, string | number | boolean | null>>;
  } = {};
  if (value['locale'] !== undefined) {
    if (
      typeof value['locale'] !== 'string' ||
      !LOCALE_PATTERN.test(value['locale'])
    )
      throw new Error('Invalid island context locale');
    result.locale = value['locale'];
  }
  if (value['direction'] !== undefined) {
    if (value['direction'] !== 'ltr' && value['direction'] !== 'rtl')
      throw new Error('Invalid island context direction');
    result.direction = value['direction'];
  }
  if (value['theme'] !== undefined) {
    const theme = value['theme'];
    if (!isRecord(theme) || Object.keys(theme).length > 128)
      throw new Error('Invalid island theme');
    const tokens: Record<string, string> = {};
    for (const [name, token] of Object.entries(theme)) {
      if (
        !TOKEN_NAME_PATTERN.test(name) ||
        typeof token !== 'string' ||
        !TOKEN_VALUE_PATTERN.test(token)
      )
        throw new Error(`Invalid island theme token ${name}`);
      tokens[name] = token;
    }
    result.theme = Object.freeze(tokens);
  }
  if (value['user'] !== undefined) {
    const user = value['user'];
    if (!isRecord(user) || Object.keys(user).length > 32)
      throw new Error('Invalid island user context');
    const copy: Record<string, string | number | boolean | null> = {};
    for (const [key, item] of Object.entries(user)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || SENSITIVE_KEY.test(key))
        throw new Error(`Island user context must not include ${key}`);
      if (!(
        item === null ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item)) ||
        (typeof item === 'string' && item.length <= 256)
      ))
        throw new Error(`Invalid island user context value ${key}`);
      copy[key] = item;
    }
    result.user = Object.freeze(copy);
  }
  return Object.freeze(result);
}
