/**
 * Vue 3 wrappers for the main @nestvexa/ui primitives. Each component renders
 * the tree of the shared markup contract (`@nestvexa/ui/markup`, the same
 * builders the HBS helpers print) with `h()` and connects it on mount to the
 * shared keyboard module (`@nestvexa/ui/browser`). Behavior is never
 * reimplemented here. Components are uncontrolled: the module owns
 * open/selected state, so initial values (`defaultValue`, `messages`) are
 * read once.
 */
import { defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PropType, Ref, Slots, VNodeChild } from 'vue';
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
import type {
  DateStyle,
  MarkupElement,
  MarkupInput,
  MarkupNode,
} from '@nestvexa/ui/markup';

export { closeDialog, openDialog } from '@nestvexa/ui/browser';
export type { ToastOptions } from '@nestvexa/ui/browser';

type SlotRender = () => VNodeChild;
type SlotMap = Readonly<Record<string, SlotRender | undefined>>;

function attributes(node: MarkupElement): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.attributes)) {
    // Live directives only appear when a Live-only option is passed.
    if (name.startsWith('nv:')) continue;
    output[name] = booleanAttributes.has(name)
      ? true
      : value === true
        ? ''
        : value;
  }
  return output;
}

function render(
  node: MarkupNode,
  slots: SlotMap,
  root?: Ref<Element | undefined>,
): VNodeChild {
  if (typeof node === 'string') return node;
  if (isMarkupSlot(node)) {
    const slot = Object.hasOwn(slots, node.slot) ? slots[node.slot] : undefined;
    return slot ? slot() : null;
  }
  const props = { ...attributes(node), ...(root ? { ref: root } : {}) };
  if (voidElements.has(node.tag)) return h(node.tag, props);
  return h(
    node.tag,
    props,
    node.children.map((child) => render(child, slots)),
  );
}

/** Root element ref connected to the keyboard module while mounted. */
function useConnection(): Ref<Element | undefined> {
  const root = ref<Element>();
  let release: (() => void) | undefined;
  onMounted(() => {
    if (root.value) release = connectUi(root.value);
  });
  onBeforeUnmount(() => release?.());
  return root;
}

/** Listen to a DOM event on the root while mounted. */
function useDomEvent(
  root: Ref<Element | undefined>,
  type: string,
  listener: (event: Event) => void,
): void {
  let element: Element | undefined;
  onMounted(() => {
    element = root.value;
    element?.addEventListener(type, listener);
  });
  onBeforeUnmount(() => element?.removeEventListener(type, listener));
}

const text = { type: String, required: true } as const;
const optionalText = { type: String, required: false } as const;
const optionalFlag = {
  type: Boolean,
  required: false,
  default: undefined,
} as const;

/** Keep only defined values so builders see absent options as absent. */
function defined(input: Record<string, unknown>): MarkupInput {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) output[key] = value;
  return output;
}
const slot = (slots: Slots, name: string): SlotRender | undefined => {
  const fn = slots[name];
  return fn ? () => fn() : undefined;
};

function defineDialog(name: string, drawer: boolean) {
  return defineComponent({
    name,
    props: {
      id: text,
      title: text,
      closeLabel: text,
      describedBy: optionalText,
      closeOn: optionalText,
      className: optionalText,
      side: { type: String as PropType<'start' | 'end'>, required: false },
    },
    emits: ['close'],
    setup(props, { slots, emit }) {
      const root = useConnection();
      useDomEvent(root, 'close', () => emit('close'));
      return (): VNodeChild =>
        render(
          dialogMarkup(
            defined({
              id: props.id,
              title: props.title,
              closeLabel: props.closeLabel,
              describedBy: props.describedBy,
              closeOn: props.closeOn,
              class: props.className,
              drawer,
              side: props.side,
            }),
          ),
          { body: slot(slots, 'default') },
          root,
        );
    },
  });
}
/** Modal `<dialog>`; the default slot is the body. Emits `close`. */
export const Dialog = defineDialog('NvDialog', false);
/** Side-anchored modal dialog (`side`: `start` or `end`). Emits `close`. */
export const Drawer = defineDialog('NvDrawer', true);

export const DialogTrigger = defineComponent({
  name: 'NvDialogTrigger',
  props: {
    target: text,
    label: text,
    href: optionalText,
    className: optionalText,
  },
  setup(props) {
    const root = useConnection();
    return (): VNodeChild =>
      render(
        dialogTriggerMarkup(
          defined({
            target: props.target,
            label: props.label,
            href: props.href,
            class: props.className,
          }),
        ),
        {},
        root,
      );
  },
});

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly selected?: boolean;
}
/** APG tabs; each panel is the named slot `panel-<id>`. */
export const Tabs = defineComponent({
  name: 'NvTabs',
  props: {
    id: text,
    label: text,
    tabs: { type: Array as PropType<readonly TabItem[]>, required: true },
  },
  setup(props, { slots }) {
    const root = useConnection();
    return (): VNodeChild => {
      const panels: Record<string, SlotRender | undefined> = {};
      for (const tab of props.tabs)
        panels[tabPanelSlot(tab.id)] = slot(slots, `panel-${tab.id}`);
      return render(
        tabsMarkup({
          id: props.id,
          label: props.label,
          tabs: props.tabs.map((tab) =>
            defined({ id: tab.id, label: tab.label, selected: tab.selected }),
          ),
        }),
        panels,
        root,
      );
    };
  },
});

export interface MenuItem {
  readonly label: string;
  readonly href?: string;
  readonly value?: string;
  readonly disabled?: boolean;
}
/** APG menu button. Emits `select` with the value of value items. */
export const Menu = defineComponent({
  name: 'NvMenu',
  props: {
    id: text,
    label: text,
    items: { type: Array as PropType<readonly MenuItem[]>, required: true },
    className: optionalText,
  },
  emits: ['select'],
  setup(props, { emit }) {
    const root = useConnection();
    useDomEvent(root, 'nv-ui-menu-select', (event) => {
      const value = menuSelection(event);
      if (value !== undefined) emit('select', value);
    });
    return (): VNodeChild =>
      render(
        menuMarkup(
          defined({
            id: props.id,
            label: props.label,
            class: props.className,
            items: props.items.map((item) =>
              defined({
                label: item.label,
                href: item.href,
                value: item.value,
                disabled: item.disabled,
              }),
            ),
          }),
        ),
        {},
        root,
      );
  },
});

/** Exposed instance API of {@link ToastRegion}. */
export interface ToastHandle {
  show(message: string, options?: ToastOptions): HTMLElement | undefined;
}
/** Live region for toasts; exposes `show(message, options)`. */
export const ToastRegion = defineComponent({
  name: 'NvToastRegion',
  props: {
    id: text,
    label: text,
    dismissLabel: text,
    messages: { type: Array as PropType<readonly string[]>, required: false },
    event: optionalText,
  },
  setup(props, { expose }) {
    const root = useConnection();
    const messages = props.messages ? [...props.messages] : undefined;
    const handle: ToastHandle = {
      show: (message, options) =>
        root.value ? showToast(root.value, message, options) : undefined,
    };
    expose(handle);
    return (): VNodeChild =>
      render(
        toastRegionMarkup(
          defined({
            id: props.id,
            label: props.label,
            dismissLabel: props.dismissLabel,
            event: props.event,
            messages,
          }),
        ),
        {},
        root,
      );
  },
});

/** Native date input plus a locale-formatted `<output>`. Emits `change`. */
export const DatePicker = defineComponent({
  name: 'NvDatePicker',
  props: {
    id: text,
    name: text,
    label: text,
    defaultValue: optionalText,
    min: optionalText,
    max: optionalText,
    locale: optionalText,
    dateStyle: { type: String as PropType<DateStyle>, required: false },
    required: optionalFlag,
    describedBy: optionalText,
  },
  emits: ['change'],
  setup(props, { emit }) {
    const root = useConnection();
    const initial = props.defaultValue;
    // Browsers without a native date control (Playwright WebKit on Windows)
    // render a text input that commits with `input`; report each value once.
    let reported = initial ?? '';
    const changed = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement &&
        target.matches('input[type="date"]') &&
        target.value !== reported
      ) {
        reported = target.value;
        emit('change', target.value);
      }
    };
    useDomEvent(root, 'input', changed);
    useDomEvent(root, 'change', changed);
    return (): VNodeChild =>
      render(
        datePickerMarkup(
          defined({
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
        ),
        {},
        root,
      );
  },
});

/** Captioned table; the default slot holds `<thead>`/`<tbody>`. */
export const DataTable = defineComponent({
  name: 'NvDataTable',
  props: {
    id: text,
    caption: text,
    selectionLabel: optionalText,
    className: optionalText,
  },
  setup(props, { slots }) {
    const root = useConnection();
    return (): VNodeChild =>
      render(
        dataTableMarkup(
          defined({
            id: props.id,
            caption: props.caption,
            selectionLabel: props.selectionLabel,
            class: props.className,
          }),
        ),
        { body: slot(slots, 'default') },
        root,
      );
  },
});

export const TableSearch = defineComponent({
  name: 'NvTableSearch',
  props: {
    table: text,
    label: text,
    id: optionalText,
    name: optionalText,
    client: optionalFlag,
    resultsLabel: optionalText,
    defaultValue: optionalText,
    placeholder: optionalText,
  },
  setup(props) {
    const root = useConnection();
    return (): VNodeChild =>
      render(
        tableSearchMarkup(
          defined({
            table: props.table,
            label: props.label,
            id: props.id,
            name: props.name,
            client: props.client,
            resultsLabel: props.resultsLabel,
            value: props.defaultValue,
            placeholder: props.placeholder,
          }),
        ),
        {},
        root,
      );
  },
});

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}
export const TableFilter = defineComponent({
  name: 'NvTableFilter',
  props: {
    table: text,
    field: text,
    label: text,
    allLabel: text,
    options: {
      type: Array as PropType<readonly FilterOption[]>,
      required: true,
    },
    id: optionalText,
    name: optionalText,
    client: optionalFlag,
    resultsLabel: optionalText,
    defaultValue: optionalText,
  },
  setup(props) {
    const root = useConnection();
    return (): VNodeChild =>
      render(
        tableFilterMarkup(
          defined({
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
        ),
        {},
        root,
      );
  },
});

export const SelectAll = defineComponent({
  name: 'NvSelectAll',
  props: { table: text, label: text },
  setup(props) {
    const root = useConnection();
    return (): VNodeChild =>
      render(
        selectAllMarkup({ table: props.table, label: props.label }),
        {},
        root,
      );
  },
});

export const SelectRow = defineComponent({
  name: 'NvSelectRow',
  props: {
    name: text,
    value: text,
    label: text,
    defaultChecked: optionalFlag,
  },
  setup(props) {
    const root = useConnection();
    return (): VNodeChild =>
      render(
        selectRowMarkup(
          defined({
            name: props.name,
            value: props.value,
            label: props.label,
            checked: props.defaultChecked,
          }),
        ),
        {},
        root,
      );
  },
});

export const SortHeader = defineComponent({
  name: 'NvSortHeader',
  props: {
    label: text,
    sortKey: text,
    sort: optionalText,
    direction: { type: String as PropType<'asc' | 'desc'>, required: false },
    href: text,
  },
  setup(props) {
    const root = useConnection();
    return (): VNodeChild =>
      render(
        sortHeaderMarkup(
          defined({
            label: props.label,
            key: props.sortKey,
            sort: props.sort,
            direction: props.direction,
            href: props.href,
          }),
        ),
        {},
        root,
      );
  },
});
