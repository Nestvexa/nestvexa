/**
 * Framework-neutral markup contract for the main @nestvexa/ui primitives.
 *
 * Each builder validates its input and returns a small element tree. The HBS
 * helpers print the tree with {@link renderMarkup}; the React, Vue and Svelte
 * wrappers (`@nestvexa/ui/react`, `/vue`, `/svelte`) render the same tree with
 * their own element factories, so every renderer emits the same elements,
 * classes, ids and ARIA/data attributes the keyboard module
 * (`@nestvexa/ui/browser`) expects. Browser-safe: no Node or DOM access.
 */
import {
  UiError,
  classes,
  flag,
  id,
  joinIds,
  list,
  localeTag,
  oneOf,
  optionalHref,
  optionalId,
  optionalText,
  record,
  text,
} from './html.js';
import { element, slot } from './tree.js';
import type { MarkupElement, MarkupInput, MarkupNode } from './tree.js';

export {
  booleanAttributes,
  isMarkupSlot,
  renderMarkup,
  voidElements,
} from './tree.js';
export type {
  MarkupAttributeValue,
  MarkupElement,
  MarkupInput,
  MarkupNode,
  MarkupSlot,
} from './tree.js';
export {
  checkboxFieldMarkup,
  fieldInputTypes,
  radioGroupFieldMarkup,
  selectFieldMarkup,
  textFieldMarkup,
  textareaFieldMarkup,
} from './fields.js';
export type { FieldInputType, FieldViewLike } from './fields.js';
export { chartMarkup, chartTypes } from './chart.js';
export type { ChartType } from './chart.js';

// Dialog and drawer ---------------------------------------------------------
/**
 * Native `<dialog>` with a labelled title, a close button and a `body` slot.
 * `drawer: true` adds the side-anchored variant (`side`: `start`|`end`).
 */
export function dialogMarkup(input: MarkupInput): MarkupElement {
  const drawer = flag(input['drawer'], 'drawer');
  const dialogId = id(input['id'], 'id');
  const title = text(input['title'], 'title');
  const close = text(input['closeLabel'], 'closeLabel');
  const describedBy = optionalId(input['describedBy'], 'describedBy');
  const closeOn = optionalId(input['closeOn'], 'closeOn');
  const className = classes(input['class']);
  const side = input['side'] ?? 'end';
  if (drawer && side !== 'start' && side !== 'end')
    throw new UiError('ARGUMENT', 'side must be start or end');
  const base = drawer ? 'nv-dialog nv-drawer' : 'nv-dialog';
  return element(
    'dialog',
    {
      id: dialogId,
      class: className ? `${base} ${className}` : base,
      'data-nv-ui': 'dialog',
      'data-nv-ui-variant': drawer ? 'drawer' : undefined,
      'data-side': drawer ? String(side) : undefined,
      'aria-labelledby': `${dialogId}-title`,
      'aria-describedby': describedBy,
      'data-nv-ui-close-on': closeOn,
    },
    [
      element('div', { class: 'nv-dialog__header' }, [
        element('h2', { class: 'nv-dialog__title', id: `${dialogId}-title` }, [
          title,
        ]),
        element(
          'button',
          {
            type: 'button',
            class: 'nv-dialog__close',
            'data-nv-ui-close': true,
            'aria-label': close,
          },
          [element('span', { 'aria-hidden': 'true' }, ['×'])],
        ),
      ]),
      element('div', { class: 'nv-dialog__body' }, [slot('body')]),
    ],
  );
}

/** Button (or same-origin link) that opens the dialog `target`. */
export function dialogTriggerMarkup(input: MarkupInput): MarkupElement {
  const target = id(input['target'], 'dialog id');
  const label = text(input['label'], 'label');
  const link = optionalHref(input['href'], 'href');
  const className = classes(input['class']);
  const common = {
    class: className ? `nv-button ${className}` : 'nv-button',
    'data-nv-ui-open': target,
    'aria-haspopup': 'dialog',
    'aria-controls': target,
  };
  return link
    ? element('a', { href: link, role: 'button', ...common }, [label])
    : element('button', { type: 'button', ...common }, [label]);
}

// Tabs ----------------------------------------------------------------------
export interface TabMarkupEntry {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
}
/** Slot name of a tab panel. */
export const tabPanelSlot = (tabId: string): string => `panel:${tabId}`;

/**
 * APG tabs: `tabs` is a list of `{ id, label, selected? }`; each panel is the
 * slot {@link tabPanelSlot}(id). The tab list stays `hidden` until the
 * keyboard module takes over, so panels are readable without JavaScript.
 */
export function tabsMarkup(input: MarkupInput): MarkupElement {
  const tabsId = id(input['id'], 'id');
  const label = text(input['label'], 'label');
  const raw = input['tabs'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32)
    throw new UiError('ARGUMENT', 'Tabs require 1 to 32 tab blocks');
  const entries: TabMarkupEntry[] = raw.map((entry: unknown) => {
    const tab = record(entry, 'tab', ['id', 'label', 'selected']);
    return {
      id: id(tab['id'], 'id'),
      label: text(tab['label'], 'label'),
      selected: flag(tab['selected'], 'selected'),
    };
  });
  const seen = new Set<string>();
  for (const tab of entries) {
    if (seen.has(tab.id)) throw new UiError('ID', 'Duplicate tab id');
    seen.add(tab.id);
  }
  const chosen = entries.filter((tab) => tab.selected);
  if (chosen.length > 1)
    throw new UiError('ARGUMENT', 'At most one tab may be selected');
  const selected = chosen[0]?.id ?? entries[0]?.id;
  const buttons = entries.map((tab) => {
    const active = tab.id === selected;
    return element(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: 'nv-tabs__tab',
        id: `${tabsId}-${tab.id}-tab`,
        'aria-controls': `${tabsId}-${tab.id}-panel`,
        'aria-selected': active ? 'true' : 'false',
        tabindex: active ? '0' : '-1',
      },
      [tab.label],
    );
  });
  const panels = entries.map((tab) =>
    element(
      'div',
      {
        role: 'tabpanel',
        class: 'nv-tabs__panel',
        id: `${tabsId}-${tab.id}-panel`,
        'aria-labelledby': `${tabsId}-${tab.id}-tab`,
        tabindex: '0',
        'data-nv-ui-inactive': tab.id !== selected,
      },
      [slot(tabPanelSlot(tab.id))],
    ),
  );
  return element(
    'div',
    { class: 'nv-tabs', 'data-nv-ui': 'tabs', id: tabsId },
    [
      element(
        'div',
        {
          class: 'nv-tabs__list',
          role: 'tablist',
          hidden: true,
          'aria-label': label,
        },
        buttons,
      ),
      ...panels,
    ],
  );
}

// Menu button ---------------------------------------------------------------
/**
 * APG menu button. `items` are `{ label, href?, action?, value?, disabled? }`
 * with exactly one of `href` (link), `action` (Live) or `value` (reported
 * through the `nv-ui-menu-select` DOM event).
 */
export function menuMarkup(input: MarkupInput): MarkupElement {
  const menuId = id(input['id'], 'id');
  const label = text(input['label'], 'label');
  const className = classes(input['class']);
  const raw = input['items'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64)
    throw new UiError('ARGUMENT', 'Menu requires 1 to 64 items');
  const items = raw.map((entry: unknown) => {
    const item = record(entry, 'menu item', [
      'label',
      'href',
      'action',
      'value',
      'disabled',
    ]);
    const link = optionalHref(item['href'], 'href');
    const action = optionalId(item['action'], 'action');
    const value = optionalId(item['value'], 'value');
    if (
      [link, action, value].filter((option) => option !== undefined).length !==
      1
    )
      throw new UiError(
        'ARGUMENT',
        'Provide exactly one of href, action or value',
      );
    const disabled = flag(item['disabled'], 'disabled');
    const common = {
      role: 'menuitem',
      class: 'nv-menu__item',
      'aria-disabled': disabled ? 'true' : undefined,
    };
    const itemLabel = text(item['label'], 'label');
    const control =
      link !== undefined
        ? element('a', { ...common, href: disabled ? undefined : link }, [
            itemLabel,
          ])
        : element(
            'button',
            {
              ...common,
              type: 'button',
              'nv:click': disabled ? undefined : action,
              'data-nv-ui-value': value,
            },
            [itemLabel],
          );
    return element('li', { role: 'none' }, [control]);
  });
  return element(
    'div',
    {
      class: className ? `nv-menu ${className}` : 'nv-menu',
      'data-nv-ui': 'menu',
      id: menuId,
    },
    [
      element(
        'button',
        {
          type: 'button',
          class: 'nv-button nv-menu__button',
          id: `${menuId}-button`,
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          'aria-controls': `${menuId}-menu`,
        },
        [
          label,
          element('span', { class: 'nv-menu__icon', 'aria-hidden': 'true' }, [
            '▾',
          ]),
        ],
      ),
      element(
        'ul',
        {
          role: 'menu',
          class: 'nv-menu__list',
          id: `${menuId}-menu`,
          'aria-labelledby': `${menuId}-button`,
          'data-nv-ui-collapsed': true,
        },
        items,
      ),
    ],
  );
}

// Toasts --------------------------------------------------------------------
/**
 * Toast region with polite (`status`) and assertive (`alert`) live lists.
 * `messages` (up to 5 strings) are rendered as initial info toasts.
 */
export function toastRegionMarkup(input: MarkupInput): MarkupElement {
  const regionId = id(input['id'], 'id');
  const label = text(input['label'], 'label');
  const dismiss = text(input['dismissLabel'], 'dismissLabel');
  const event = optionalId(input['event'], 'event') ?? 'toast';
  const messages = input['messages'];
  let initial: MarkupElement[] = [];
  if (messages !== undefined && messages !== null) {
    if (!Array.isArray(messages) || messages.length > 5)
      throw new UiError('ARGUMENT', 'messages must be up to 5 strings');
    initial = messages.map((message: unknown) =>
      element('li', { class: 'nv-toast', 'data-tone': 'info' }, [
        element('span', { class: 'nv-toast__text' }, [
          text(message, 'message', 500),
        ]),
      ]),
    );
  }
  const live = (role: 'status' | 'alert', list: MarkupElement) =>
    element(
      'div',
      {
        class: 'nv-toasts__live',
        role,
        'aria-live': role === 'status' ? 'polite' : 'assertive',
        'aria-atomic': 'false',
      },
      [list],
    );
  return element(
    'section',
    {
      class: 'nv-toasts',
      'data-nv-ui': 'toasts',
      id: regionId,
      'aria-label': label,
      'data-nv-ui-event': event,
      'data-nv-ui-dismiss-label': dismiss,
    },
    [
      live(
        'status',
        element(
          'ol',
          { class: 'nv-toasts__list', 'data-nv-ui-list': true },
          initial,
        ),
      ),
      live(
        'alert',
        element('ol', { class: 'nv-toasts__list', 'data-nv-ui-alerts': true }),
      ),
    ],
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
const dateStyles = ['short', 'medium', 'long', 'full'] as const;
export type DateStyle = (typeof dateStyles)[number];
/** Format a date-only value in UTC so no time zone can shift the day. */
export function formatDateOnly(
  value: string,
  tag: string,
  style: DateStyle = 'long',
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
export function datePickerMarkup(input: MarkupInput): MarkupElement {
  const inputId = id(input['id'], 'id');
  const model = optionalId(input['model'], 'model');
  const name =
    model === undefined
      ? id(input['name'], 'name')
      : optionalId(input['name'], 'name');
  const label = text(input['label'], 'label');
  const value = isoDate(input['value'], 'value');
  const min = isoDate(input['min'], 'min');
  const max = isoDate(input['max'], 'max');
  if (min && max && min > max)
    throw new UiError('ARGUMENT', 'min must not exceed max');
  if (value && ((min && value < min) || (max && value > max)))
    throw new UiError('ARGUMENT', 'value must be between min and max');
  const tag = localeTag(input['locale']);
  const style = oneOf(input['dateStyle'], 'dateStyle', dateStyles, 'long');
  const describedBy = optionalId(input['describedBy'], 'describedBy');
  const required = flag(input['required'], 'required');
  const formatted = value && tag ? formatDateOnly(value, tag, style) : '';
  const output = `${inputId}-formatted`;
  return element(
    'div',
    {
      class: 'nv-date',
      'data-nv-ui': 'date',
      'data-nv-ui-locale': tag,
      'data-nv-ui-date-style': style,
    },
    [
      element('label', { class: 'nv-date__label', for: inputId }, [label]),
      element('input', {
        id: inputId,
        class: 'nv-date__input',
        type: 'date',
        name: model === undefined ? name : undefined,
        value,
        min,
        max,
        required,
        'aria-describedby': joinIds(describedBy, output),
      }),
      element(
        'output',
        {
          class: 'nv-date__formatted',
          id: output,
          for: inputId,
          'aria-live': 'polite',
        },
        formatted ? [formatted] : [],
      ),
      ...(model === undefined
        ? []
        : [
            element('input', {
              type: 'text',
              id: `${inputId}-value`,
              name,
              value: value ?? '',
              hidden: true,
              tabindex: '-1',
              autocomplete: 'off',
              'data-nv-ui-date-value': true,
              'nv:model.change': model,
            }),
          ]),
    ],
  );
}

// Data table ----------------------------------------------------------------
/**
 * Table wrapper with a caption and a `role="status"` line the module fills
 * with filter and selection counts. The `body` slot holds the table rows.
 */
export function dataTableMarkup(input: MarkupInput): MarkupElement {
  const tableId = id(input['id'], 'id');
  const caption = text(input['caption'], 'caption');
  const selection = optionalText(input['selectionLabel'], 'selectionLabel');
  const className = classes(input['class']);
  return element(
    'div',
    {
      class: 'nv-data-table',
      'data-nv-ui': 'data-table',
      'data-nv-ui-selection-label': selection,
    },
    [
      element(
        'table',
        {
          id: tableId,
          class: className ? `nv-table ${className}` : 'nv-table',
          'aria-describedby': `${tableId}-status`,
        },
        [
          element('caption', { class: 'nv-table__caption' }, [caption]),
          slot('body'),
        ],
      ),
      element('p', {
        class: 'nv-data-table__status',
        id: `${tableId}-status`,
        role: 'status',
        'data-nv-ui-table-status': true,
      }),
    ],
  );
}
/** Wire a control to a table: client-side filtering and/or a Live model. */
function tableControl(
  input: MarkupInput,
  suffix: string,
): {
  readonly table: string;
  readonly client: boolean;
  readonly controlId: string;
  readonly name: string | undefined;
  readonly model: string | undefined;
} {
  const table = id(input['table'], 'table');
  const client = flag(input['client'], 'client');
  const model = optionalId(input['model'], 'model');
  if (client && model)
    throw new UiError('ARGUMENT', 'Use either client filtering or a model');
  return {
    table,
    client,
    controlId: optionalId(input['id'], 'id') ?? `${table}-${suffix}`,
    name: optionalId(input['name'], 'name'),
    model,
  };
}
/**
 * Search box for a table: `role="search"` with a labelled `type="search"`
 * input. `client` filters the rendered rows in the browser; `model` binds a
 * debounced Live model so the server filters; `name` submits it in a GET form.
 */
export function tableSearchMarkup(input: MarkupInput): MarkupElement {
  const control = tableControl(input, 'search');
  const label = text(input['label'], 'label');
  const results = optionalText(input['resultsLabel'], 'resultsLabel');
  if (control.client && !results)
    throw new UiError('ARGUMENT', 'Client filtering needs resultsLabel');
  const value = optionalText(input['value'], 'value', 256) ?? '';
  const placeholder = optionalText(input['placeholder'], 'placeholder');
  return element('div', { class: 'nv-table-search', role: 'search' }, [
    element(
      'label',
      { class: 'nv-table-search__label', for: control.controlId },
      [label],
    ),
    element('input', {
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
    }),
  ]);
}
const filterKey = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * Native `<select>` filter. With `client` rows are matched against their
 * `data-{key}` attribute; with `model` the Live server filters.
 */
export function tableFilterMarkup(input: MarkupInput): MarkupElement {
  const control = tableControl(input, 'filter');
  const key = input['key'];
  if (typeof key !== 'string' || !filterKey.test(key))
    throw new UiError('ID', 'key must match [a-z][a-z0-9-]{0,31}');
  const label = text(input['label'], 'label');
  const all = text(input['allLabel'], 'allLabel');
  const results = optionalText(input['resultsLabel'], 'resultsLabel');
  if (control.client && !results)
    throw new UiError('ARGUMENT', 'Client filtering needs resultsLabel');
  const value = optionalText(input['value'], 'value', 256) ?? '';
  const seen = new Set<string>();
  const options = list(input['options'], 'options', 200).map((entry) => {
    const option = record(entry, 'option', ['value', 'label']);
    const optionValue = text(option['value'], 'option value', 256);
    if (seen.has(optionValue))
      throw new UiError('ARGUMENT', 'Duplicate option value');
    seen.add(optionValue);
    return element(
      'option',
      { value: optionValue, selected: optionValue === value },
      [text(option['label'], 'label')],
    );
  });
  if (value && !seen.has(value))
    throw new UiError('ARGUMENT', 'value must be one of the options');
  const controlId = optionalId(input['id'], 'id') ?? `${control.table}-${key}`;
  return element('div', { class: 'nv-table-filter' }, [
    element('label', { class: 'nv-table-filter__label', for: controlId }, [
      label,
    ]),
    element(
      'select',
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
      [
        element('option', { value: '', selected: value === '' }, [all]),
        ...options,
      ],
    ),
  ]);
}
/** Header cell with a select-all checkbox (mixed state managed by the module). */
export function selectAllMarkup(input: MarkupInput): MarkupElement {
  const table = id(input['table'], 'table');
  const label = text(input['label'], 'label');
  return element('th', { scope: 'col', class: 'nv-table__select' }, [
    element('input', {
      type: 'checkbox',
      class: 'nv-table__checkbox',
      'aria-label': label,
      'aria-controls': table,
      'data-nv-ui-select-all': table,
    }),
  ]);
}
/** Row cell with a named checkbox, so a native form posts the selected values. */
export function selectRowMarkup(input: MarkupInput): MarkupElement {
  const name = id(input['name'], 'name');
  const value = text(input['value'], 'value', 256);
  const label = text(input['label'], 'label');
  const checked = flag(input['checked'], 'checked');
  return element('td', { class: 'nv-table__select' }, [
    element('input', {
      type: 'checkbox',
      class: 'nv-table__checkbox',
      name,
      value,
      checked,
      'aria-label': label,
      'data-nv-ui-select-row': true,
    }),
  ]);
}
function direction(value: unknown): 'ascending' | 'descending' {
  if (value === undefined || value === null || value === 'asc')
    return 'ascending';
  if (value === 'ascending' || value === 'descending') return value;
  if (value === 'desc') return 'descending';
  throw new UiError('ARGUMENT', 'direction must be asc or desc');
}
/**
 * Sortable column header: `aria-sort` on the current column and a link
 * (`href`) or Live action button (`action`) that requests the order.
 */
export function sortHeaderMarkup(input: MarkupInput): MarkupElement {
  const label = text(input['label'], 'label');
  const key = id(input['key'], 'key');
  const sorted = input['sort'] === key;
  const order = direction(input['direction']);
  const action = optionalId(input['action'], 'action');
  const link = optionalHref(input['href'], 'href');
  if ((action === undefined) === (link === undefined))
    throw new UiError('ARGUMENT', 'Provide exactly one of action or href');
  const arrow = sorted ? (order === 'ascending' ? '▲' : '▼') : '↕';
  const content: MarkupNode[] = [
    label,
    element('span', { class: 'nv-sort__icon', 'aria-hidden': 'true' }, [arrow]),
  ];
  const control = action
    ? element(
        'button',
        {
          type: 'button',
          class: 'nv-sort',
          'nv:click': action,
          'data-nv-ui-sort-key': key,
        },
        content,
      )
    : element(
        'a',
        { class: 'nv-sort', href: link, 'data-nv-ui-sort-key': key },
        content,
      );
  return element(
    'th',
    { scope: 'col', 'aria-sort': sorted ? order : undefined },
    [control],
  );
}

export { UiError };
