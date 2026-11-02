import { SafeHtml } from '@nestvexa/views';
import type { ViewHelper } from '@nestvexa/views';
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

/** The subset of the Handlebars helper options object these helpers read. */
interface HelperCall {
  readonly positional: readonly unknown[];
  readonly hash: Readonly<Record<string, unknown>>;
  readonly fn:
    | ((context: unknown, runtime?: { readonly data?: unknown }) => string)
    | undefined;
  readonly data: unknown;
}

function call(args: readonly unknown[], name: string): HelperCall {
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
function block(
  helper: HelperCall,
  name: string,
): NonNullable<HelperCall['fn']> {
  if (!helper.fn)
    throw new UiError('ARGUMENT', `${name} must be used as a block helper`);
  return helper.fn;
}
const html = (value: string): SafeHtml => SafeHtml.trusted(value);

function dialog(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'dialog');
  const body = block(helper, 'dialog')(this);
  const dialogId = id(helper.hash['id'], 'id');
  const title = text(helper.hash['title'], 'title');
  const close = text(helper.hash['closeLabel'], 'closeLabel');
  const describedBy = optionalId(helper.hash['describedBy'], 'describedBy');
  const closeOn = optionalId(helper.hash['closeOn'], 'closeOn');
  const className = classes(helper.hash['class']);
  return html(
    `<dialog${attributes({
      id: dialogId,
      class: className ? `nv-dialog ${className}` : 'nv-dialog',
      'data-nv-ui': 'dialog',
      'aria-labelledby': `${dialogId}-title`,
      'aria-describedby': describedBy,
      'data-nv-ui-close-on': closeOn,
    })}><div class="nv-dialog__header"><h2 class="nv-dialog__title" id="${dialogId}-title">${escapeHtml(title)}</h2><button type="button" class="nv-dialog__close" data-nv-ui-close${attributes({ 'aria-label': close })}><span aria-hidden="true">×</span></button></div><div class="nv-dialog__body">${body}</div></dialog>`,
  );
}

function dialogTrigger(...args: unknown[]): SafeHtml {
  const helper = call(args, 'dialogTrigger');
  const target = id(helper.positional[0] ?? helper.hash['target'], 'dialog id');
  const label = text(helper.hash['label'], 'label');
  const link = optionalHref(helper.hash['href'], 'href');
  const className = classes(helper.hash['class']);
  const common = {
    class: className ? `nv-button ${className}` : 'nv-button',
    'data-nv-ui-open': target,
    'aria-haspopup': 'dialog',
    'aria-controls': target,
  };
  return html(
    link
      ? `<a${attributes({ href: link, role: 'button', ...common })}>${escapeHtml(label)}</a>`
      : `<button${attributes({ type: 'button', ...common })}>${escapeHtml(label)}</button>`,
  );
}

interface TabEntry {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
  readonly body: string;
}
/** Private collector type: templates cannot construct or forge one. */
class TabCollector {
  readonly tabs: TabEntry[] = [];
}
const collectorKey = 'nvUiTabs';

function tabs(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'tabs');
  const fn = block(helper, 'tabs');
  const tabsId = id(helper.hash['id'], 'id');
  const label = text(helper.hash['label'], 'label');
  const collector = new TabCollector();
  const parent =
    helper.data !== null && typeof helper.data === 'object' ? helper.data : {};
  const frame = { ...parent, _parent: parent, [collectorKey]: collector };
  const rest = fn(this, { data: frame });
  if (rest.trim() !== '')
    throw new UiError(
      'ARGUMENT',
      'Only tab blocks may appear directly inside a tabs block',
    );
  if (collector.tabs.length === 0 || collector.tabs.length > 32)
    throw new UiError('ARGUMENT', 'Tabs require 1 to 32 tab blocks');
  const seen = new Set<string>();
  for (const tab of collector.tabs) {
    if (seen.has(tab.id)) throw new UiError('ID', 'Duplicate tab id');
    seen.add(tab.id);
  }
  const chosen = collector.tabs.filter((tab) => tab.selected);
  if (chosen.length > 1)
    throw new UiError('ARGUMENT', 'At most one tab may be selected');
  const selected = chosen[0]?.id ?? collector.tabs[0]?.id;
  const buttons = collector.tabs
    .map((tab) => {
      const active = tab.id === selected;
      return `<button${attributes({
        type: 'button',
        role: 'tab',
        class: 'nv-tabs__tab',
        id: `${tabsId}-${tab.id}-tab`,
        'aria-controls': `${tabsId}-${tab.id}-panel`,
        'aria-selected': active ? 'true' : 'false',
        tabindex: active ? '0' : '-1',
      })}>${escapeHtml(tab.label)}</button>`;
    })
    .join('');
  const panels = collector.tabs
    .map(
      (tab) =>
        `<div${attributes({
          role: 'tabpanel',
          class: 'nv-tabs__panel',
          id: `${tabsId}-${tab.id}-panel`,
          'aria-labelledby': `${tabsId}-${tab.id}-tab`,
          tabindex: '0',
          'data-nv-ui-inactive': tab.id !== selected,
        })}>${tab.body}</div>`,
    )
    .join('');
  return html(
    `<div class="nv-tabs" data-nv-ui="tabs" id="${tabsId}"><div class="nv-tabs__list" role="tablist" hidden${attributes({ 'aria-label': label })}>${buttons}</div>${panels}</div>`,
  );
}

function tab(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'tab');
  const fn = block(helper, 'tab');
  const collector = own(helper.data, collectorKey);
  if (!(collector instanceof TabCollector))
    throw new UiError('ARGUMENT', 'A tab block must be inside a tabs block');
  collector.tabs.push({
    id: id(helper.hash['id'], 'id'),
    label: text(helper.hash['label'], 'label'),
    selected: flag(helper.hash['selected'], 'selected'),
    body: fn(this),
  });
  return html('');
}

interface ComboboxOption {
  readonly value: string;
  readonly label: string;
}
function comboboxOptions(value: unknown): readonly ComboboxOption[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new UiError('ARGUMENT', 'options must be an array of up to 500');
  const values = new Set<string>();
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      throw new UiError('ARGUMENT', 'Each option must be { value, label }');
    for (const key of Reflect.ownKeys(entry))
      if (key !== 'value' && key !== 'label')
        throw new UiError('ARGUMENT', 'Each option must be { value, label }');
    const optionValue = text(own(entry, 'value'), 'option value', 256);
    if (values.has(optionValue))
      throw new UiError('ARGUMENT', 'Duplicate option value');
    values.add(optionValue);
    return { value: optionValue, label: text(own(entry, 'label'), 'label') };
  });
}

function combobox(...args: unknown[]): SafeHtml {
  const helper = call(args, 'combobox');
  const boxId = id(helper.hash['id'], 'id');
  const name = id(helper.hash['name'], 'name');
  const label = text(helper.hash['label'], 'label');
  const empty = text(helper.hash['emptyLabel'], 'emptyLabel');
  const count = optionalText(helper.hash['countLabel'], 'countLabel');
  const placeholder = optionalText(helper.hash['placeholder'], 'placeholder');
  const model = optionalId(helper.hash['model'], 'model');
  const required = flag(helper.hash['required'], 'required');
  const describedBy = optionalId(helper.hash['describedBy'], 'describedBy');
  const options = comboboxOptions(helper.hash['options']);
  const rawValue = helper.hash['value'];
  const value =
    rawValue === undefined || rawValue === null || rawValue === ''
      ? ''
      : text(rawValue, 'value', 256);
  const current = options.find((option) => option.value === value);
  if (value && !current)
    throw new UiError('ARGUMENT', 'value must be one of the options');
  const items = options
    .map(
      (option, index) =>
        `<li${attributes({
          role: 'option',
          class: 'nv-combobox__option',
          id: `${boxId}-opt-${index}`,
          'data-value': option.value,
          'aria-selected': option === current ? 'true' : 'false',
        })}>${escapeHtml(option.label)}</li>`,
    )
    .join('');
  return html(
    `<div class="nv-combobox" data-nv-ui="combobox"${attributes({
      'data-nv-ui-empty-label': empty,
      'data-nv-ui-count-label': count,
    })}><label class="nv-combobox__label" for="${boxId}">${escapeHtml(label)}</label><input${attributes(
      {
        id: boxId,
        class: 'nv-combobox__input',
        type: 'text',
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': 'false',
        'aria-controls': `${boxId}-listbox`,
        'aria-describedby': describedBy,
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder,
        required,
        value: current?.label ?? '',
      },
    )}><input${attributes(
      // Live models bind native text controls only (never type="hidden"), so
      // a model-bound value is a text input removed from rendering and the
      // accessibility tree by the `hidden` attribute.
      model === undefined
        ? {
            type: 'hidden',
            id: `${boxId}-value`,
            name,
            value,
            'data-nv-ui-value': true,
          }
        : {
            type: 'text',
            id: `${boxId}-value`,
            name,
            value,
            hidden: true,
            tabindex: '-1',
            autocomplete: 'off',
            'data-nv-ui-value': true,
            'nv:model': model,
          },
    )}><ul${attributes({
      role: 'listbox',
      class: 'nv-combobox__listbox',
      id: `${boxId}-listbox`,
      'aria-label': label,
    })} hidden>${items}</ul><div class="nv-visually-hidden" role="status" data-nv-ui-status></div></div>`,
  );
}

function toastRegion(...args: unknown[]): SafeHtml {
  const helper = call(args, 'toastRegion');
  const regionId = id(helper.hash['id'], 'id');
  const label = text(helper.hash['label'], 'label');
  const dismiss = text(helper.hash['dismissLabel'], 'dismissLabel');
  const event = optionalId(helper.hash['event'], 'event') ?? 'toast';
  const messages = helper.hash['messages'];
  let initial = '';
  if (messages !== undefined && messages !== null) {
    if (!Array.isArray(messages) || messages.length > 5)
      throw new UiError('ARGUMENT', 'messages must be up to 5 strings');
    initial = messages
      .map(
        (message: unknown) =>
          `<li class="nv-toast" data-tone="info"><span class="nv-toast__text">${escapeHtml(text(message, 'message', 500))}</span></li>`,
      )
      .join('');
  }
  return html(
    `<section class="nv-toasts" data-nv-ui="toasts"${attributes({
      id: regionId,
      'aria-label': label,
      'data-nv-ui-event': event,
      'data-nv-ui-dismiss-label': dismiss,
    })}><div class="nv-toasts__live" role="status" aria-live="polite" aria-atomic="false"><ol class="nv-toasts__list" data-nv-ui-list>${initial}</ol></div><div class="nv-toasts__live" role="alert" aria-live="assertive" aria-atomic="false"><ol class="nv-toasts__list" data-nv-ui-alerts></ol></div></section>`,
  );
}

function direction(value: unknown): 'ascending' | 'descending' {
  if (value === undefined || value === null || value === 'asc')
    return 'ascending';
  if (value === 'ascending' || value === 'descending') return value;
  if (value === 'desc') return 'descending';
  throw new UiError('ARGUMENT', 'direction must be asc or desc');
}

function sortHeader(...args: unknown[]): SafeHtml {
  const helper = call(args, 'sortHeader');
  const label = text(helper.hash['label'], 'label');
  const key = id(helper.hash['key'], 'key');
  const sort = helper.hash['sort'];
  const sorted = sort === key;
  const order = direction(helper.hash['direction']);
  const action = optionalId(helper.hash['action'], 'action');
  const link = optionalHref(helper.hash['href'], 'href');
  if ((action === undefined) === (link === undefined))
    throw new UiError('ARGUMENT', 'Provide exactly one of action or href');
  const arrow = sorted ? (order === 'ascending' ? '▲' : '▼') : '↕';
  const content = `${escapeHtml(label)}<span class="nv-sort__icon" aria-hidden="true">${arrow}</span>`;
  const control = action
    ? `<button${attributes({
        type: 'button',
        class: 'nv-sort',
        'nv:click': action,
        'data-nv-ui-sort-key': key,
      })}>${content}</button>`
    : `<a${attributes({ class: 'nv-sort', href: link, 'data-nv-ui-sort-key': key })}>${content}</a>`;
  return html(
    `<th${attributes({ scope: 'col', 'aria-sort': sorted ? order : undefined })}>${control}</th>`,
  );
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new UiError('ARGUMENT', `${name} must be a non-negative integer`);
  return value;
}

function pagination(...args: unknown[]): SafeHtml {
  const helper = call(args, 'pagination');
  const source = helper.positional[0] ?? helper.hash['pagination'];
  if (source === null || typeof source !== 'object' || Array.isArray(source))
    throw new UiError('ARGUMENT', 'pagination must be a Pagination object');
  const page = integer(own(source, 'page'), 'page');
  const pages = integer(own(source, 'pages'), 'pages');
  const previous = own(source, 'previous');
  const next = own(source, 'next');
  const links = own(source, 'links');
  if (!Array.isArray(links) || links.length > 64)
    throw new UiError('ARGUMENT', 'pagination.links must be an array');
  const label = text(helper.hash['label'], 'label');
  const previousLabel = text(helper.hash['previousLabel'], 'previousLabel');
  const nextLabel = text(helper.hash['nextLabel'], 'nextLabel');
  const pageLabel = text(helper.hash['pageLabel'], 'pageLabel');
  const prefix = href(helper.hash['href'], 'href');
  const navigate = flag(helper.hash['navigate'], 'navigate');
  const anchor = (
    target: number,
    content: string,
    extra: Record<string, string | boolean | undefined>,
  ) =>
    `<a${attributes({ href: prefix + String(target), 'nv:navigate': navigate, ...extra })}>${content}</a>`;
  const item = (target: unknown, content: string, className: string) =>
    target === null || target === undefined
      ? `<li class="${className}"><span class="nv-pagination__disabled" aria-disabled="true">${escapeHtml(content)}</span></li>`
      : `<li class="${className}">${anchor(integer(target, 'page'), escapeHtml(content), { rel: className.endsWith('previous') ? 'prev' : 'next' })}</li>`;
  const numbers = links
    .map((entry: unknown) => {
      if (own(entry, 'gap') === true)
        return '<li class="nv-pagination__gap" aria-hidden="true">…</li>';
      const target = integer(own(entry, 'page'), 'page');
      if (target < 1 || target > pages)
        throw new UiError('ARGUMENT', 'page link out of range');
      const accessible = pageLabel.replaceAll('{page}', String(target));
      return `<li>${anchor(target, String(target), {
        'aria-label': accessible,
        'aria-current': target === page ? 'page' : undefined,
      })}</li>`;
    })
    .join('');
  return html(
    `<nav class="nv-pagination"${attributes({ 'aria-label': label })}><ul class="nv-pagination__list">${item(previous, previousLabel, 'nv-pagination__previous')}${numbers}${item(next, nextLabel, 'nv-pagination__next')}</ul></nav>`,
  );
}

function disclosure(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'disclosure');
  const body = block(helper, 'disclosure')(this);
  const summary = text(helper.hash['summary'], 'summary');
  const open = flag(helper.hash['open'], 'open');
  const disclosureId = optionalId(helper.hash['id'], 'id');
  return html(
    `<details${attributes({ class: 'nv-disclosure', id: disclosureId, open })}><summary class="nv-disclosure__summary">${escapeHtml(summary)}</summary><div class="nv-disclosure__body">${body}</div></details>`,
  );
}

function progress(...args: unknown[]): SafeHtml {
  const helper = call(args, 'progress');
  const progressId = id(helper.hash['id'], 'id');
  const label = text(helper.hash['label'], 'label');
  const rawMax = helper.hash['max'] ?? 100;
  if (typeof rawMax !== 'number' || !Number.isFinite(rawMax) || rawMax <= 0)
    throw new UiError('ARGUMENT', 'max must be a positive number');
  const rawValue = helper.hash['value'];
  let value: number | undefined;
  if (rawValue !== undefined && rawValue !== null) {
    if (
      typeof rawValue !== 'number' ||
      !Number.isFinite(rawValue) ||
      rawValue < 0 ||
      rawValue > rawMax
    )
      throw new UiError('ARGUMENT', 'value must be between 0 and max');
    value = rawValue;
  }
  const valueText = optionalText(helper.hash['valueText'], 'valueText');
  return html(
    `<div class="nv-progress"><label class="nv-progress__label" for="${progressId}">${escapeHtml(label)}</label><progress${attributes(
      {
        id: progressId,
        class: 'nv-progress__bar',
        max: rawMax,
        value,
        'aria-valuetext': valueText,
      },
    )}></progress></div>`,
  );
}

function visuallyHidden(...args: unknown[]): SafeHtml {
  const helper = call(args, 'visuallyHidden');
  return html(
    `<span class="nv-visually-hidden">${escapeHtml(text(helper.positional[0], 'text', 2048))}</span>`,
  );
}

/**
 * Trusted HBS helpers for the accessible primitives. Register once with
 * `engine.registerHelpers(uiHelpers())` before initialization.
 */
export function uiHelpers(
  options: { readonly prefix?: string } = {},
): Readonly<Record<string, ViewHelper>> {
  const prefix = options.prefix ?? 'ui';
  if (!/^[a-z][a-zA-Z0-9]{0,15}$/.test(prefix) || prefix === 'nv')
    throw new UiError(
      'ARGUMENT',
      'prefix must be a short lowercase identifier',
    );
  const entries: [string, ViewHelper][] = [
    ['Dialog', dialog],
    ['DialogTrigger', dialogTrigger],
    ['Tabs', tabs],
    ['Tab', tab],
    ['Combobox', combobox],
    ['ToastRegion', toastRegion],
    ['SortHeader', sortHeader],
    ['Pagination', pagination],
    ['Disclosure', disclosure],
    ['Progress', progress],
    ['VisuallyHidden', visuallyHidden],
  ];
  const helpers: Record<string, ViewHelper> = {};
  for (const [name, helper] of entries) helpers[prefix + name] = helper;
  return Object.freeze(helpers);
}
