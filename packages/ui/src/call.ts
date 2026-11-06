import { SafeHtml } from '@nestvexa/views';
import { UiError, own } from './html.js';

/** The subset of the Handlebars helper options object these helpers read. */
export interface HelperCall {
  readonly positional: readonly unknown[];
  readonly hash: Readonly<Record<string, unknown>>;
  readonly fn:
    | ((context: unknown, runtime?: { readonly data?: unknown }) => string)
    | undefined;
  readonly data: unknown;
}

export function call(args: readonly unknown[], name: string): HelperCall {
  const options = args.at(-1);
  const hashSource = own(options, 'hash');
  if (hashSource === null || typeof hashSource !== 'object')
    throw new UiError('ARGUMENT', `${name} must be called from a template`);
  const hash: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(hashSource)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw new UiError('ARGUMENT', 'Unsafe helper argument');
    hash[key] = own(hashSource, key);
  }
  const fn = own(options, 'fn');
  return {
    positional: args.slice(0, -1),
    hash,
    fn:
      typeof fn === 'function'
        ? (context, runtime) => {
            const output: unknown = Reflect.apply(fn, undefined, [
              context,
              runtime,
            ]);
            return typeof output === 'string' ? output : '';
          }
        : undefined,
    data: own(options, 'data'),
  };
}
export function block(
  helper: HelperCall,
  name: string,
): NonNullable<HelperCall['fn']> {
  if (!helper.fn)
    throw new UiError('ARGUMENT', `${name} must be used as a block helper`);
  return helper.fn;
}
export const html = (value: string): SafeHtml => SafeHtml.trusted(value);

/**
 * Render a block body with a private collector in the Handlebars data frame,
 * so child helpers (accordion items, menu items, wizard steps) can register
 * themselves. Anything else rendered directly inside the block is rejected.
 */
export function collect(
  helper: HelperCall,
  name: string,
  context: unknown,
  key: string,
  collector: object,
  child: string,
): void {
  const fn = block(helper, name);
  const parent =
    helper.data !== null && typeof helper.data === 'object' ? helper.data : {};
  const frame = { ...parent, _parent: parent, [key]: collector };
  if (fn(context, { data: frame }).trim() !== '')
    throw new UiError(
      'ARGUMENT',
      `Only ${child} helpers may appear directly inside a ${name} block`,
    );
}
