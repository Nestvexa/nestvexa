/**
 * React wrappers for the main @nestvexa/ui primitives. Each component renders
 * the tree of the shared markup contract (`@nestvexa/ui/markup`, the same
 * builders the HBS helpers print) and connects it on mount to the shared
 * keyboard module (`@nestvexa/ui/browser`). Behavior is never reimplemented
 * here. Components are uncontrolled: the module owns open/selected state, so
 * initial values (`defaultValue`, `messages`) are read once.
 */
import {
  Fragment,
  createElement,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, Ref, RefObject } from 'react';
import { connectUi, menuSelection, showToast } from '@nestvexa/ui/browser';
import type { ToastOptions } from '@nestvexa/ui/browser';
import {
  booleanAttributes,
  dataTableMarkup,
  datePickerMarkup,
  dialogMarkup,
  dialogTriggerMarkup,
  isMarkupSlot,
  menuMarkup,
  selectAllMarkup,
  selectRowMarkup,
  sortHeaderMarkup,
  tabPanelSlot,
  tableFilterMarkup,
  tableSearchMarkup,
  tabsMarkup,
  toastRegionMarkup,
  voidElements,
} from '@nestvexa/ui/markup';
import type { DateStyle, MarkupElement, MarkupNode } from '@nestvexa/ui/markup';

export { closeDialog, openDialog } from '@nestvexa/ui/browser';
export type { ToastOptions } from '@nestvexa/ui/browser';

type Slots = Readonly<Record<string, ReactNode>>;

const names: Readonly<Record<string, string>> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  autocomplete: 'autoComplete',
  spellcheck: 'spellCheck',
  readonly: 'readOnly',
};

/** Contract attributes as React props (uncontrolled form values). */
function props(node: MarkupElement): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.attributes)) {
    // Live directives only appear when a Live-only option is passed.
    if (name.startsWith('nv:')) continue;
    if (node.tag === 'option' && name === 'selected') continue;
    if (node.tag === 'input' && name === 'value')
      output['defaultValue'] = value;
    else if (node.tag === 'input' && name === 'checked')
      output['defaultChecked'] = true;
    else if (booleanAttributes.has(name)) output[names[name] ?? name] = true;
    else output[names[name] ?? name] = value === true ? '' : value;
  }
  if (node.tag === 'select') {
    const selected = node.children.find(
      (child): child is MarkupElement =>
        typeof child === 'object' &&
        !isMarkupSlot(child) &&
        child.attributes['selected'] === true,
    );
    const value = selected?.attributes['value'];
    if (typeof value === 'string') output['defaultValue'] = value;
  }
  return output;
}

function render(
  node: MarkupNode,
  slots: Slots,
  key: number | undefined,
  ref?: RefObject<Element | null>,
): ReactNode {
  if (typeof node === 'string') return node;
  if (isMarkupSlot(node))
    return createElement(
      Fragment,
      { key },
      Object.hasOwn(slots, node.slot) ? slots[node.slot] : null,
    );
  const elementProps = { ...props(node), key, ...(ref ? { ref } : {}) };
  if (voidElements.has(node.tag)) return createElement(node.tag, elementProps);
  return createElement(
    node.tag,
    elementProps,
    ...node.children.map((child, index) => render(child, slots, index)),
  );
}

/** Render a contract tree and connect its root to the keyboard module. */
function useMarkup(
  tree: MarkupElement,
  slots: Slots = {},
  ref?: RefObject<Element | null>,
): ReactElement {
  const own = useRef<Element | null>(null);
  const target = ref ?? own;
  useEffect(() => {
    const element = target.current;
    return element ? connectUi(element) : undefined;
  }, [target]);
  return render(tree, slots, undefined, target) as ReactElement;
}

/** Listen to a DOM event on the element in `ref` while mounted. */
function useDomEvent(
  ref: RefObject<Element | null>,
  type: string,
  listener: ((event: Event) => void) | undefined,
): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const handle = (event: Event) => latest.current?.(event);
    element.addEventListener(type, handle);
    return () => element.removeEventListener(type, handle);
  }, [ref, type]);
}

export interface DialogProps {
  readonly id: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly describedBy?: string;
  /** Close when a `nestvexa:event` with this name is dispatched on window. */
  readonly closeOn?: string;
  readonly className?: string;
  /** Side-anchored drawer variant. */
  readonly drawer?: boolean;
  readonly side?: 'start' | 'end';
  readonly children?: ReactNode;
  /** Called when the dialog closes (close button, Escape or backdrop). */
  readonly onClose?: () => void;
}
/** Modal `<dialog>`; open it with {@link DialogTrigger} or `openDialog`. */
export function Dialog(props: DialogProps): ReactElement {
  const ref = useRef<Element | null>(null);
  useDomEvent(
    ref,
    'close',
    props.onClose ? () => props.onClose?.() : undefined,
  );
  return useMarkup(
    dialogMarkup({
      id: props.id,
      title: props.title,
      closeLabel: props.closeLabel,
      describedBy: props.describedBy,
      closeOn: props.closeOn,
      class: props.className,
      drawer: props.drawer,
      side: props.side,
    }),
    { body: props.children },
    ref,
  );
}
/** Side-anchored modal dialog (`<Dialog drawer>`). */
export function Drawer(props: Omit<DialogProps, 'drawer'>): ReactElement {
  return createElement(Dialog, { ...props, drawer: true });
}

export interface DialogTriggerProps {
  /** Id of the dialog to open. */
  readonly target: string;
  readonly label: string;
  /** Same-origin fallback link used when the dialog is missing. */
  readonly href?: string;
  readonly className?: string;
}
export function DialogTrigger(props: DialogTriggerProps): ReactElement {
  return useMarkup(
    dialogTriggerMarkup({
      target: props.target,
      label: props.label,
      href: props.href,
      class: props.className,
    }),
  );
}

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly selected?: boolean;
  readonly content: ReactNode;
}
export interface TabsProps {
  readonly id: string;
  /** Accessible name of the tab list. */
  readonly label: string;
  readonly tabs: readonly TabItem[];
}
/** APG tabs (arrow keys, Home/End, RTL aware) over always-rendered panels. */
export function Tabs(props: TabsProps): ReactElement {
  const slots: Record<string, ReactNode> = {};
  for (const tab of props.tabs) slots[tabPanelSlot(tab.id)] = tab.content;
  return useMarkup(
    tabsMarkup({
      id: props.id,
      label: props.label,
      tabs: props.tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        selected: tab.selected,
      })),
    }),
    slots,
  );
}

export interface MenuItem {
  readonly label: string;
  /** Same-origin link item. */
  readonly href?: string;
  /** Value item, reported through `onSelect`. */
  readonly value?: string;
  readonly disabled?: boolean;
}
export interface MenuProps {
  readonly id: string;
  /** Text of the menu button. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly className?: string;
  readonly onSelect?: (value: string) => void;
}
/** APG menu button (Enter/Space/arrows open, type-ahead, Escape, Tab). */
export function Menu(props: MenuProps): ReactElement {
  const ref = useRef<Element | null>(null);
  useDomEvent(ref, 'nv-ui-menu-select', (event) => {
    const value = menuSelection(event);
    if (value !== undefined) props.onSelect?.(value);
  });
  return useMarkup(
    menuMarkup({
      id: props.id,
      label: props.label,
      class: props.className,
      items: props.items.map((item) => ({
        label: item.label,
        href: item.href,
        value: item.value,
        disabled: item.disabled,
      })),
    }),
    {},
    ref,
  );
}

export interface ToastHandle {
  /** Append a text-only toast; errors use the assertive list. */
  show(message: string, options?: ToastOptions): HTMLElement | undefined;
}
export interface ToastRegionProps {
  readonly id: string;
  readonly label: string;
  readonly dismissLabel: string;
  /** Initial info toasts (read once). */
  readonly messages?: readonly string[];
  /** `nestvexa:event` name that also shows toasts (default `toast`). */
  readonly event?: string;
  readonly ref?: Ref<ToastHandle>;
}
/** Live region for toasts; call `show` on the handle passed through `ref`. */
export function ToastRegion(props: ToastRegionProps): ReactElement {
  const element = useRef<Element | null>(null);
  const [messages] = useState(props.messages);
  useImperativeHandle(
    props.ref,
    () => ({
      show: (message: string, options?: ToastOptions) =>
        element.current
          ? showToast(element.current, message, options)
          : undefined,
    }),
    [],
  );
  return useMarkup(
    toastRegionMarkup({
      id: props.id,
      label: props.label,
      dismissLabel: props.dismissLabel,
      event: props.event,
      messages,
    }),
    {},
    element,
  );
}

export interface DatePickerProps {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  /** Initial `YYYY-MM-DD` value (read once; the input is uncontrolled). */
  readonly defaultValue?: string;
  readonly min?: string;
  readonly max?: string;
  /** BCP 47 locale of the formatted output. */
  readonly locale?: string;
  readonly dateStyle?: DateStyle;
  readonly required?: boolean;
  readonly describedBy?: string;
  /** Called with the `YYYY-MM-DD` value (or `''`) on change. */
  readonly onChange?: (value: string) => void;
}
/** Native date input plus a locale-formatted, UTC-stable `<output>`. */
export function DatePicker(props: DatePickerProps): ReactElement {
  const ref = useRef<Element | null>(null);
  const [initial] = useState(props.defaultValue);
  useDomEvent(ref, 'change', (event) => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement &&
      target.type === 'date' &&
      props.onChange
    )
      props.onChange(target.value);
  });
  return useMarkup(
    datePickerMarkup({
      id: props.id,
      name: props.name,
      label: props.label,
      value: initial,
      min: props.min,
      max: props.max,
      locale: props.locale,
      dateStyle: props.dateStyle,
      required: props.required,
      describedBy: props.describedBy,
    }),
    {},
    ref,
  );
}

export interface DataTableProps {
  readonly id: string;
  readonly caption: string;
  /** Selection status template, e.g. `{count} selected`. */
  readonly selectionLabel?: string;
  readonly className?: string;
  /** `<thead>`/`<tbody>` content. */
  readonly children?: ReactNode;
}
/** Captioned table with a status line for filter and selection counts. */
export function DataTable(props: DataTableProps): ReactElement {
  return useMarkup(
    dataTableMarkup({
      id: props.id,
      caption: props.caption,
      selectionLabel: props.selectionLabel,
      class: props.className,
    }),
    { body: props.children },
  );
}

export interface TableSearchProps {
  /** Id of the table this search controls. */
  readonly table: string;
  readonly label: string;
  readonly id?: string;
  readonly name?: string;
  /** Filter rendered rows in the browser (needs `resultsLabel`). */
  readonly client?: boolean;
  /** Results template, e.g. `{count} results`. */
  readonly resultsLabel?: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
}
export function TableSearch(props: TableSearchProps): ReactElement {
  return useMarkup(
    tableSearchMarkup({
      table: props.table,
      label: props.label,
      id: props.id,
      name: props.name,
      client: props.client,
      resultsLabel: props.resultsLabel,
      value: props.defaultValue,
      placeholder: props.placeholder,
    }),
  );
}

export interface TableFilterProps {
  readonly table: string;
  /** Row `data-{field}` attribute matched by client filtering. */
  readonly field: string;
  readonly label: string;
  readonly allLabel: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly id?: string;
  readonly name?: string;
  readonly client?: boolean;
  readonly resultsLabel?: string;
  readonly defaultValue?: string;
}
export function TableFilter(props: TableFilterProps): ReactElement {
  return useMarkup(
    tableFilterMarkup({
      table: props.table,
      key: props.field,
      label: props.label,
      allLabel: props.allLabel,
      options: props.options.map((option) => ({
        value: option.value,
        label: option.label,
      })),
      id: props.id,
      name: props.name,
      client: props.client,
      resultsLabel: props.resultsLabel,
      value: props.defaultValue,
    }),
  );
}

export interface SelectAllProps {
  readonly table: string;
  readonly label: string;
}
/** `<th>` with a select-all checkbox (mixed state managed by the module). */
export function SelectAll(props: SelectAllProps): ReactElement {
  return useMarkup(selectAllMarkup({ table: props.table, label: props.label }));
}

export interface SelectRowProps {
  readonly name: string;
  readonly value: string;
  readonly label: string;
  readonly defaultChecked?: boolean;
}
/** `<td>` with a named row checkbox (posted by native forms). */
export function SelectRow(props: SelectRowProps): ReactElement {
  return useMarkup(
    selectRowMarkup({
      name: props.name,
      value: props.value,
      label: props.label,
      checked: props.defaultChecked,
    }),
  );
}

export interface SortHeaderProps {
  readonly label: string;
  /** Column key; `aria-sort` is set when it equals `sort`. */
  readonly sortKey: string;
  readonly sort?: string;
  readonly direction?: 'asc' | 'desc';
  /** Same-origin link that requests this order. */
  readonly href: string;
}
/** `<th>` with `aria-sort` and a sort link. */
export function SortHeader(props: SortHeaderProps): ReactElement {
  return useMarkup(
    sortHeaderMarkup({
      label: props.label,
      key: props.sortKey,
      sort: props.sort,
      direction: props.direction,
      href: props.href,
    }),
  );
}
