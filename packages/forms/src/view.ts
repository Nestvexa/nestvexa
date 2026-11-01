import { FORM_ERROR, normalizeErrors, pathWithin, safeKey } from './errors.js';
import type { FormErrors } from './errors.js';

/** Template data for one control. All strings are plain text; templates escape them. */
export interface FieldView {
  /** Control id (`idPrefix + path`, dots replaced with `-`). */
  readonly id: string;
  /** Id of the inline error element. */
  readonly errorId: string;
  readonly invalid: boolean;
  /** `"true"` or `"false"`, ready for `aria-invalid`. */
  readonly ariaInvalid: 'true' | 'false';
  /** First message, or `''`. */
  readonly message: string;
  readonly messages: readonly string[];
  /**
   * Space-separated ids for `aria-describedby`: the hint id (when given) and the
   * error id when invalid; `''` when there is nothing to reference.
   */
  readonly describedBy: string;
}

export interface FieldViewOptions {
  /** Prefix for generated ids, e.g. `profile-`. Must be a safe id fragment. */
  readonly idPrefix?: string;
  /** Hint element ids by field path, always included in `describedBy`. */
  readonly hints?: Readonly<Record<string, string>>;
  /**
   * When given, errors are only shown for these paths (for example touched
   * fields before the first submit). Omit to show every error.
   */
  readonly visible?: readonly string[];
}

const idFragment = /^[A-Za-z][A-Za-z0-9_-]{0,63}$|^$/;
function checkPrefix(prefix: string): string {
  if (typeof prefix !== 'string' || !idFragment.test(prefix))
    throw new Error('idPrefix must be a safe HTML id fragment');
  return prefix;
}
function controlId(prefix: string, path: string): string {
  return prefix + path.replaceAll('.', '-');
}

/** Build accessible view data for one field path. */
export function fieldView(
  errors: FormErrors,
  path: string,
  options: FieldViewOptions = {},
): FieldView {
  const prefix = checkPrefix(options.idPrefix ?? '');
  if (
    typeof path !== 'string' ||
    !path.split('.').every((segment) => safeKey(segment))
  )
    throw new Error(`Invalid field path ${String(path)}`);
  const bag = normalizeErrors(errors);
  const shown =
    options.visible === undefined ||
    options.visible.some((field) => pathWithin(path, field));
  const messages = shown ? (bag[path] ?? []) : [];
  const id = controlId(prefix, path);
  const errorId = `${id}-error`;
  const hint = options.hints?.[path];
  if (hint !== undefined && !idFragment.test(hint))
    throw new Error('Hint ids must be safe HTML ids');
  const invalid = messages.length > 0;
  return Object.freeze({
    id,
    errorId,
    invalid,
    ariaInvalid: invalid ? 'true' : 'false',
    message: messages[0] ?? '',
    messages: Object.freeze([...messages]),
    describedBy: [hint, invalid ? errorId : undefined]
      .filter((item): item is string => !!item)
      .join(' '),
  });
}

/** Field views for several paths, keyed by path (dots allowed as keys). */
export function formView(
  errors: FormErrors,
  paths: readonly string[],
  options: FieldViewOptions = {},
): Readonly<Record<string, FieldView>> {
  const result: Record<string, FieldView> = {};
  for (const path of paths) result[path] = fieldView(errors, path, options);
  return Object.freeze(result);
}

export interface ErrorSummaryItem {
  readonly path: string;
  readonly label: string;
  readonly message: string;
  /** In-page link to the control, or `''` for form-level messages. */
  readonly href: string;
}
export interface ErrorSummary {
  readonly hasErrors: boolean;
  readonly count: number;
  readonly title: string;
  readonly items: readonly ErrorSummaryItem[];
}
export interface ErrorSummaryOptions {
  readonly idPrefix?: string;
  /** Human labels by path; unknown paths use the path. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Display order (top-level fields); remaining paths follow alphabetically. */
  readonly order?: readonly string[];
  /** Title builder; default "There is 1 problem" / "There are N problems". */
  readonly title?: (count: number) => string;
}

/**
 * An error summary for the top of a form: one item per invalid path (first
 * message), form-level messages first, linking to `#<control id>`.
 */
export function errorSummary(
  errors: FormErrors,
  options: ErrorSummaryOptions = {},
): ErrorSummary {
  const prefix = checkPrefix(options.idPrefix ?? '');
  const bag = normalizeErrors(errors);
  const order = options.order ?? [];
  const rank = (path: string): number => {
    if (path === FORM_ERROR) return -1;
    const index = order.findIndex((field) => pathWithin(path, field));
    return index === -1 ? order.length : index;
  };
  const items: ErrorSummaryItem[] = [];
  const paths = Object.keys(bag).sort(
    (left, right) => rank(left) - rank(right) || left.localeCompare(right),
  );
  for (const path of paths) {
    const messages = bag[path] ?? [];
    if (path === FORM_ERROR) {
      for (const message of messages)
        items.push(Object.freeze({ path, label: '', message, href: '' }));
      continue;
    }
    const message = messages[0];
    if (message === undefined) continue;
    items.push(
      Object.freeze({
        path,
        label: options.labels?.[path] ?? path,
        message,
        href: `#${controlId(prefix, path)}`,
      }),
    );
  }
  const count = items.length;
  const title = options.title
    ? options.title(count)
    : count === 1
      ? 'There is 1 problem'
      : `There are ${count} problems`;
  return Object.freeze({
    hasErrors: count > 0,
    count,
    title,
    items: Object.freeze(items),
  });
}
