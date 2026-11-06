import { MailError } from './errors.js';

/** `"ada@example.com"` or `{ address, name }`. Display names are plain text. */
export type MailAddress = string | MailMailbox;
export interface MailMailbox {
  readonly address: string;
  readonly name?: string;
}
export type MailRecipients = MailAddress | readonly MailAddress[];

/** What the application asks to send. */
export interface MailMessage {
  /** Defaults to the module's `from`. */
  readonly from?: MailAddress;
  readonly to: MailRecipients;
  readonly cc?: MailRecipients;
  readonly bcc?: MailRecipients;
  readonly replyTo?: MailAddress;
  readonly subject: string;
  /** Trusted, already rendered HTML (for example from `MailTemplates`). */
  readonly html?: string;
  /** Plain-text part. Derived from `html` when omitted. */
  readonly text?: string;
  /** Extra headers such as `List-Unsubscribe`. Address and MIME headers are reserved. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A validated message handed to a transport: every field is safe to place in a header. */
export interface NormalizedMailMessage {
  readonly from: MailMailbox;
  readonly to: readonly MailMailbox[];
  readonly cc: readonly MailMailbox[];
  readonly bcc: readonly MailMailbox[];
  readonly replyTo?: MailMailbox;
  readonly subject: string;
  readonly html?: string;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface MailLimits {
  /** to + cc + bcc. Default 50. */
  readonly maxRecipients?: number;
  /** UTF-8 bytes of html + text. Default 2 MiB. */
  readonly maxBodyBytes?: number;
  /** Extra headers. Default 20. */
  readonly maxHeaders?: number;
}

const maxAddressLength = 254;
const maxLocalLength = 64;
const maxNameLength = 200;
const maxSubjectLength = 998;
const maxHeaderValueLength = 998;
// Pragmatic RFC 5322 dot-atom subset: no quoted local parts, comments or IP literals.
const localPart =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const domainLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** C0 controls (CR, LF, NUL, ...), DEL and the Unicode line/paragraph separators. */
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029)
      return true;
  }
  return false;
}
const headerName = /^[A-Za-z0-9][A-Za-z0-9-]{0,76}$/;
/** Set through message fields only; a raw header could re-address the mail. */
const reservedHeaders = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'sender',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'return-path',
]);

/** True for an address this package accepts (`local@domain.tld`, at most 254 characters). */
export function isMailAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > maxAddressLength)
    return false;
  const at = value.lastIndexOf('@');
  if (at < 1 || at !== value.indexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > maxLocalLength || !localPart.test(local)) return false;
  const labels = domain.split('.');
  return (
    labels.length >= 2 &&
    labels.every((label) => domainLabel.test(label)) &&
    /^[A-Za-z]{2,63}$/.test(labels.at(-1) ?? '')
  );
}

function mailbox(value: unknown, field: string): MailMailbox {
  if (typeof value === 'string') {
    if (!isMailAddress(value))
      throw new MailError('INVALID_ADDRESS', `Invalid ${field} address`);
    return Object.freeze({ address: value });
  }
  if (typeof value !== 'object' || value === null)
    throw new MailError('INVALID_ADDRESS', `Invalid ${field} address`);
  const address: unknown = Reflect.get(value, 'address');
  const name: unknown = Reflect.get(value, 'name');
  if (!isMailAddress(address))
    throw new MailError('INVALID_ADDRESS', `Invalid ${field} address`);
  if (name === undefined) return Object.freeze({ address });
  if (
    typeof name !== 'string' ||
    name.length > maxNameLength ||
    hasControl(name)
  )
    throw new MailError('INVALID_ADDRESS', `Invalid ${field} display name`);
  const trimmed = name.trim();
  return Object.freeze(trimmed ? { address, name: trimmed } : { address });
}

function mailboxes(value: unknown, field: string): readonly MailMailbox[] {
  if (value === undefined) return Object.freeze([]);
  const list: readonly unknown[] = Array.isArray(value) ? value : [value];
  return Object.freeze(list.map((entry) => mailbox(entry, field)));
}

function byteLength(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value);
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new MailError(
      'INVALID_MESSAGE',
      'Mail limits must be positive integers',
    );
  return value;
}

/** Throws `INVALID_HEADER` unless `value` can be written as a single header line. */
export function assertHeaderText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length > maxHeaderValueLength ||
    hasControl(value)
  )
    throw new MailError('INVALID_HEADER', `Invalid ${field}`);
  return value;
}

/**
 * Validate and freeze a message. Rejects CR/LF and other control characters in
 * every header field (header injection), malformed addresses, reserved extra
 * headers and recipient or body counts over the limits.
 */
export function normalizeMailMessage(
  message: MailMessage,
  defaults: { readonly from?: MailAddress } = {},
  limits: MailLimits = {},
): NormalizedMailMessage {
  if (typeof message !== 'object' || message === null)
    throw new MailError('INVALID_MESSAGE', 'A message object is required');
  const maxRecipients = positive(limits.maxRecipients, 50);
  const maxBodyBytes = positive(limits.maxBodyBytes, 2 * 1024 * 1024);
  const maxHeaders = positive(limits.maxHeaders, 20);
  const fromValue = message.from ?? defaults.from;
  if (fromValue === undefined)
    throw new MailError('INVALID_ADDRESS', 'A from address is required');
  const from = mailbox(fromValue, 'from');
  const to = mailboxes(message.to, 'to');
  const cc = mailboxes(message.cc, 'cc');
  const bcc = mailboxes(message.bcc, 'bcc');
  if (to.length === 0)
    throw new MailError(
      'INVALID_ADDRESS',
      'At least one to address is required',
    );
  if (to.length + cc.length + bcc.length > maxRecipients)
    throw new MailError(
      'TOO_MANY_RECIPIENTS',
      `At most ${maxRecipients} recipients per message`,
    );
  const replyTo =
    message.replyTo === undefined
      ? undefined
      : mailbox(message.replyTo, 'reply-to');
  const subject = assertHeaderText(message.subject, 'subject');
  if (subject.length > maxSubjectLength || !subject.trim())
    throw new MailError('INVALID_HEADER', 'Invalid subject');
  const { html } = message;
  if (html !== undefined && typeof html !== 'string')
    throw new MailError('INVALID_MESSAGE', 'html must be a string');
  if (message.text !== undefined && typeof message.text !== 'string')
    throw new MailError('INVALID_MESSAGE', 'text must be a string');
  if (byteLength(html) + byteLength(message.text) > maxBodyBytes)
    throw new MailError(
      'INVALID_MESSAGE',
      `Body exceeds ${maxBodyBytes} bytes`,
    );
  const text =
    message.text ?? (html === undefined ? undefined : htmlToText(html));
  if (text === undefined)
    throw new MailError('INVALID_MESSAGE', 'A message needs html or text');
  if (byteLength(html) + byteLength(text) > maxBodyBytes)
    throw new MailError(
      'INVALID_MESSAGE',
      `Body exceeds ${maxBodyBytes} bytes`,
    );
  const headers = Object.create(null) as Record<string, string>;
  const entries = Object.entries(message.headers ?? {});
  if (entries.length > maxHeaders)
    throw new MailError(
      'INVALID_HEADER',
      `At most ${maxHeaders} extra headers`,
    );
  for (const [name, value] of entries) {
    if (!headerName.test(name) || reservedHeaders.has(name.toLowerCase()))
      throw new MailError('INVALID_HEADER', 'Invalid or reserved header name');
    if (
      Object.keys(headers).some(
        (key) => key.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new MailError('INVALID_HEADER', 'Duplicate header name');
    headers[name] = assertHeaderText(value, `header ${name}`);
  }
  return Object.freeze({
    from,
    to,
    cc,
    bcc,
    ...(replyTo === undefined ? {} : { replyTo }),
    subject,
    ...(html === undefined ? {} : { html }),
    text,
    headers: Object.freeze(headers),
  });
}

/** `"Name" <address>` with the display name quoted and escaped, or the bare address. */
export function formatMailbox(value: MailMailbox): string {
  if (value.name === undefined) return value.address;
  const quoted = value.name.replace(/[\\"]/g, (character) => `\\${character}`);
  return `"${quoted}" <${value.address}>`;
}

const entities: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
/**
 * Decode the entities template engines emit when escaping (`&amp;`, `&lt;`,
 * `&#x27;`, `&#61;` ...). Used for plain-text parts and subjects, which are not
 * HTML: escaping there would show `&amp;` to the reader.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g,
    (match, entity: string) => {
      if (entity.startsWith('#')) {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : match;
      }
      return entities[entity] ?? match;
    },
  );
}

const hidden = new Set(['head', 'style', 'script', 'title', 'template']);
const blocks = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'tr',
  'blockquote',
  'section',
  'article',
  'header',
  'footer',
]);
const hrefAttribute = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * A readable plain-text alternative for HTML: drops head/style/script, keeps
 * link targets, turns block ends into line breaks and decodes entities. One
 * linear scan with `indexOf` (no regular expression backtracks over the body).
 * Not a sanitizer; the output is only ever used as a text/plain part.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  let output = '';
  let index = 0;
  const links: { start: number; href: string }[] = [];
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;
    output += decodeHtmlEntities(html.slice(index, open));
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    if (close === -1) {
      index = open;
      break;
    }
    const source = html.slice(open + 1, close);
    index = close + 1;
    const parsed = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(source);
    if (!parsed) {
      output += decodeHtmlEntities(html.slice(open, close + 1));
      continue;
    }
    const closing = parsed[1] === '/';
    const name = (parsed[2] ?? '').toLowerCase();
    if (!closing && hidden.has(name)) {
      const end = lower.indexOf(`</${name}`, index);
      const after = end === -1 ? -1 : html.indexOf('>', end);
      index = after === -1 ? html.length : after + 1;
    } else if (name === 'br') output += '\n';
    else if (name === 'li' && !closing) output += '\n- ';
    else if (closing && blocks.has(name)) output += '\n\n';
    else if (name === 'a' && !closing) {
      const href = hrefAttribute.exec(source);
      links.push({
        start: output.length,
        href: href ? decodeHtmlEntities(href[1] ?? href[2] ?? '') : '',
      });
    } else if (name === 'a' && closing) {
      const link = links.pop();
      if (link?.href) {
        const label = output.slice(link.start).trim();
        output =
          output.slice(0, link.start) +
          (label && label !== link.href
            ? `${label} (${link.href})`
            : link.href);
      }
    }
  }
  output += decodeHtmlEntities(html.slice(index));
  return output
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
