import { LiveClientError, parseIdentifier } from './grammar.js';

export type OptimisticOperation = 'set' | 'toggle' | 'increment' | 'decrement';
/** A declarative local projection applied until the server acknowledges. */
export interface OptimisticDirective {
  readonly kind: 'optimistic';
  readonly operation: OptimisticOperation;
  readonly field: string;
  readonly value?: string | number | boolean | null;
}
function literal(source: string): string | number | boolean | null {
  if (source === 'true') return true;
  if (source === 'false') return false;
  if (source === 'null') return null;
  if (/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/.test(source))
    return Number(source);
  const quoted = /^'([^'\\]{0,256})'$/.exec(source);
  if (quoted) return quoted[1] ?? '';
  throw new LiveClientError(
    'DIRECTIVE',
    "Optimistic values are true, false, null, a finite number or a 'quoted string'",
  );
}
/**
 * nv:optimistic.set="field:literal", .toggle="field", .increment="field[:step]",
 * .decrement="field[:step]". Values are data literals, never expressions.
 */
export function parseOptimisticDirective(
  name: string,
  value: string,
): OptimisticDirective {
  const match = /^nv:optimistic\.(set|toggle|increment|decrement)$/.exec(name);
  if (!match)
    throw new LiveClientError(
      'DIRECTIVE',
      'Use nv:optimistic.set, .toggle, .increment or .decrement',
    );
  const operation = match[1] as OptimisticOperation;
  const separator = value.indexOf(':');
  const field = parseIdentifier(
    separator < 0 ? value : value.slice(0, separator),
  );
  const raw = separator < 0 ? undefined : value.slice(separator + 1);
  if (operation === 'toggle') {
    if (raw !== undefined)
      throw new LiveClientError(
        'DIRECTIVE',
        'nv:optimistic.toggle takes a field only',
      );
    return { kind: 'optimistic', operation, field };
  }
  if (operation === 'set') {
    if (raw === undefined)
      throw new LiveClientError(
        'DIRECTIVE',
        'nv:optimistic.set requires field:value',
      );
    return { kind: 'optimistic', operation, field, value: literal(raw) };
  }
  const step = raw === undefined ? 1 : literal(raw);
  if (typeof step !== 'number' || step <= 0)
    throw new LiveClientError(
      'DIRECTIVE',
      'Optimistic steps must be positive numbers',
    );
  return { kind: 'optimistic', operation, field, value: step };
}
/** Compute the projected value from the currently displayed value. */
export function projectOptimistic(
  directive: OptimisticDirective,
  current: unknown,
): unknown {
  switch (directive.operation) {
    case 'set':
      return directive.value;
    case 'toggle':
      if (typeof current !== 'boolean')
        throw new LiveClientError(
          'DIRECTIVE',
          'nv:optimistic.toggle requires a boolean field',
        );
      return !current;
    case 'increment':
    case 'decrement': {
      if (typeof current !== 'number' || !Number.isFinite(current))
        throw new LiveClientError(
          'DIRECTIVE',
          'Optimistic arithmetic requires a finite number field',
        );
      const step = Number(directive.value);
      const next =
        directive.operation === 'increment' ? current + step : current - step;
      if (!Number.isFinite(next))
        throw new LiveClientError(
          'DIRECTIVE',
          'Optimistic arithmetic overflowed',
        );
      return next;
    }
  }
}
