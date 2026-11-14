import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
} from '@nestjs/common';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import type { CircuitBreakerOptions } from './circuit-breaker.js';
import { MailError } from './errors.js';
import { normalizeMailMessage } from './message.js';
import type {
  MailAddress,
  MailLimits,
  MailMessage,
  MailRecipients,
  NormalizedMailMessage,
} from './message.js';
import { MailTemplates } from './templates.js';
import type { MailRenderOptions, MailTemplatesOptions } from './templates.js';
import type { MailTransport } from './transports.js';

export const MAIL_OPTIONS: unique symbol = Symbol('nestvexa:mail-options');

/** Outcome of one send, without message content (safe to log). */
export interface MailDeliveryEvent {
  readonly id?: string;
  readonly transport: string;
  readonly template?: string;
  readonly recipients: number;
  readonly ok: boolean;
  /**
   * `TRANSPORT_FAILED`, `TRANSPORT_TIMEOUT` (no outcome within
   * `sendTimeoutMs`) or `CIRCUIT_OPEN` (failed fast, the transport was not
   * called).
   */
  readonly error?: string;
}

export interface MailModuleOptions {
  readonly transport: MailTransport;
  /** Default sender. */
  readonly from?: MailAddress;
  /** Enables `sendTemplate`. Pass options or a prepared `MailTemplates`. */
  readonly templates?: MailTemplates | MailTemplatesOptions;
  readonly limits?: MailLimits;
  /** Observability hook: ids, counts and closed codes only. A throwing hook is ignored. */
  readonly onDelivery?: (event: MailDeliveryEvent) => void;
  /**
   * A transport that has not answered after this long fails the send with
   * `TRANSPORT_FAILED`. The transport call cannot be cancelled, so the
   * message may still be delivered later: do not retry blindly. Default
   * 30000 (100-600000).
   */
  readonly sendTimeoutMs?: number;
  /**
   * Fail fast while the transport is down: after `failureThreshold` (default
   * 5) consecutive failed or timed-out sends, sends fail with
   * `TRANSPORT_FAILED` without calling the transport for `cooldownMs`
   * (default 10000), then one probe send decides. `false` disables it.
   */
  readonly circuitBreaker?: CircuitBreakerOptions | false;
}

/** Rejection of a send that outlived `sendTimeoutMs`. */
class MailTimeout extends Error {
  constructor() {
    super('Mail transport timed out');
    this.name = 'MailTimeout';
  }
}

export interface MailDelivery {
  readonly id: string;
  readonly transport: string;
  readonly message: NormalizedMailMessage;
}

export interface TemplateMail extends MailRenderOptions {
  readonly from?: MailAddress;
  readonly to: MailRecipients;
  readonly cc?: MailRecipients;
  readonly bcc?: MailRecipients;
  readonly replyTo?: MailAddress;
  readonly headers?: Readonly<Record<string, string>>;
  /** Public template data. Values are escaped by the engine in the HTML part. */
  readonly model?: Readonly<Record<string, unknown>>;
}

/** Validates, renders and hands mail to the configured transport. */
@Injectable()
export class Mailer {
  readonly #options: MailModuleOptions;
  readonly #templates: MailTemplates | undefined;
  readonly #timeout: number;
  readonly #breaker: CircuitBreaker | undefined;
  constructor(@Inject(MAIL_OPTIONS) options: MailModuleOptions) {
    if (typeof options?.transport?.send !== 'function')
      throw new MailError('TRANSPORT_FAILED', 'A mail transport is required');
    this.#options = options;
    const timeout = options.sendTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 600_000)
      throw new MailError(
        'INVALID_MESSAGE',
        'sendTimeoutMs must be an integer from 100 to 600000',
      );
    this.#timeout = timeout;
    this.#breaker =
      options.circuitBreaker === false
        ? undefined
        : new CircuitBreaker(
            `Mail transport ${options.transport.name}`,
            options.circuitBreaker,
          );
    this.#templates =
      options.templates === undefined ||
      options.templates instanceof MailTemplates
        ? options.templates
        : new MailTemplates(options.templates);
    // Validate the default sender at startup rather than on the first send.
    if (options.from !== undefined)
      normalizeMailMessage(
        {
          from: options.from,
          to: options.from,
          subject: 'startup check',
          text: '',
        },
        {},
        options.limits,
      );
  }

  get transport(): string {
    return this.#options.transport.name;
  }

  /** Current breaker state (`closed` when the breaker is disabled). */
  get circuit(): 'closed' | 'open' | 'half-open' {
    return this.#breaker?.state ?? 'closed';
  }

  async send(message: MailMessage): Promise<MailDelivery> {
    return this.#deliver(
      normalizeMailMessage(
        message,
        this.#options.from === undefined ? {} : { from: this.#options.from },
        this.#options.limits,
      ),
    );
  }

  /** Render `emails/<template>.{subject,html,text}` and send it. */
  async sendTemplate(
    template: string,
    mail: TemplateMail,
  ): Promise<MailDelivery> {
    if (!this.#templates)
      throw new MailError(
        'TEMPLATE_FAILED',
        'MailModule was configured without templates',
      );
    const rendered = await this.#templates.render(template, mail.model ?? {}, {
      ...(mail.locale === undefined ? {} : { locale: mail.locale }),
      ...(mail.helpers === undefined ? {} : { helpers: mail.helpers }),
      ...(mail.text === undefined ? {} : { text: mail.text }),
    });
    const message = normalizeMailMessage(
      {
        ...(mail.from === undefined ? {} : { from: mail.from }),
        to: mail.to,
        ...(mail.cc === undefined ? {} : { cc: mail.cc }),
        ...(mail.bcc === undefined ? {} : { bcc: mail.bcc }),
        ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
        ...(mail.headers === undefined ? {} : { headers: mail.headers }),
        ...rendered,
      },
      this.#options.from === undefined ? {} : { from: this.#options.from },
      this.#options.limits,
    );
    return this.#deliver(message, template);
  }

  async #deliver(
    message: NormalizedMailMessage,
    template?: string,
  ): Promise<MailDelivery> {
    const { transport } = this.#options;
    const base = {
      transport: transport.name,
      ...(template === undefined ? {} : { template }),
      recipients: message.to.length + message.cc.length + message.bcc.length,
    };
    let id: string;
    try {
      const exchange = () => this.#send(message);
      id = await (this.#breaker ? this.#breaker.run(exchange) : exchange());
    } catch (error) {
      this.#report({
        ...base,
        ok: false,
        error:
          error instanceof CircuitOpenError
            ? 'CIRCUIT_OPEN'
            : error instanceof MailTimeout
              ? 'TRANSPORT_TIMEOUT'
              : 'TRANSPORT_FAILED',
      });
      // The cause stays attached for the host's logs; the message names no recipient.
      throw new MailError(
        'TRANSPORT_FAILED',
        `Mail transport ${transport.name} failed`,
        {
          cause: error,
        },
      );
    }
    this.#report({ ...base, id, ok: true });
    return Object.freeze({ id, transport: transport.name, message });
  }

  /** One transport call bounded by `sendTimeoutMs`; resolves the message id. */
  async #send(message: NormalizedMailMessage): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new MailTimeout()), this.#timeout);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.#options.transport.send(message)),
        timeout,
      ]);
      if (typeof result?.id !== 'string' || !result.id)
        throw new TypeError('Transport returned no message id');
      return result.id;
    } finally {
      clearTimeout(timer);
    }
  }

  #report(event: MailDeliveryEvent): void {
    try {
      this.#options.onDelivery?.(event);
    } catch {
      // Observability must not change delivery outcomes.
    }
  }
}

export interface MailModuleAsyncOptions<Dependencies extends unknown[]> {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: readonly (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => MailModuleOptions | Promise<MailModuleOptions>;
  /** Register `Mailer` globally. Default false. */
  readonly global?: boolean;
}

/** Opt-in mail bridge: `Mailer` renders with your view engine and sends with your transport. */
@Module({})
export class MailModule {
  static forRoot(
    options: MailModuleOptions & { readonly global?: boolean },
  ): DynamicModule {
    return {
      module: MailModule,
      global: options.global ?? false,
      providers: [{ provide: MAIL_OPTIONS, useValue: options }, Mailer],
      exports: [Mailer],
    };
  }
  static forRootAsync<Dependencies extends unknown[]>(
    options: MailModuleAsyncOptions<Dependencies>,
  ): DynamicModule {
    if (typeof options?.useFactory !== 'function')
      throw new MailError('TRANSPORT_FAILED', 'useFactory is required');
    const factory = options.useFactory;
    return {
      module: MailModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
      providers: [
        {
          provide: MAIL_OPTIONS,
          useFactory: (...dependencies: unknown[]) =>
            factory(...(dependencies as Dependencies)),
          inject: [...(options.inject ?? [])],
        },
        Mailer,
      ],
      exports: [Mailer],
    };
  }
}
