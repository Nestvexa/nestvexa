import type { SafeHtml, ViewHelper } from '@nestvexa/views';
import { block, call, html } from './call.js';
import {
  chartMarkup,
  checkboxFieldMarkup,
  dialogMarkup,
  dialogTriggerMarkup,
  radioGroupFieldMarkup,
  renderMarkup,
  selectFieldMarkup,
  sortHeaderMarkup,
  tabPanelSlot,
  tabsMarkup,
  textFieldMarkup,
  textareaFieldMarkup,
  toastRegionMarkup,
} from './markup.js';
import type { MarkupElement, MarkupInput } from './markup.js';
import { primitiveHelpers } from './primitives.js';
import {
  UiError,
  attributes,
  escapeHtml,
  flag,
  href,
  id,
  optionalId,
  optionalText,
  own,
  text,
} from './html.js';

/** Modal dialog markup shared by uiDialog and uiDrawer (a side-anchored dialog). */
function modal(
  context: unknown,
  args: readonly unknown[],
  name: string,
  drawer: boolean,
): SafeHtml {
  const helper = call(args, name);
  const body = block(helper, name)(context);
  return html(renderMarkup(dialogMarkup({ ...helper.hash, drawer }), { body }));
}
function dialog(this: unknown, ...args: unknown[]): SafeHtml {
  return modal(this, args, 'dialog', false);
}
function drawer(this: unknown, ...args: unknown[]): SafeHtml {
  return modal(this, args, 'drawer', true);
}

function dialogTrigger(...args: unknown[]): SafeHtml {
  const helper = call(args, 'dialogTrigger');
  return html(
    renderMarkup(
      dialogTriggerMarkup({
        ...helper.hash,
        target: helper.positional[0] ?? helper.hash['target'],
      }),
    ),
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
  const slots: Record<string, string> = {};
  for (const entry of collector.tabs)
    slots[tabPanelSlot(entry.id)] = entry.body;
  return html(
    renderMarkup(
      tabsMarkup({
        id: helper.hash['id'],
        label: helper.hash['label'],
        tabs: collector.tabs.map((entry) => ({
          id: entry.id,
          label: entry.label,
          selected: entry.selected,
        })),
      }),
      slots,
    ),
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
  return html(renderMarkup(toastRegionMarkup(helper.hash)));
}

function sortHeader(...args: unknown[]): SafeHtml {
  const helper = call(args, 'sortHeader');
  return html(renderMarkup(sortHeaderMarkup(helper.hash)));
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

/** Inline helper printing one contract builder from the template hash. */
function inline(
  name: string,
  build: (input: MarkupInput) => MarkupElement,
): (...args: unknown[]) => SafeHtml {
  return (...args: unknown[]) =>
    html(renderMarkup(build(call(args, name).hash)));
}

/**
 * Chart (see `chartMarkup`). As a block with `type="custom"`, the body is
 * the third-party chart's mount point (for example a `<canvas>`).
 */
function chart(this: unknown, ...args: unknown[]): SafeHtml {
  const helper = call(args, 'chart');
  const body = helper.fn ? helper.fn(this) : '';
  if (body.trim() !== '' && helper.hash['type'] !== 'custom')
    throw new UiError('ARGUMENT', 'Only a custom chart takes a block body');
  return html(renderMarkup(chartMarkup(helper.hash), { chart: body }));
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
  const entries: (readonly [string, ViewHelper])[] = [
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
    ['Drawer', drawer],
    ['TextField', inline('textField', textFieldMarkup)],
    ['TextareaField', inline('textareaField', textareaFieldMarkup)],
    ['SelectField', inline('selectField', selectFieldMarkup)],
    ['CheckboxField', inline('checkboxField', checkboxFieldMarkup)],
    ['RadioGroupField', inline('radioGroupField', radioGroupFieldMarkup)],
    ['Chart', chart],
    ...primitiveHelpers,
  ];
  const helpers: Record<string, ViewHelper> = {};
  for (const [name, helper] of entries) helpers[prefix + name] = helper;
  return Object.freeze(helpers);
}
