import { LiveClientError, parseIdentifier } from './grammar.js';

export interface ModelDirective {
  readonly field: string;
  readonly mode: 'defer' | 'live' | 'blur' | 'change';
  readonly cast: 'auto' | 'number' | 'boolean';
  readonly debounceMs?: number;
  readonly throttleMs?: number;
}
export type ModelValue = string | number | boolean;

function invalid(
  message = 'Invalid or unsupported model modifier configuration',
): never {
  throw new LiveClientError('DIRECTIVE', message);
}

const modes: Readonly<Record<string, ModelDirective['mode']>> = {
  defer: 'defer',
  live: 'live',
  blur: 'blur',
  change: 'change',
  lazy: 'change',
};
interface ModelOptions {
  mode: ModelDirective['mode'] | undefined;
  cast: ModelDirective['cast'];
  debounceMs: number | undefined;
  throttleMs: number | undefined;
}
function applyModifier(
  options: ModelOptions,
  modifier: string,
  next: string | undefined,
): boolean {
  const mode = Object.hasOwn(modes, modifier) ? modes[modifier] : undefined;
  if (mode !== undefined) {
    if (options.mode !== undefined) invalid();
    options.mode = mode;
    return false;
  }
  if (modifier === 'number' || modifier === 'boolean') {
    if (options.cast !== 'auto') invalid();
    options.cast = modifier;
    return false;
  }
  if (modifier !== 'debounce' && modifier !== 'throttle') invalid();
  if (options.debounceMs !== undefined || options.throttleMs !== undefined)
    invalid();
  const consume = next !== undefined && /^\d+ms$/.test(next);
  const interval = consume ? Number(next.slice(0, -2)) : 250;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000)
    invalid();
  if (modifier === 'debounce') options.debounceMs = interval;
  else options.throttleMs = interval;
  return consume;
}

/** Closed configuration grammar. Timing modifiers imply live synchronization, never JavaScript evaluation. */
export function parseModelDirective(
  name: string,
  value: string,
): ModelDirective {
  const [attribute, ...modifiers] = name.split('.');
  if (attribute !== 'nv:model') invalid();
  const seen = new Set<string>();
  const options: ModelOptions = {
    mode: undefined,
    cast: 'auto',
    debounceMs: undefined,
    throttleMs: undefined,
  };
  for (let index = 0; index < modifiers.length; index++) {
    const modifier = modifiers[index];
    if (!modifier || seen.has(modifier)) invalid();
    seen.add(modifier);
    if (applyModifier(options, modifier, modifiers[index + 1])) index++;
  }
  let { mode, debounceMs } = options;
  const { cast, throttleMs } = options;
  const timing = debounceMs !== undefined || throttleMs !== undefined;
  if (timing && mode !== undefined && mode !== 'live') invalid();
  mode ??= timing ? 'live' : 'defer';
  if (mode === 'live' && !timing) debounceMs = 150;
  return Object.freeze({
    field: parseIdentifier(value),
    mode,
    cast,
    ...(debounceMs === undefined ? {} : { debounceMs }),
    ...(throttleMs === undefined ? {} : { throttleMs }),
  });
}

/** Primitive-only conversion. It never invokes user-defined conversion methods. */
export function coerceModelValue(
  raw: unknown,
  cast: ModelDirective['cast'],
): ModelValue {
  if (cast !== 'auto' && cast !== 'number' && cast !== 'boolean') invalid();
  if (
    typeof raw !== 'string' &&
    typeof raw !== 'number' &&
    typeof raw !== 'boolean'
  )
    invalid('Model values must be finite primitives');
  if (typeof raw === 'number' && !Number.isFinite(raw))
    invalid('Model number is invalid');
  if (cast === 'auto') return raw;
  if (cast === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === 'true' || value === '1' || value === 1) return true;
    if (value === 'false' || value === '0' || value === 0) return false;
    return invalid('Boolean models accept only true, false, 1 or 0');
  }
  if (typeof raw === 'boolean')
    invalid('A boolean is not a numeric model value');
  if (typeof raw === 'number') return raw;
  const text = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))
    invalid('Numeric models require a complete finite decimal value');
  const value = Number(text);
  if (!Number.isFinite(value)) invalid('Model number is invalid');
  return value;
}

const inputTypes = new Set([
  'text',
  'number',
  'checkbox',
  'radio',
  'email',
  'search',
  'tel',
  'url',
  'password',
]);
function control(
  element: Element,
  directive: ModelDirective,
): 'INPUT' | 'TEXTAREA' | 'SELECT' {
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
    invalid('Models require an HTML form control');
  const tag = element.tagName;
  if (tag === 'TEXTAREA') return tag;
  if (tag === 'SELECT') {
    // The verified HTML namespace and tag prove the native control interface.
    if ((element as HTMLSelectElement).multiple)
      invalid('Multiple-select model values are not supported yet');
    return tag;
  }
  if (tag !== 'INPUT' || !inputTypes.has((element as HTMLInputElement).type))
    invalid('Unsupported model form control');
  if (
    (element as HTMLInputElement).type === 'checkbox' &&
    directive.cast === 'number'
  )
    invalid('Checkbox models support boolean values, not numeric casts');
  return tag;
}

/** Exactly one model declaration may own a native HTML input, textarea or single select. */
export function getModelDirective(
  element: Element,
): ModelDirective | undefined {
  const attributes = [...element.attributes].filter(
    (attribute) =>
      attribute.name === 'nv:model' || attribute.name.startsWith('nv:model.'),
  );
  if (attributes.length > 1)
    invalid('A form control must have exactly one model declaration');
  const attribute = attributes[0];
  if (!attribute) return undefined;
  const directive = parseModelDirective(attribute.name, attribute.value);
  control(element, directive);
  return directive;
}

/** Unchecked radio controls do not produce a state delta. Empty numeric controls are invalid, never zero. */
export function readModelValue(
  element: Element,
  directive: ModelDirective,
): ModelValue | undefined {
  const tag = control(element, directive);
  if (tag === 'INPUT') {
    const input = element as HTMLInputElement;
    if (input.type === 'radio' && !input.checked) return undefined;
    if (input.type === 'checkbox')
      return coerceModelValue(input.checked, directive.cast);
    return coerceModelValue(
      input.value,
      directive.cast === 'auto' && input.type === 'number'
        ? 'number'
        : directive.cast,
    );
  }
  return coerceModelValue(
    (element as HTMLTextAreaElement | HTMLSelectElement).value,
    directive.cast,
  );
}

/** Used by morphing without assuming the unmodified nv:model attribute name. */
export function modelField(element: Element): string | undefined {
  return getModelDirective(element)?.field;
}
