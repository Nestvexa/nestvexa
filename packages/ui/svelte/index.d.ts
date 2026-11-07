import type { Component, Snippet } from 'svelte';
import type { ToastOptions } from '@nestvexa/ui/browser';
import type {
  ChartType,
  DateStyle,
  FieldInputType,
  FieldViewLike,
  MarkupNode,
} from '@nestvexa/ui/markup';

export { chartData, closeDialog, openDialog } from '@nestvexa/ui/browser';
export type { ChartData, ToastOptions } from '@nestvexa/ui/browser';
export type {
  ChartType,
  FieldInputType,
  FieldViewLike,
} from '@nestvexa/ui/markup';

export interface DialogProps {
  id: string;
  title: string;
  closeLabel: string;
  describedBy?: string | undefined;
  /** Close when a `nestvexa:event` with this name is dispatched on window. */
  closeOn?: string | undefined;
  class?: string | undefined;
  /** Side-anchored drawer variant. */
  drawer?: boolean;
  side?: 'start' | 'end' | undefined;
  children?: Snippet | undefined;
  /** Called when the dialog closes (close button, Escape or backdrop). */
  onclose?: (() => void) | undefined;
}
/** Modal `<dialog>`; open it with `DialogTrigger` or `openDialog`. */
export declare const Dialog: Component<DialogProps>;
/** Side-anchored modal dialog (`<Dialog drawer>`). */
export declare const Drawer: Component<Omit<DialogProps, 'drawer'>>;

export interface DialogTriggerProps {
  /** Id of the dialog to open. */
  target: string;
  label: string;
  /** Same-origin fallback link used when the dialog is missing. */
  href?: string | undefined;
  class?: string | undefined;
}
export declare const DialogTrigger: Component<DialogTriggerProps>;

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly selected?: boolean;
}
export interface TabsProps {
  id: string;
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabItem[];
  /** Renders the panel of each tab. */
  panel: Snippet<[TabItem]>;
}
/** APG tabs (arrow keys, Home/End, RTL aware) over always-rendered panels. */
export declare const Tabs: Component<TabsProps>;

export interface MenuItem {
  readonly label: string;
  /** Same-origin link item. */
  readonly href?: string;
  /** Value item, reported through `onselect`. */
  readonly value?: string;
  readonly disabled?: boolean;
}
export interface MenuProps {
  id: string;
  /** Text of the menu button. */
  label: string;
  items: readonly MenuItem[];
  class?: string | undefined;
  onselect?: ((value: string) => void) | undefined;
}
/** APG menu button (Enter/Space/arrows open, type-ahead, Escape, Tab). */
export declare const Menu: Component<MenuProps>;

export interface ToastRegionProps {
  id: string;
  label: string;
  dismissLabel: string;
  /** Initial info toasts (read once). */
  messages?: readonly string[] | undefined;
  /** `nestvexa:event` name that also shows toasts (default `toast`). */
  event?: string | undefined;
}
export interface ToastRegionExports {
  /** Append a text-only toast; errors use the assertive list. */
  show(message: string, options?: ToastOptions): HTMLElement | undefined;
}
/** Live region for toasts; call `show` on the instance (`bind:this`). */
export declare const ToastRegion: Component<
  ToastRegionProps,
  ToastRegionExports
>;

export interface DatePickerProps {
  id: string;
  name: string;
  label: string;
  /** Initial `YYYY-MM-DD` value (read once; the input is uncontrolled). */
  defaultValue?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  /** BCP 47 locale of the formatted output. */
  locale?: string | undefined;
  dateStyle?: DateStyle | undefined;
  required?: boolean;
  describedBy?: string | undefined;
  /** Called with the `YYYY-MM-DD` value (or `''`) on change. */
  onchange?: ((value: string) => void) | undefined;
}
/** Native date input plus a locale-formatted, UTC-stable `<output>`. */
export declare const DatePicker: Component<DatePickerProps>;

export interface DataTableProps {
  id: string;
  caption: string;
  /** Selection status template, e.g. `{count} selected`. */
  selectionLabel?: string | undefined;
  class?: string | undefined;
  /** `<thead>`/`<tbody>` content. */
  children?: Snippet | undefined;
}
/** Captioned table with a status line for filter and selection counts. */
export declare const DataTable: Component<DataTableProps>;

export interface TableSearchProps {
  table: string;
  label: string;
  id?: string | undefined;
  name?: string | undefined;
  /** Filter rendered rows in the browser (needs `resultsLabel`). */
  client?: boolean;
  resultsLabel?: string | undefined;
  defaultValue?: string | undefined;
  placeholder?: string | undefined;
}
export declare const TableSearch: Component<TableSearchProps>;

export interface TableFilterProps {
  table: string;
  /** Row `data-{field}` attribute matched by client filtering. */
  field: string;
  label: string;
  allLabel: string;
  options: readonly { readonly value: string; readonly label: string }[];
  id?: string | undefined;
  name?: string | undefined;
  client?: boolean;
  resultsLabel?: string | undefined;
  defaultValue?: string | undefined;
}
export declare const TableFilter: Component<TableFilterProps>;

export interface SelectAllProps {
  table: string;
  label: string;
}
/** `<th>` with a select-all checkbox (mixed state managed by the module). */
export declare const SelectAll: Component<SelectAllProps>;

export interface SelectRowProps {
  name: string;
  value: string;
  label: string;
  defaultChecked?: boolean;
}
/** `<td>` with a named row checkbox (posted by native forms). */
export declare const SelectRow: Component<SelectRowProps>;

export interface SortHeaderProps {
  label: string;
  /** Column key; `aria-sort` is set when it equals `sort`. */
  sortKey: string;
  sort?: string | undefined;
  direction?: 'asc' | 'desc' | undefined;
  /** Same-origin link that requests this order. */
  href: string;
}
/** `<th>` with `aria-sort` and a sort link. */
export declare const SortHeader: Component<SortHeaderProps>;

/** Props shared by every field wrapper. */
export interface FieldProps {
  /** Control id; optional when `field` supplies it. */
  id?: string | undefined;
  name: string;
  label: string;
  /** Hint text (`{id}-hint`), referenced by `aria-describedby`. */
  hint?: string | undefined;
  /** Error message(s); sets `aria-invalid` and renders `{id}-error`. */
  error?: string | readonly string[] | undefined;
  /** A `@nestvexa/forms` field view instead of `id`/`error`. */
  field?: FieldViewLike | undefined;
  required?: boolean;
  disabled?: boolean;
  /** Extra id(s) for `aria-describedby`, before the hint and error. */
  describedBy?: string | undefined;
  class?: string | undefined;
}
export interface FieldOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface TextFieldProps extends FieldProps {
  type?: FieldInputType | undefined;
  /** Initial value (read once; the input is uncontrolled). */
  defaultValue?: string | undefined;
  placeholder?: string | undefined;
  autocomplete?: string | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  readOnly?: boolean;
  /** Called with the value on each edit. */
  onchange?: ((value: string) => void) | undefined;
}
/** Labelled text-like input with hint and error wiring. */
export declare const TextField: Component<TextFieldProps>;

export interface TextareaFieldProps extends FieldProps {
  defaultValue?: string | undefined;
  rows?: number | undefined;
  placeholder?: string | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  readOnly?: boolean;
  onchange?: ((value: string) => void) | undefined;
}
/** Labelled textarea with hint and error wiring. */
export declare const TextareaField: Component<TextareaFieldProps>;

export interface SelectFieldProps extends FieldProps {
  options: readonly FieldOption[];
  defaultValue?: string | undefined;
  /** First empty option, e.g. `Choose a country`. */
  placeholder?: string | undefined;
  autocomplete?: string | undefined;
  onchange?: ((value: string) => void) | undefined;
}
/** Labelled native select with hint and error wiring. */
export declare const SelectField: Component<SelectFieldProps>;

export interface CheckboxFieldProps extends FieldProps {
  value?: string | undefined;
  defaultChecked?: boolean;
  /** Called with the checked state on change. */
  onchange?: ((checked: boolean) => void) | undefined;
}
/** Single checkbox with its label, hint and error. */
export declare const CheckboxField: Component<CheckboxFieldProps>;

export interface RadioGroupFieldProps extends FieldProps {
  options: readonly FieldOption[];
  defaultValue?: string | undefined;
  onchange?: ((value: string) => void) | undefined;
}
/** Radio group in a `<fieldset role="radiogroup">` with legend, hint and error. */
export declare const RadioGroupField: Component<RadioGroupFieldProps>;

export interface ChartSeries {
  readonly name: string;
  readonly values: readonly number[];
}
export interface ChartProps {
  id: string;
  /** `bar` (default), `line`, `sparkline` or `custom` (third-party chart). */
  type?: ChartType | undefined;
  title: string;
  description?: string | undefined;
  /** Header of the data table's label column. */
  categoryLabel: string;
  labels: readonly string[];
  series: readonly ChartSeries[];
  min?: number | undefined;
  max?: number | undefined;
  /** BCP 47 locale for the table and axis numbers. */
  locale?: string | undefined;
  /** Show the data table instead of keeping it visually hidden. */
  showTable?: boolean;
  class?: string | undefined;
  /** Mount point of a third-party chart (`type="custom"`). */
  children?: Snippet | undefined;
}
/** Server-rendered SVG chart (or third-party container) plus its data table. */
export declare const Chart: Component<ChartProps>;

export interface MarkupProps {
  node: MarkupNode;
  /** Renders slot content; receives the slot name. */
  content?: Snippet<[string]> | undefined;
  element?: Element | undefined;
}
/** Generic renderer for a `@nestvexa/ui/markup` tree. */
export declare const Markup: Component<MarkupProps, object, 'element'>;
