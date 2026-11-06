import { MailError } from './errors.js';
import { decodeHtmlEntities, htmlToText } from './message.js';

export type MailViewHelper = (...args: unknown[]) => unknown;
/**
 * The part of a Nestvexa `ViewEngineAdapter` (`@nestvexa/views`) mail rendering
 * needs. `HbsEngine`, `EjsEngine`, `PugEngine` and `NunjucksEngine` satisfy it
 * structurally, so this package has no view-engine dependency.
 */
export interface MailViewRenderer {
  render(
    view: string,
    model: Readonly<Record<string, unknown>>,
    options?: {
      readonly layout?: string | false;
      readonly helpers?: Readonly<Record<string, MailViewHelper>>;
    },
  ): Promise<string>;
}

export interface MailTemplatesOptions {
  readonly renderer: MailViewRenderer;
  /** View directory of the mail templates, relative to the engine root. Default `emails`. */
  readonly directory?: string;
  /**
   * Layout of the HTML part, for example `emails/layout` (receives `{{{body}}}`
   * like page layouts). Default `false`: the application's page layout is
   * never applied to mail.
   */
  readonly layout?: string | false;
  /**
   * `template` (default): every mail has a `<name>.text` view. `derive`: the
   * text part is generated from the HTML. Overridable per render.
   */
  readonly text?: 'template' | 'derive';
}

export interface MailRenderOptions {
  /**
   * BCP 47 locale exposed to the templates as `locale` and `i18n.locale` (where
   * `@nestvexa/i18n` helpers read it) unless the model sets `i18n` itself.
   */
  readonly locale?: string;
  /** Per-render helpers, for example locale-bound `t`/`formatDate` from `@nestvexa/i18n`. */
  readonly helpers?: Readonly<Record<string, MailViewHelper>>;
  readonly text?: 'template' | 'derive';
}

export interface RenderedMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const templateName = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const directoryName =
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/;
const locale = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;

/**
 * Renders `<directory>/<name>.subject`, `<name>.html` and `<name>.text` views
 * through the application's view engine. HTML output keeps the engine's
 * escaping; the subject and text parts are plain text, so the escapes the
 * engine applied are decoded there, and the subject is folded to one line so a
 * value can never start a new header.
 */
export class MailTemplates {
  readonly #renderer: MailViewRenderer;
  readonly #directory: string;
  readonly #layout: string | false;
  readonly #text: 'template' | 'derive';
  constructor(options: MailTemplatesOptions) {
    if (typeof options?.renderer?.render !== 'function')
      throw new MailError('TEMPLATE_FAILED', 'A view renderer is required');
    const directory = options.directory ?? 'emails';
    if (!directoryName.test(directory))
      throw new MailError('TEMPLATE_FAILED', 'Invalid mail template directory');
    if (
      options.layout !== undefined &&
      options.layout !== false &&
      !directoryName.test(options.layout)
    )
      throw new MailError('TEMPLATE_FAILED', 'Invalid mail layout');
    this.#renderer = options.renderer;
    this.#directory = directory;
    this.#layout = options.layout ?? false;
    this.#text = options.text ?? 'template';
  }

  async render(
    name: string,
    model: Readonly<Record<string, unknown>> = {},
    options: MailRenderOptions = {},
  ): Promise<RenderedMail> {
    if (typeof name !== 'string' || !templateName.test(name))
      throw new MailError('TEMPLATE_FAILED', 'Invalid mail template name');
    if (options.locale !== undefined && !locale.test(options.locale))
      throw new MailError('TEMPLATE_FAILED', 'Invalid locale');
    const view = `${this.#directory}/${name}`;
    // `i18n.locale` is where `@nestvexa/i18n` helpers read the render locale.
    const data =
      options.locale === undefined
        ? { ...model }
        : {
            i18n: { locale: options.locale },
            ...model,
            locale: options.locale,
          };
    const plain = {
      layout: false as const,
      ...(options.helpers === undefined ? {} : { helpers: options.helpers }),
    };
    try {
      const [subject, html] = await Promise.all([
        this.#renderer.render(`${view}.subject`, data, plain),
        this.#renderer.render(`${view}.html`, data, {
          ...plain,
          layout: this.#layout,
        }),
      ]);
      const text =
        (options.text ?? this.#text) === 'derive'
          ? htmlToText(html)
          : decodeHtmlEntities(
              await this.#renderer.render(`${view}.text`, data, plain),
            ).trim();
      const line = decodeHtmlEntities(subject).replace(/\s+/g, ' ').trim();
      if (!line)
        throw new MailError('TEMPLATE_FAILED', `Empty subject for ${name}`);
      return Object.freeze({ subject: line, html, text });
    } catch (error) {
      if (error instanceof MailError) throw error;
      throw new MailError(
        'TEMPLATE_FAILED',
        `Unable to render mail template ${name}`,
        {
          cause: error,
        },
      );
    }
  }
}
