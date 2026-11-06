import type { SafeHtml, ViewHelper } from '@nestvexa/views';
import { block, call, collect, html } from './call.js';
import type { HelperCall } from './call.js';
import {
  UiError,
  attributes,
  classes,
  escapeHtml,
  flag,
  href,
  id,
  optionalHref,
  optionalId,
  optionalText,
  own,
  text,
} from './html.js';

/*
 * Primitives added in the second UI kit slice: breadcrumbs, badge, alert,
 * accordion, menu button, popover, tooltip, date picker, file uploader,
 * step wizard and data table search/filter/selection. Same rules as the first
 * slice: every attribute and label is escaped, ids and model names use the
 * closed identifier grammar and links are same-origin paths.
 */

function oneOf<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === null) return fallback;
  const match = allowed.find((entry) => entry === value);
  if (match === undefined)
    throw new UiError(
      'ARGUMENT',
      `${name} must be one of ${allowed.join(', ')}`,
    );
  return match;
}
function count(value: unknown, name: string, max = 1_000_000_000): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new UiError('ARGUMENT', `${name} must be a non-negative integer`);
  return value;
}
/** Plain `{ key: value }` records only; accessors and extra keys are rejected. */
function record(
  value: unknown,
  name: string,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new UiError('ARGUMENT', `${name} must be an object`);
  const output: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key))
      throw new UiError('ARGUMENT', `${name} has an unsupported key`);
    output[key] = own(value, key);
  }
  return output;
}
function list(value: unknown, name: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max)
    throw new UiError('ARGUMENT', `${name} must be an array of 1 to ${max}`);
  return value;
}
function joinIds(...ids: (string | undefined)[]): string | undefined {
  const present = ids.filter((entry): entry is string => entry !== undefined);
  return present.length ? present.join(' ') : undefined;
}

// Breadcrumbs ---------------------------------------------------------------
/** APG breadcrumb: `<nav aria-label><ol>` with `aria-current="page"` last. */
function breadcrumbs(...args: unknown[]): SafeHtml {
  const helper = call(args, 'breadcrumbs');
  const label = text(helper.hash['label'], 'label');
  const items = list(
    helper.positional[0] ?? helper.hash['items'],
    'items',
    16,
  ).map((entry) => record(entry, 'breadcrumb', ['label', 'href']));
  const entries = items
    .map((item, index) => {
      const name = escapeHtml(text(item['label'], 'label'));
      const last = index === items.length - 1;
      const link = last
        ? optionalHref(item['href'], 'href')
        : href(item['href'], 'href');
      const content = link
        ? `<a${attributes({ href: link, class: 'nv-breadcrumbs__link', 'aria-current': last ? 'page' : undefined })}>${name}</a>`
        : `<span class="nv-breadcrumbs__current" aria-current="page">${name}</span>`;
      return `<li class="nv-breadcrumbs__item">${content}</li>`;
    })
    .join('');
  return html(
    `<nav class="nv-breadcrumbs"${attributes({ 'aria-label': label })}><ol class="nv-breadcrumbs__list">${entries}</ol></nav>`,
  );
}

// Badge ---------------------------------------------------------------------
const tones = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
/**
 * Text badge or count badge. A count renders the number visually and the
 * `label` (with `{count}`) for assistive technology; `live=true` makes it a
 * polite status region so morph-updated counts are announced.
 */
function badge(...args: unknown[]): SafeHtml {
  const helper = call(args, 'badge');
  const label = text(helper.positional[0] ?? helper.hash['label'], 'label');
  const tone = oneOf(helper.hash['tone'], 'tone', tones, 'neutral');
  const live = flag(helper.hash['live'], 'live');
  const badgeId = optionalId(helper.hash['id'], 'id');
  const rawCount = helper.hash['count'];
  const common = attributes({
    id: badgeId,
    class: 'nv-badge',
    'data-tone': tone,
    role: live ? 'status' : undefined,
  });
  if (rawCount === undefined || rawCount === null)
    return html(`<span${common}>${escapeHtml(label)}</span>`);
  const value = count(rawCount, 'count');
  const max = count(helper.hash['max'] ?? 99, 'max');
  const shown = value > max ? `${max}+` : String(value);
  return html(
    `<span${common}><span class="nv-badge__count" aria-hidden="true">${shown}</span><span class="nv-visually-hidden">${escapeHtml(label.replaceAll('{count}', String(value)))}</span></span>`,
  );
}

// Alert ---------------------------------------------------------------------
/**
 * Inline message. Warning and danger tones use `role="alert"`, info and
 * success `role="status"`; `live=false` renders a static note without a role.
 * `dismissLabel` adds a dismiss button that the browser module reveals.
 */
function alert(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'alert');
  const body = block(helper, 'alert')(this);
  const tone = oneOf(
    helper.hash['tone'],
    'tone',
    ['info', 'success', 'warning', 'danger'],
    'info',
  );
  const alertId = optionalId(helper.hash['id'], 'id');
  const title = optionalText(helper.hash['title'], 'title');
  const dismiss = optionalText(helper.hash['dismissLabel'], 'dismissLabel');
  const live =
    helper.hash['live'] === undefined || flag(helper.hash['live'], 'live');
  const role = !live
    ? undefined
    : tone === 'warning' || tone === 'danger'
      ? 'alert'
      : 'status';
  const titleId = title && alertId ? `${alertId}-title` : undefined;
  return html(
    `<div${attributes({
      id: alertId,
      class: 'nv-alert',
      'data-nv-ui': 'alert',
      'data-tone': tone,
      role,
      'aria-labelledby': titleId,
    })}>${title ? `<p${attributes({ class: 'nv-alert__title', id: titleId })}>${escapeHtml(title)}</p>` : ''}<div class="nv-alert__body">${body}</div>${
      dismiss
        ? `<button type="button" class="nv-alert__dismiss" data-nv-ui-dismiss hidden${attributes({ 'aria-label': dismiss })}><span aria-hidden="true">×</span></button>`
        : ''
    }</div>`,
  );
}

// Accordion -----------------------------------------------------------------
interface AccordionEntry {
  readonly id: string;
  readonly title: string;
  readonly open: boolean;
  readonly body: string;
}
class AccordionCollector {
  readonly items: AccordionEntry[] = [];
}
const accordionKey = 'nvUiAccordion';
function uniqueIds(entries: readonly { readonly id: string }[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new UiError('ID', 'Duplicate item id');
    seen.add(entry.id);
  }
}
function headingLevel(value: unknown, fallback: number): number {
  const level = value ?? fallback;
  if (
    typeof level !== 'number' ||
    !Number.isInteger(level) ||
    level < 2 ||
    level > 6
  )
    throw new UiError('ARGUMENT', 'level must be an integer from 2 to 6');
  return level;
}
/**
 * APG accordion: heading-wrapped buttons with `aria-expanded`/`aria-controls`
 * and labelled panels. Collapsed panels carry `data-nv-ui-collapsed` (not
 * `hidden`), so the content stays readable when scripting is unavailable.
 */
function accordion(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'accordion');
  const accordionId = id(helper.hash['id'], 'id');
  const level = headingLevel(helper.hash['level'], 3);
  const multiple = flag(helper.hash['multiple'], 'multiple');
  const collector = new AccordionCollector();
  collect(helper, 'accordion', this, accordionKey, collector, 'accordionItem');
  if (collector.items.length === 0 || collector.items.length > 32)
    throw new UiError('ARGUMENT', 'Accordion requires 1 to 32 items');
  uniqueIds(collector.items);
  if (!multiple && collector.items.filter((item) => item.open).length > 1)
    throw new UiError(
      'ARGUMENT',
      'Only one item may be open unless multiple=true',
    );
  // APG: avoid region landmarks proliferating when there are many panels.
  const regions = collector.items.length <= 6;
  const items = collector.items
    .map((item) => {
      const trigger = `${accordionId}-${item.id}-trigger`;
      const panel = `${accordionId}-${item.id}-panel`;
      return `<h${level} class="nv-accordion__heading"><button${attributes({
        type: 'button',
        class: 'nv-accordion__trigger',
        id: trigger,
        'aria-expanded': item.open ? 'true' : 'false',
        'aria-controls': panel,
      })}>${escapeHtml(item.title)}<span class="nv-accordion__icon" aria-hidden="true"></span></button></h${level}><div${attributes(
        {
          class: 'nv-accordion__panel',
          id: panel,
          role: regions ? 'region' : undefined,
          'aria-labelledby': trigger,
          'data-nv-ui-collapsed': !item.open,
        },
      )}>${item.body}</div>`;
    })
    .join('');
  return html(
    `<div${attributes({
      class: 'nv-accordion',
      'data-nv-ui': 'accordion',
      id: accordionId,
      'data-nv-ui-multiple': multiple,
    })}>${items}</div>`,
  );
}
function accordionItem(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'accordionItem');
  const fn = block(helper, 'accordionItem');
  const collector = own(helper.data, accordionKey);
  if (!(collector instanceof AccordionCollector))
    throw new UiError(
      'ARGUMENT',
      'An accordion item must be inside an accordion',
    );
  collector.items.push({
    id: id(helper.hash['id'], 'id'),
    title: text(helper.hash['title'], 'title'),
    open: flag(helper.hash['open'], 'open'),
    body: fn(this),
  });
  return html('');
}

// Menu button ---------------------------------------------------------------
interface MenuEntry {
  readonly label: string;
  readonly href: string | undefined;
  readonly action: string | undefined;
  readonly value: string | undefined;
  readonly disabled: boolean;
}
class MenuCollector {
  readonly items: MenuEntry[] = [];
}
const menuKey = 'nvUiMenu';
/**
 * APG menu button: `aria-haspopup="menu"` trigger and a `role="menu"` list of
 * `role="menuitem"` links (`href`), Live action buttons (`action`) or value
 * buttons (`value`, reported through a `nv-ui-menu-select` DOM event).
 */
function menu(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'menu');
  const menuId = id(helper.hash['id'], 'id');
  const label = text(helper.hash['label'], 'label');
  const className = classes(helper.hash['class']);
  const collector = new MenuCollector();
  collect(helper, 'menu', this, menuKey, collector, 'menuItem');
  if (collector.items.length === 0 || collector.items.length > 64)
    throw new UiError('ARGUMENT', 'Menu requires 1 to 64 items');
  const items = collector.items
    .map((item) => {
      const common = {
        role: 'menuitem',
        class: 'nv-menu__item',
        'aria-disabled': item.disabled ? 'true' : undefined,
      };
      const label = escapeHtml(item.label);
      const control =
        item.href !== undefined
          ? `<a${attributes({ ...common, href: item.disabled ? undefined : item.href })}>${label}</a>`
          : `<button${attributes({
              ...common,
              type: 'button',
              'nv:click': item.disabled ? undefined : item.action,
              'data-nv-ui-value': item.value,
            })}>${label}</button>`;
      return `<li role="none">${control}</li>`;
    })
    .join('');
  return html(
    `<div${attributes({
      class: className ? `nv-menu ${className}` : 'nv-menu',
      'data-nv-ui': 'menu',
      id: menuId,
    })}><button${attributes({
      type: 'button',
      class: 'nv-button nv-menu__button',
      id: `${menuId}-button`,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-controls': `${menuId}-menu`,
    })}>${escapeHtml(label)}<span class="nv-menu__icon" aria-hidden="true">▾</span></button><ul${attributes(
      {
        role: 'menu',
        class: 'nv-menu__list',
        id: `${menuId}-menu`,
        'aria-labelledby': `${menuId}-button`,
        'data-nv-ui-collapsed': true,
      },
    )}>${items}</ul></div>`,
  );
}
function menuItem(...args: unknown[]): SafeHtml {
  const helper = call(args, 'menuItem');
  const collector = own(helper.data, menuKey);
  if (!(collector instanceof MenuCollector))
    throw new UiError('ARGUMENT', 'A menu item must be inside a menu');
  const link = optionalHref(helper.hash['href'], 'href');
  const action = optionalId(helper.hash['action'], 'action');
  const value = optionalId(helper.hash['value'], 'value');
  if ([link, action, value].filter((entry) => entry !== undefined).length !== 1)
    throw new UiError(
      'ARGUMENT',
      'Provide exactly one of href, action or value',
    );
  collector.items.push({
    label: text(helper.positional[0] ?? helper.hash['label'], 'label'),
    href: link,
    action,
    value,
    disabled: flag(helper.hash['disabled'], 'disabled'),
  });
  return html('');
}

// Popover -------------------------------------------------------------------
/** Non-modal dialog disclosed by a button (APG disclosure + dialog roles). */
function popover(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'popover');
  const body = block(helper, 'popover')(this);
  const popoverId = id(helper.hash['id'], 'id');
  const label = text(helper.hash['label'], 'label');
  const title = optionalText(helper.hash['title'], 'title');
  const className = classes(helper.hash['class']);
  const trigger = `${popoverId}-trigger`;
  const titleId = title ? `${popoverId}-title` : undefined;
  return html(
    `<div${attributes({
      class: className ? `nv-popover ${className}` : 'nv-popover',
      'data-nv-ui': 'popover',
      id: popoverId,
    })}><button${attributes({
      type: 'button',
      class: 'nv-button nv-popover__trigger',
      id: trigger,
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-controls': `${popoverId}-panel`,
    })}>${escapeHtml(label)}</button><div${attributes({
      class: 'nv-popover__panel',
      id: `${popoverId}-panel`,
      role: 'dialog',
      'aria-labelledby': titleId ?? trigger,
      'data-nv-ui-collapsed': true,
    })}>${title ? `<p class="nv-popover__title" id="${titleId ?? ''}">${escapeHtml(title)}</p>` : ''}${body}</div></div>`,
  );
}

// Tooltip -------------------------------------------------------------------
/**
 * APG tooltip: a button whose description is a `role="tooltip"` element. The
 * description is in the accessibility tree through `aria-describedby` even
 * while the bubble is hidden; the module shows it on hover and focus and hides
 * it on Escape (WCAG 1.4.13). The block body is the button content.
 */
function tooltip(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'tooltip');
  const body = block(helper, 'tooltip')(this);
  const tipId = id(helper.hash['id'], 'id');
  const tip = text(helper.hash['text'], 'text');
  const label = optionalText(helper.hash['label'], 'label');
  const className = classes(helper.hash['class']);
  if (!label && body.replace(/<[^>]*>/g, '').trim() === '')
    throw new UiError(
      'ARGUMENT',
      'A tooltip trigger needs text content or label',
    );
  return html(
    `<span class="nv-tooltip" data-nv-ui="tooltip"><button${attributes({
      type: 'button',
      class: className
        ? `nv-tooltip__trigger ${className}`
        : 'nv-tooltip__trigger',
      'aria-label': label,
      'aria-describedby': tipId,
    })}>${body}</button><span${attributes({ role: 'tooltip', id: tipId, class: 'nv-tooltip__bubble' })} hidden>${escapeHtml(tip)}</span></span>`,
  );
}

// Date picker ---------------------------------------------------------------
const isoPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Strict calendar `YYYY-MM-DD` (the native date input's value format). */
function isoDate(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const match = typeof value === 'string' ? isoPattern.exec(value) : null;
  if (!match) throw new UiError('ARGUMENT', `${name} must be YYYY-MM-DD`);
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new UiError('ARGUMENT', `${name} must be a calendar date`);
  return match[0];
}
function locale(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 35)
    throw new UiError('ARGUMENT', 'locale must be a BCP 47 tag');
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (canonical) return canonical;
  } catch {
    // Reported below without echoing the value.
  }
  throw new UiError('ARGUMENT', 'locale must be a BCP 47 tag');
}
const dateStyles = ['short', 'medium', 'long', 'full'] as const;
/** Format a date-only value in UTC so no time zone can shift the day. */
export function formatDateOnly(
  value: string,
  tag: string,
  style: (typeof dateStyles)[number] = 'long',
): string {
  return new Intl.DateTimeFormat(tag, {
    dateStyle: style,
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}
/**
 * Native `<input type="date">` (the browser supplies the accessible calendar
 * and keyboard behavior) plus an `<output>` with the locale-formatted value.
 * With `model`, a hidden text input carries `nv:model.change` because Live
 * models bind text-like controls only; the module mirrors the date into it.
 */
function datePicker(...args: unknown[]): SafeHtml {
  const helper = call(args, 'datePicker');
  const inputId = id(helper.hash['id'], 'id');
  const model = optionalId(helper.hash['model'], 'model');
  const name =
    model === undefined
      ? id(helper.hash['name'], 'name')
      : optionalId(helper.hash['name'], 'name');
  const label = text(helper.hash['label'], 'label');
  const value = isoDate(helper.hash['value'], 'value');
  const min = isoDate(helper.hash['min'], 'min');
  const max = isoDate(helper.hash['max'], 'max');
  if (min && max && min > max)
    throw new UiError('ARGUMENT', 'min must not exceed max');
  if (value && ((min && value < min) || (max && value > max)))
    throw new UiError('ARGUMENT', 'value must be between min and max');
  const tag = locale(helper.hash['locale']);
  const style = oneOf(
    helper.hash['dateStyle'],
    'dateStyle',
    dateStyles,
    'long',
  );
  const describedBy = optionalId(helper.hash['describedBy'], 'describedBy');
  const required = flag(helper.hash['required'], 'required');
  const formatted = value && tag ? formatDateOnly(value, tag, style) : '';
  const output = `${inputId}-formatted`;
  return html(
    `<div${attributes({
      class: 'nv-date',
      'data-nv-ui': 'date',
      'data-nv-ui-locale': tag,
      'data-nv-ui-date-style': style,
    })}><label class="nv-date__label" for="${inputId}">${escapeHtml(label)}</label><input${attributes(
      {
        id: inputId,
        class: 'nv-date__input',
        type: 'date',
        name: model === undefined ? name : undefined,
        value,
        min,
        max,
        required,
        'aria-describedby': joinIds(describedBy, output),
      },
    )}><output${attributes({
      class: 'nv-date__formatted',
      id: output,
      for: inputId,
      'aria-live': 'polite',
    })}>${escapeHtml(formatted)}</output>${
      model === undefined
        ? ''
        : `<input${attributes({
            type: 'text',
            id: `${inputId}-value`,
            name,
            value: value ?? '',
            hidden: true,
            tabindex: '-1',
            autocomplete: 'off',
            'data-nv-ui-date-value': true,
            'nv:model.change': model,
          })}>`
    }</div>`,
  );
}

// File uploader -------------------------------------------------------------
const acceptToken =
  /^(?:\.[A-Za-z0-9]{1,16}|[a-z]+\/(?:\*|[A-Za-z0-9.+-]{1,64}))$/;
function accept(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512)
    throw new UiError('ARGUMENT', 'accept must be file type tokens');
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.length > 32 || tokens.some((token) => !acceptToken.test(token)))
    throw new UiError('ARGUMENT', 'accept must be file type tokens');
  return tokens.join(',');
}
/**
 * File input with an optional drop zone and an accessible selection summary.
 * Without `model` it is a plain named input for native multipart forms (for
 * example `UploadsService.receiveForm`). With `model` it emits the Live upload
 * directives (`nv:upload`, `nv:upload.progress`, `nv:upload.status`,
 * `nv:upload.cancel`) that `@nestvexa/client` drives against
 * `@nestvexa/uploads`; this package imports neither.
 */
function fileUpload(...args: unknown[]): SafeHtml {
  const helper = call(args, 'fileUpload');
  const inputId = id(helper.hash['id'], 'id');
  const model = optionalId(helper.hash['model'], 'model');
  const name =
    model === undefined
      ? id(helper.hash['name'], 'name')
      : optionalId(helper.hash['name'], 'name');
  const label = text(helper.hash['label'], 'label');
  const types = accept(helper.hash['accept']);
  const multiple = flag(helper.hash['multiple'], 'multiple');
  const required = flag(helper.hash['required'], 'required');
  const hint = optionalText(helper.hash['hint'], 'hint');
  const drop = optionalText(helper.hash['dropLabel'], 'dropLabel');
  const selected = text(helper.hash['selectedLabel'], 'selectedLabel');
  const progressLabel =
    model === undefined
      ? undefined
      : text(helper.hash['progressLabel'], 'progressLabel');
  const cancel =
    model === undefined
      ? undefined
      : text(helper.hash['cancelLabel'], 'cancelLabel');
  const hintId = hint ? `${inputId}-hint` : undefined;
  const statusId = `${inputId}-selection`;
  const live =
    model === undefined
      ? ''
      : `<progress${attributes({
          class: 'nv-upload__progress',
          'nv:upload.progress': model,
          value: 0,
          max: 1,
          'aria-label': progressLabel,
        })}></progress><p${attributes({
          class: 'nv-upload__live-status',
          id: `${inputId}-status`,
          role: 'status',
          'nv:upload.status': model,
        })}></p><button${attributes({
          type: 'button',
          class: 'nv-button nv-upload__cancel',
          'nv:upload.cancel': model,
        })}>${escapeHtml(cancel ?? '')}</button>`;
  return html(
    `<div${attributes({
      class: 'nv-upload',
      'data-nv-ui': 'upload',
      'data-nv-ui-selected-label': selected,
    })}><label class="nv-upload__label" for="${inputId}">${escapeHtml(label)}</label>${
      hint
        ? `<p class="nv-upload__hint" id="${hintId ?? ''}">${escapeHtml(hint)}</p>`
        : ''
    }${drop ? `<div class="nv-upload__drop" data-nv-ui-drop hidden>${escapeHtml(drop)}</div>` : ''}<input${attributes(
      {
        id: inputId,
        class: 'nv-upload__input',
        type: 'file',
        name: model === undefined ? name : undefined,
        accept: types,
        multiple,
        required,
        'aria-describedby': joinIds(
          hintId,
          statusId,
          model === undefined ? undefined : `${inputId}-status`,
        ),
        'nv:upload': model,
      },
    )}><ul class="nv-upload__files" data-nv-ui-files></ul><p${attributes({
      class: 'nv-upload__selection',
      id: statusId,
      role: 'status',
      'data-nv-ui-upload-status': true,
    })}></p>${live}</div>`,
  );
}

// Step wizard ---------------------------------------------------------------
interface StepEntry {
  readonly id: string;
  readonly title: string;
  readonly href: string | undefined;
  readonly body: string;
}
class StepCollector {
  readonly steps: StepEntry[] = [];
}
const stepKey = 'nvUiWizard';
/**
 * Server-driven multi-step form shell: an ordered step list with
 * `aria-current="step"`, completed steps announced through a visually hidden
 * suffix (optionally linked back with `href`) and only the current step's body.
 * The module moves focus to the step heading when a Live morph changes step.
 */
function wizard(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'wizard');
  const wizardId = id(helper.hash['id'], 'id');
  const label = text(helper.hash['label'], 'label');
  const stepLabel = text(helper.hash['stepLabel'], 'stepLabel');
  const completed = text(helper.hash['completedLabel'], 'completedLabel');
  const level = headingLevel(helper.hash['level'], 2);
  const collector = new StepCollector();
  collect(helper, 'wizard', this, stepKey, collector, 'wizardStep');
  if (collector.steps.length < 2 || collector.steps.length > 16)
    throw new UiError('ARGUMENT', 'Wizard requires 2 to 16 steps');
  uniqueIds(collector.steps);
  const current = id(helper.hash['current'], 'current');
  const index = collector.steps.findIndex((step) => step.id === current);
  const active = collector.steps[index];
  if (!active) throw new UiError('ARGUMENT', 'current must name a step');
  const total = collector.steps.length;
  const steps = collector.steps
    .map((step, position) => {
      const state =
        position < index
          ? 'complete'
          : position === index
            ? 'current'
            : 'upcoming';
      const title = escapeHtml(step.title);
      const number = `<span class="nv-wizard__number" aria-hidden="true">${position + 1}</span>`;
      const content =
        state === 'complete'
          ? `${number}${step.href ? `<a class="nv-wizard__link" href="${escapeHtml(step.href)}">${title}</a>` : `<span>${title}</span>`}<span class="nv-visually-hidden"> (${escapeHtml(completed)})</span>`
          : `${number}<span>${title}</span>`;
      return `<li${attributes({
        class: 'nv-wizard__step',
        'data-state': state,
        'aria-current': state === 'current' ? 'step' : undefined,
      })}>${content}</li>`;
    })
    .join('');
  const heading = `${stepLabel
    .replaceAll('{step}', String(index + 1))
    .replaceAll('{total}', String(total))}: ${active.title}`;
  return html(
    `<div${attributes({
      class: 'nv-wizard',
      'data-nv-ui': 'wizard',
      id: wizardId,
      'data-nv-ui-current': active.id,
    })}><nav class="nv-wizard__nav"${attributes({ 'aria-label': label })}><ol class="nv-wizard__steps">${steps}</ol></nav><section class="nv-wizard__panel" aria-labelledby="${wizardId}-heading"><h${level} class="nv-wizard__heading" id="${wizardId}-heading" tabindex="-1">${escapeHtml(heading)}</h${level}>${active.body}</section></div>`,
  );
}
function wizardStep(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'wizardStep');
  const fn = block(helper, 'wizardStep');
  const collector = own(helper.data, stepKey);
  if (!(collector instanceof StepCollector))
    throw new UiError('ARGUMENT', 'A wizard step must be inside a wizard');
  collector.steps.push({
    id: id(helper.hash['id'], 'id'),
    title: text(helper.hash['title'], 'title'),
    href: optionalHref(helper.hash['href'], 'href'),
    body: fn(this),
  });
  return html('');
}

// Data table ----------------------------------------------------------------
/**
 * Table shell for search, filter and row selection: a captioned
 * `<table class="nv-table">` around the block body plus a status line that
 * announces selection and client-side filter counts.
 */
function dataTable(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'dataTable');
  const body = block(helper, 'dataTable')(this);
  const tableId = id(helper.hash['id'], 'id');
  const caption = text(helper.hash['caption'], 'caption');
  const selection = optionalText(
    helper.hash['selectionLabel'],
    'selectionLabel',
  );
  const className = classes(helper.hash['class']);
  return html(
    `<div${attributes({
      class: 'nv-data-table',
      'data-nv-ui': 'data-table',
      'data-nv-ui-selection-label': selection,
    })}><table${attributes({
      id: tableId,
      class: className ? `nv-table ${className}` : 'nv-table',
      'aria-describedby': `${tableId}-status`,
    })}><caption class="nv-table__caption">${escapeHtml(caption)}</caption>${body}</table><p class="nv-data-table__status" id="${tableId}-status" role="status" data-nv-ui-table-status></p></div>`,
  );
}
/** Wire a control to a table: client-side filtering and/or a Live model. */
function tableControl(
  helper: HelperCall,
  suffix: string,
): {
  readonly table: string;
  readonly client: boolean;
  readonly controlId: string;
  readonly name: string | undefined;
  readonly model: string | undefined;
} {
  const table = id(helper.hash['table'], 'table');
  const client = flag(helper.hash['client'], 'client');
  const model = optionalId(helper.hash['model'], 'model');
  if (client && model)
    throw new UiError('ARGUMENT', 'Use either client filtering or a model');
  return {
    table,
    client,
    controlId: optionalId(helper.hash['id'], 'id') ?? `${table}-${suffix}`,
    name: optionalId(helper.hash['name'], 'name'),
    model,
  };
}
/**
 * Search box for a table: `role="search"` with a labelled `type="search"`
 * input. `client=true` filters the rendered rows in the browser; `model`
 * binds a debounced Live model so the server filters; `name` submits it in a
 * GET form.
 */
function tableSearch(...args: unknown[]): SafeHtml {
  const helper = call(args, 'tableSearch');
  const control = tableControl(helper, 'search');
  const label = text(helper.hash['label'], 'label');
  const results = optionalText(helper.hash['resultsLabel'], 'resultsLabel');
  if (control.client && !results)
    throw new UiError('ARGUMENT', 'Client filtering needs resultsLabel');
  const value = optionalText(helper.hash['value'], 'value', 256) ?? '';
  const placeholder = optionalText(helper.hash['placeholder'], 'placeholder');
  return html(
    `<div class="nv-table-search" role="search"><label class="nv-table-search__label" for="${control.controlId}">${escapeHtml(label)}</label><input${attributes(
      {
        id: control.controlId,
        class: 'nv-table-search__input',
        type: 'search',
        name: control.name,
        value,
        placeholder,
        autocomplete: 'off',
        'aria-controls': control.table,
        'data-nv-ui-filter-table': control.client ? control.table : undefined,
        'data-nv-ui-results-label': results,
        'nv:model.live.debounce.300ms': control.model,
      },
    )}></div>`,
  );
}
const filterKey = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * Native `<select>` filter. With `client=true` rows are matched against their
 * `data-{key}` attribute; with `model` the Live server filters (`nv:model.change`).
 */
function tableFilter(...args: unknown[]): SafeHtml {
  const helper = call(args, 'tableFilter');
  const control = tableControl(helper, 'filter');
  const key = helper.hash['key'];
  if (typeof key !== 'string' || !filterKey.test(key))
    throw new UiError('ID', 'key must match [a-z][a-z0-9-]{0,31}');
  const label = text(helper.hash['label'], 'label');
  const all = text(helper.hash['allLabel'], 'allLabel');
  const results = optionalText(helper.hash['resultsLabel'], 'resultsLabel');
  if (control.client && !results)
    throw new UiError('ARGUMENT', 'Client filtering needs resultsLabel');
  const value = optionalText(helper.hash['value'], 'value', 256) ?? '';
  const seen = new Set<string>();
  const options = list(helper.hash['options'], 'options', 200)
    .map((entry) => {
      const option = record(entry, 'option', ['value', 'label']);
      const optionValue = text(option['value'], 'option value', 256);
      if (seen.has(optionValue))
        throw new UiError('ARGUMENT', 'Duplicate option value');
      seen.add(optionValue);
      return `<option${attributes({ value: optionValue, selected: optionValue === value })}>${escapeHtml(text(option['label'], 'label'))}</option>`;
    })
    .join('');
  if (value && !seen.has(value))
    throw new UiError('ARGUMENT', 'value must be one of the options');
  const controlId =
    optionalId(helper.hash['id'], 'id') ?? `${control.table}-${key}`;
  return html(
    `<div class="nv-table-filter"><label class="nv-table-filter__label" for="${controlId}">${escapeHtml(label)}</label><select${attributes(
      {
        id: controlId,
        class: 'nv-table-filter__select',
        name: control.name,
        'aria-controls': control.table,
        'data-nv-ui-filter-table': control.client ? control.table : undefined,
        'data-nv-ui-filter-key': control.client ? key : undefined,
        'data-nv-ui-results-label': results,
        'nv:model.change': control.model,
      },
    )}><option${attributes({ value: '', selected: value === '' })}>${escapeHtml(all)}</option>${options}</select></div>`,
  );
}
/** Header cell with a select-all checkbox (mixed state managed by the module). */
function selectAll(...args: unknown[]): SafeHtml {
  const helper = call(args, 'selectAll');
  const table = id(helper.hash['table'], 'table');
  const label = text(helper.hash['label'], 'label');
  return html(
    `<th scope="col" class="nv-table__select"><input${attributes({
      type: 'checkbox',
      class: 'nv-table__checkbox',
      'aria-label': label,
      'aria-controls': table,
      'data-nv-ui-select-all': table,
    })}></th>`,
  );
}
/** Row cell with a named checkbox, so a native form posts the selected values. */
function selectRow(...args: unknown[]): SafeHtml {
  const helper = call(args, 'selectRow');
  const name = id(helper.hash['name'], 'name');
  const value = text(helper.hash['value'], 'value', 256);
  const label = text(helper.hash['label'], 'label');
  const checked = flag(helper.hash['checked'], 'checked');
  return html(
    `<td class="nv-table__select"><input${attributes({
      type: 'checkbox',
      class: 'nv-table__checkbox',
      name,
      value,
      checked,
      'aria-label': label,
      'data-nv-ui-select-row': true,
    })}></td>`,
  );
}

export const primitiveHelpers: readonly (readonly [string, ViewHelper])[] =
  Object.freeze([
    ['Breadcrumbs', breadcrumbs],
    ['Badge', badge],
    ['Alert', alert],
    ['Accordion', accordion],
    ['AccordionItem', accordionItem],
    ['Menu', menu],
    ['MenuItem', menuItem],
    ['Popover', popover],
    ['Tooltip', tooltip],
    ['DatePicker', datePicker],
    ['FileUpload', fileUpload],
    ['Wizard', wizard],
    ['WizardStep', wizardStep],
    ['DataTable', dataTable],
    ['TableSearch', tableSearch],
    ['TableFilter', tableFilter],
    ['SelectAll', selectAll],
    ['SelectRow', selectRow],
  ]);
