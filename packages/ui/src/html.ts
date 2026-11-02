/** Closed error codes for invalid helper input. Messages never echo the value. */
export class UiError extends Error {
  constructor(
    readonly code: 'ID' | 'ARGUMENT',
    message: string,
  ) {
    super(message);
    this.name = 'UiError';
  }
}

const entities: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '=': '&#61;',
});
/** Escape text for HTML text nodes and quoted attribute values. */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"'`=]/g, (char) => entities[char] ?? '');
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** C0 controls, DEL and C1 controls. */
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Own enumerable data property, never an accessor or inherited value. */
export function own(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export function id(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !identifier.test(value) ||
    forbidden.has(value)
  )
    throw new UiError('ID', `${name} must match [A-Za-z][A-Za-z0-9_-]{0,63}`);
  return value;
}
export function optionalId(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : id(value, name);
}

/** Plain text label: strings or finite numbers, bounded, escaped at output. */
export function text(value: unknown, name: string, max = 512): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new UiError('ARGUMENT', `${name} must be non-empty text`);
  return value;
}
export function optionalText(
  value: unknown,
  name: string,
  max = 512,
): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : text(value, name, max);
}

export function flag(value: unknown, name: string): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  throw new UiError('ARGUMENT', `${name} must be a boolean`);
}

/** Same-origin relative path: starts with one slash, no backslash or controls. */
export function href(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControl(value)
  )
    throw new UiError('ARGUMENT', `${name} must be a same-origin path`);
  return value;
}
export function optionalHref(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : href(value, name);
}

/** Space separated class tokens. */
export function classes(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 256)
    throw new UiError('ARGUMENT', 'class must be class tokens');
  const tokens = value.trim().split(/\s+/);
  if (
    tokens.length > 8 ||
    tokens.some((token) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(token))
  )
    throw new UiError('ARGUMENT', 'class must be class tokens');
  return tokens.join(' ');
}

/** Render attributes; undefined/false are omitted, true renders a bare attribute. */
export function attributes(
  values: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  let output = '';
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    output +=
      value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`;
  }
  return output;
}
