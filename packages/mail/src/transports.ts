import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MailError } from './errors.js';
import { formatMailbox } from './message.js';
import type { NormalizedMailMessage } from './message.js';

export interface MailSendResult {
  /** Provider message id, or a generated one when the provider returns none. */
  readonly id: string;
}
/**
 * Provider-neutral delivery. Implementations receive a validated message and
 * must not re-parse addresses from strings. Real delivery belongs to the
 * host's mail integration (see `nodemailerTransport` / `nestMailerTransport`).
 */
export interface MailTransport {
  readonly name: string;
  send(message: NormalizedMailMessage): Promise<MailSendResult>;
}

interface ProductionGuard {
  /** Allow use when NODE_ENV=production. Default false. */
  readonly allowProduction?: boolean;
}
function refuseProduction(name: string, options: ProductionGuard): void {
  if (
    process.env['NODE_ENV'] === 'production' &&
    options.allowProduction !== true
  )
    throw new MailError(
      'UNSAFE_ENVIRONMENT',
      `${name} does not deliver mail and is disabled in production; configure a real transport`,
    );
}

export interface MemoryMailTransportOptions extends ProductionGuard {
  /** Oldest messages are dropped beyond this many. Default 1000. */
  readonly maxMessages?: number;
}
/**
 * TEST TRANSPORT: keeps messages in memory for assertions and delivers
 * nothing. Refuses construction in production unless explicitly allowed.
 */
export class MemoryMailTransport implements MailTransport {
  readonly name = 'memory (test transport)';
  readonly #messages: { id: string; message: NormalizedMailMessage }[] = [];
  readonly #max: number;
  constructor(options: MemoryMailTransportOptions = {}) {
    refuseProduction('MemoryMailTransport', options);
    this.#max = options.maxMessages ?? 1000;
    if (!Number.isSafeInteger(this.#max) || this.#max < 1)
      throw new MailError(
        'INVALID_MESSAGE',
        'maxMessages must be a positive integer',
      );
  }
  send(message: NormalizedMailMessage): Promise<MailSendResult> {
    const id = `memory-${randomUUID()}`;
    this.#messages.push({ id, message });
    if (this.#messages.length > this.#max) this.#messages.shift();
    return Promise.resolve({ id });
  }
  /** Sent messages, oldest first. */
  get messages(): readonly NormalizedMailMessage[] {
    return this.#messages.map((entry) => entry.message);
  }
  last(): NormalizedMailMessage | undefined {
    return this.#messages.at(-1)?.message;
  }
  /** Messages with `address` in to, cc or bcc. */
  to(address: string): readonly NormalizedMailMessage[] {
    const wanted = address.toLowerCase();
    return this.messages.filter((message) =>
      [...message.to, ...message.cc, ...message.bcc].some(
        (mailbox) => mailbox.address.toLowerCase() === wanted,
      ),
    );
  }
  byId(id: string): NormalizedMailMessage | undefined {
    return this.#messages.find((entry) => entry.id === id)?.message;
  }
  clear(): void {
    this.#messages.length = 0;
  }
}

export interface MailLog {
  log(message: string): void;
}
export interface ConsoleMailTransportOptions extends ProductionGuard {
  /** Defaults to a Nest `Logger` with the `Mail` context. */
  readonly logger?: MailLog;
  /** Log the text part (links, tokens). Default true; the HTML part is never logged. */
  readonly includeText?: boolean;
}
/**
 * Development transport: writes a summary and the text part to the Nest
 * logger instead of sending. Mail often carries sign-in or reset links, so it
 * refuses construction in production unless explicitly allowed. Bcc
 * recipients are counted, not listed.
 */
export class ConsoleMailTransport implements MailTransport {
  readonly name = 'console (development transport)';
  readonly #logger: MailLog;
  readonly #includeText: boolean;
  constructor(options: ConsoleMailTransportOptions = {}) {
    refuseProduction('ConsoleMailTransport', options);
    this.#logger = options.logger ?? new Logger('Mail');
    this.#includeText = options.includeText ?? true;
  }
  send(message: NormalizedMailMessage): Promise<MailSendResult> {
    const id = `console-${randomUUID()}`;
    const lines = [
      `Mail ${id} (not sent)`,
      `From: ${formatMailbox(message.from)}`,
      `To: ${message.to.map(formatMailbox).join(', ')}`,
      ...(message.cc.length
        ? [`Cc: ${message.cc.map(formatMailbox).join(', ')}`]
        : []),
      ...(message.bcc.length
        ? [`Bcc: ${message.bcc.length} recipient(s)`]
        : []),
      `Subject: ${message.subject}`,
      ...(this.#includeText ? ['', message.text] : []),
    ];
    this.#logger.log(lines.join('\n'));
    return Promise.resolve({ id });
  }
}

/** Options accepted by nodemailer's `sendMail` and `@nestjs-modules/mailer`'s `MailerService.sendMail`. */
export interface SendMailOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text: string;
  headers: Record<string, string>;
}
/** Structural nodemailer `Transporter` (or anything with the same `sendMail`). */
export interface SendMailTarget {
  sendMail(options: SendMailOptions): Promise<unknown>;
}

export function toSendMailOptions(
  message: NormalizedMailMessage,
): SendMailOptions {
  return {
    from: formatMailbox(message.from),
    to: message.to.map(formatMailbox),
    ...(message.cc.length ? { cc: message.cc.map(formatMailbox) } : {}),
    ...(message.bcc.length ? { bcc: message.bcc.map(formatMailbox) } : {}),
    ...(message.replyTo === undefined
      ? {}
      : { replyTo: formatMailbox(message.replyTo) }),
    subject: message.subject,
    ...(message.html === undefined ? {} : { html: message.html }),
    text: message.text,
    headers: { ...message.headers },
  };
}
function messageId(info: unknown): string {
  const id: unknown =
    typeof info === 'object' && info !== null
      ? Reflect.get(info, 'messageId')
      : undefined;
  return typeof id === 'string' && id.length > 0 && id.length <= 998
    ? id
    : randomUUID();
}
function sendMailTransport(
  name: string,
  target: SendMailTarget,
): MailTransport {
  if (typeof target?.sendMail !== 'function')
    throw new MailError(
      'TRANSPORT_FAILED',
      `${name} needs an object with sendMail()`,
    );
  return Object.freeze({
    name,
    async send(message: NormalizedMailMessage): Promise<MailSendResult> {
      return {
        id: messageId(await target.sendMail(toSendMailOptions(message))),
      };
    },
  });
}
/**
 * Deliver through a nodemailer transporter the host already configured
 * (SMTP, SES, ...). Nestvexa never opens connections or holds credentials.
 */
export function nodemailerTransport(
  transporter: SendMailTarget,
): MailTransport {
  return sendMailTransport('nodemailer', transporter);
}
/**
 * Deliver through `@nestjs-modules/mailer`'s `MailerService` (inject it in
 * `MailModule.forRootAsync`). Nestvexa renders; the mailer module delivers.
 */
export function nestMailerTransport(mailer: SendMailTarget): MailTransport {
  return sendMailTransport('@nestjs-modules/mailer', mailer);
}
