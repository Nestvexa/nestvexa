/**
 * Optional keyboard and focus behavior for @nestvexa/ui markup.
 * Self-contained, CSP-safe (no eval, inline handlers or HTML parsing of data)
 * and import-safe outside browsers: nothing touches window at module load.
 */
export interface UiController {
  /** Re-apply primitive state below root (defaults to the controller root). */
  refresh(root?: ParentNode): void;
  /** Remove every listener and observer installed by this controller. */
  dispose(): void;
}
export interface UiOptions {
  /** Browsing context whose constructors and document are used. */
  readonly window?: Window & typeof globalThis;
}
export interface ToastOptions {
  readonly tone?: 'info' | 'success' | 'error';
  /** Milliseconds; default 6000; 0 keeps the toast until dismissed. */
  readonly timeout?: number;
}

type Root = Document | Element;
const controllers = new WeakMap<Root, UiController>();
const openers = new WeakMap<HTMLDialogElement, HTMLElement | null>();
/** Dialogs opened by this module; pruned on close or when observed removed. */
const openDialogs = new Set<HTMLDialogElement>();
/** Nested controllers must not handle the same event twice. */
const handled = new WeakSet<Event>();
const maxToasts = 5;
const focusable = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function isDocument(node: unknown): node is Document {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { nodeType?: unknown }).nodeType === 9
  );
}
function isDialog(node: unknown): node is HTMLDialogElement {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { localName?: unknown }).localName === 'dialog' &&
    typeof (node as { showModal?: unknown }).showModal === 'function'
  );
}
function isHtml(node: unknown): node is HTMLElement {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { nodeType?: unknown }).nodeType === 1 &&
    typeof (node as { focus?: unknown }).focus === 'function'
  );
}
function closestElement(target: EventTarget | null): Element | null {
  return typeof target === 'object' &&
    target !== null &&
    (target as { nodeType?: unknown }).nodeType === 1
    ? (target as Element)
    : null;
}
function visible(element: HTMLElement): boolean {
  return !element.closest('[hidden]') && element.getClientRects().length > 0;
}
function focusables(container: Element): HTMLElement[] {
  return [...container.querySelectorAll(focusable)].filter(
    (element): element is HTMLElement => isHtml(element) && visible(element),
  );
}
function focus(element: HTMLElement): void {
  element.focus({ preventScroll: false });
}

function restoreFocus(dialog: HTMLDialogElement): void {
  if (!openers.has(dialog)) return;
  const opener = openers.get(dialog) ?? null;
  openers.delete(dialog);
  const document = dialog.ownerDocument;
  if (opener && opener.isConnected && !opener.closest('[hidden], [inert]')) {
    focus(opener);
    return;
  }
  // Safe fallback: the main landmark or body, never a removed element.
  const main = document.querySelector('main');
  if (isHtml(main)) {
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    focus(main);
  }
}

/** Open a `data-nv-ui="dialog"` element as a modal and move focus inside it. */
export function openDialog(
  dialog: HTMLDialogElement,
  opener?: HTMLElement | null,
): void {
  if (!isDialog(dialog) || dialog.open || !dialog.isConnected) return;
  const active = dialog.ownerDocument.activeElement;
  openers.set(
    dialog,
    opener !== undefined ? opener : isHtml(active) ? active : null,
  );
  dialog.showModal();
  openDialogs.add(dialog);
  const autofocus = dialog.querySelector('[autofocus]');
  const body = dialog.querySelector('.nv-dialog__body');
  const target =
    (isHtml(autofocus) && visible(autofocus) ? autofocus : undefined) ??
    (body ? focusables(body)[0] : undefined) ??
    focusables(dialog)[0];
  if (target) focus(target);
  else {
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    focus(dialog);
  }
}

/** Close a dialog opened with openDialog and return focus to its opener. */
export function closeDialog(dialog: HTMLDialogElement): void {
  if (!isDialog(dialog)) return;
  if (dialog.open) dialog.close();
  openDialogs.delete(dialog);
  restoreFocus(dialog);
}

function trapTab(dialog: HTMLDialogElement, event: KeyboardEvent): void {
  const items = focusables(dialog);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    focus(dialog);
    return;
  }
  const active = dialog.ownerDocument.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    focus(event.shiftKey ? last : first);
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    focus(last);
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    focus(first);
  }
}

// Tabs ----------------------------------------------------------------------
function tabParts(container: Element): {
  list: HTMLElement | null;
  tabs: HTMLElement[];
} {
  const list = [...container.children].find(
    (child) => child.getAttribute('role') === 'tablist',
  );
  return {
    list: isHtml(list) ? list : null,
    tabs: list ? [...list.querySelectorAll('[role="tab"]')].filter(isHtml) : [],
  };
}
function selectTab(
  container: Element,
  selected: HTMLElement,
  move: boolean,
): void {
  const document = container.ownerDocument;
  for (const tab of tabParts(container).tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.setAttribute('tabindex', active ? '0' : '-1');
    const panelId = tab.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    if (panel) {
      panel.hidden = !active;
      panel.removeAttribute('data-nv-ui-inactive');
    }
  }
  if (move) focus(selected);
}
function setupTabs(container: Element): void {
  const { list, tabs } = tabParts(container);
  if (!list || tabs.length === 0) return;
  const current =
    tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0];
  if (current) selectTab(container, current, false);
  list.hidden = false;
}
function tabKey(
  container: Element,
  tab: HTMLElement,
  event: KeyboardEvent,
): void {
  const { list, tabs } = tabParts(container);
  const index = tabs.indexOf(tab);
  if (!list || index < 0) return;
  const view = container.ownerDocument.defaultView;
  const rtl = view ? view.getComputedStyle(list).direction === 'rtl' : false;
  let next: number | undefined;
  if (event.key === 'ArrowRight') next = rtl ? index - 1 : index + 1;
  else if (event.key === 'ArrowLeft') next = rtl ? index + 1 : index - 1;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === undefined) return;
  event.preventDefault();
  const target = tabs[(next + tabs.length) % tabs.length];
  if (target) selectTab(container, target, true);
}

// Combobox ------------------------------------------------------------------
interface ComboParts {
  readonly wrapper: Element;
  readonly input: HTMLInputElement;
  readonly listbox: HTMLElement;
  readonly hidden: HTMLInputElement | null;
  readonly status: Element | null;
}
function comboParts(wrapper: Element): ComboParts | null {
  const input = wrapper.querySelector('input[role="combobox"]');
  const listboxId = input?.getAttribute('aria-controls');
  const listbox = listboxId
    ? wrapper.ownerDocument.getElementById(listboxId)
    : null;
  const hidden = wrapper.querySelector('input[data-nv-ui-value]');
  if (!input || input.localName !== 'input' || !isHtml(listbox)) return null;
  return {
    wrapper,
    input: input as HTMLInputElement,
    listbox,
    hidden:
      hidden && hidden.localName === 'input'
        ? (hidden as HTMLInputElement)
        : null,
    status: wrapper.querySelector('[data-nv-ui-status]'),
  };
}
function options(parts: ComboParts): HTMLElement[] {
  return [...parts.listbox.querySelectorAll('[role="option"]')].filter(isHtml);
}
function shown(parts: ComboParts): HTMLElement[] {
  return options(parts).filter((option) => !option.hidden);
}
function lower(parts: ComboParts, value: string): string {
  const lang = parts.input.closest('[lang]')?.getAttribute('lang') ?? undefined;
  try {
    return value.toLocaleLowerCase(lang);
  } catch {
    return value.toLowerCase();
  }
}
function announce(parts: ComboParts, count: number): void {
  if (!parts.status) return;
  const empty = parts.wrapper.getAttribute('data-nv-ui-empty-label') ?? '';
  const template = parts.wrapper.getAttribute('data-nv-ui-count-label');
  parts.status.textContent =
    count === 0
      ? empty
      : template
        ? template.replaceAll('{count}', String(count))
        : '';
}
function setOpen(parts: ComboParts, open: boolean): void {
  parts.listbox.hidden = !open;
  parts.input.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) {
    parts.input.removeAttribute('aria-activedescendant');
    for (const option of options(parts))
      option.removeAttribute('data-nv-ui-active');
  }
}
function filter(parts: ComboParts): number {
  const query = lower(parts, parts.input.value.trim());
  let count = 0;
  for (const option of options(parts)) {
    const match = lower(parts, option.textContent ?? '').includes(query);
    option.hidden = !match;
    if (match) count++;
  }
  announce(parts, count);
  return count;
}
function setActive(parts: ComboParts, option: HTMLElement | undefined): void {
  for (const item of options(parts)) {
    const active = item === option;
    item.toggleAttribute('data-nv-ui-active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (option) {
    parts.input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  } else parts.input.removeAttribute('aria-activedescendant');
}
function emit(element: HTMLInputElement): void {
  const view = element.ownerDocument.defaultView;
  if (!view) return;
  element.dispatchEvent(new view.Event('input', { bubbles: true }));
  element.dispatchEvent(new view.Event('change', { bubbles: true }));
}
function commit(parts: ComboParts, option: HTMLElement | null): void {
  const value = option?.getAttribute('data-value') ?? '';
  parts.input.value = option ? (option.textContent ?? '') : '';
  for (const item of options(parts)) {
    item.hidden = false;
    item.setAttribute('aria-selected', item === option ? 'true' : 'false');
  }
  setOpen(parts, false);
  if (parts.hidden && parts.hidden.value !== value) {
    parts.hidden.value = value;
    emit(parts.hidden);
  }
}
function committedLabel(parts: ComboParts): string | undefined {
  const value = parts.hidden?.value;
  if (!value) return undefined;
  return (
    options(parts).find((option) => option.getAttribute('data-value') === value)
      ?.textContent ?? undefined
  );
}
function comboInput(parts: ComboParts): void {
  const count = filter(parts);
  setActive(parts, undefined);
  setOpen(parts, count > 0);
  // Editing the text invalidates a previously committed choice.
  if (parts.hidden?.value && committedLabel(parts) !== parts.input.value) {
    parts.hidden.value = '';
    emit(parts.hidden);
  }
}
function comboKey(parts: ComboParts, event: KeyboardEvent): void {
  const open = !parts.listbox.hidden;
  const list = shown(parts);
  const activeId = parts.input.getAttribute('aria-activedescendant');
  const index = list.findIndex((option) => option.id === activeId);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!open) {
      filter(parts);
      setOpen(parts, true);
      if (event.altKey) return;
    }
    const visibleOptions = shown(parts);
    if (visibleOptions.length === 0) return;
    const down = event.key === 'ArrowDown';
    const next = !open
      ? down
        ? 0
        : visibleOptions.length - 1
      : down
        ? (index + 1) % visibleOptions.length
        : index <= 0
          ? visibleOptions.length - 1
          : index - 1;
    setActive(parts, visibleOptions[next]);
  } else if (event.key === 'Enter') {
    const option = list[index];
    if (open && option) {
      event.preventDefault();
      commit(parts, option);
    }
  } else if (event.key === 'Escape') {
    // An empty, closed combobox lets Escape reach an enclosing dialog.
    if (open) {
      event.preventDefault();
      setOpen(parts, false);
    } else if (parts.input.value !== '') {
      event.preventDefault();
      commit(parts, null);
    }
  } else if (event.key === 'Tab') setOpen(parts, false);
}
function setupCombobox(wrapper: Element): void {
  const parts = comboParts(wrapper);
  if (!parts) return;
  parts.input.setAttribute(
    'aria-expanded',
    parts.listbox.hidden ? 'false' : 'true',
  );
}

// Toasts --------------------------------------------------------------------
/** Append a text-only toast to a `data-nv-ui="toasts"` region. */
export function showToast(
  region: Element,
  message: string,
  options: ToastOptions = {},
): HTMLElement {
  const document = region.ownerDocument;
  const view = document.defaultView;
  if (region.getAttribute('data-nv-ui') !== 'toasts' || !view)
    throw new TypeError('Expected a data-nv-ui="toasts" region');
  if (typeof message !== 'string' || message.trim() === '')
    throw new TypeError('Toast message must be text');
  const tone =
    options.tone === 'error' || options.tone === 'success'
      ? options.tone
      : 'info';
  const timeout = options.timeout ?? 6000;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 600_000)
    throw new RangeError('Toast timeout must be 0–600000 ms');
  const list = region.querySelector(
    tone === 'error' ? '[data-nv-ui-alerts]' : '[data-nv-ui-list]',
  );
  if (!list) throw new TypeError('Toast region is missing its list');
  const item = document.createElement('li');
  item.className = 'nv-toast';
  item.setAttribute('data-tone', tone);
  const content = document.createElement('span');
  content.className = 'nv-toast__text';
  content.textContent = message.slice(0, 500);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'nv-toast__dismiss';
  dismiss.setAttribute(
    'aria-label',
    region.getAttribute('data-nv-ui-dismiss-label') ?? 'Dismiss',
  );
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '×';
  dismiss.append(icon);
  item.append(content, dismiss);
  const listeners = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = timeout;
  let started = 0;
  const remove = (): void => {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = undefined;
    listeners.abort();
    item.remove();
  };
  const start = (): void => {
    if (remaining <= 0 || timer !== undefined || !item.isConnected) return;
    started = Date.now();
    timer = view.setTimeout(remove, remaining);
  };
  const pause = (): void => {
    if (timer === undefined) return;
    view.clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(1000, remaining - (Date.now() - started));
  };
  const signal = listeners.signal;
  dismiss.addEventListener('click', remove, { signal });
  // WCAG 2.2.1: pointer or keyboard attention pauses auto-dismissal.
  item.addEventListener('mouseenter', pause, { signal });
  item.addEventListener('focusin', pause, { signal });
  item.addEventListener('mouseleave', start, { signal });
  item.addEventListener('focusout', start, { signal });
  list.append(item);
  const all = region.querySelectorAll('.nv-toast');
  for (let index = 0; index < all.length - maxToasts; index++)
    all[index]?.remove();
  if (timeout > 0) start();
  return item;
}

function eventDetail(event: Event): { name: string; payload: unknown } | null {
  const detail: unknown = Reflect.get(event, 'detail');
  if (detail === null || typeof detail !== 'object') return null;
  const name = Object.getOwnPropertyDescriptor(detail, 'name')?.value;
  const payload = Object.getOwnPropertyDescriptor(detail, 'payload')?.value;
  return typeof name === 'string' ? { name, payload } : null;
}
function toastPayload(
  payload: unknown,
): { message: string; tone: 'info' | 'success' | 'error' } | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const message = Object.getOwnPropertyDescriptor(payload, 'message')?.value;
  const tone = Object.getOwnPropertyDescriptor(payload, 'tone')?.value;
  if (typeof message !== 'string' || message.trim() === '') return null;
  return {
    message,
    tone: tone === 'error' || tone === 'success' ? tone : 'info',
  };
}

function langOf(element: Element): string | undefined {
  return element.closest('[lang]')?.getAttribute('lang') ?? undefined;
}
function lowerFor(element: Element, value: string): string {
  try {
    return value.toLocaleLowerCase(langOf(element));
  } catch {
    return value.toLowerCase();
  }
}
/** Element by id; a missing or non-HTML target resolves to null. */
function byId(doc: Document, value: string | null): HTMLElement | null {
  if (!value) return null;
  const element = doc.getElementById(value);
  return isHtml(element) ? element : null;
}
/** Main landmark (or body) when the focused element is about to disappear. */
function focusFallback(doc: Document): void {
  const main = doc.querySelector('main');
  if (isHtml(main)) {
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    focus(main);
  }
}

// Alerts --------------------------------------------------------------------
function setupAlert(alert: Element): void {
  for (const button of alert.querySelectorAll('[data-nv-ui-dismiss]'))
    if (isHtml(button)) button.hidden = false;
}
function dismissAlert(alert: Element): void {
  const doc = alert.ownerDocument;
  const hadFocus = alert.contains(doc.activeElement);
  alert.remove();
  if (hadFocus) focusFallback(doc);
}

// Accordion -----------------------------------------------------------------
function accordionTriggers(accordion: Element): HTMLElement[] {
  return [...accordion.querySelectorAll('.nv-accordion__trigger')].filter(
    (trigger): trigger is HTMLElement =>
      isHtml(trigger) &&
      trigger.closest('[data-nv-ui="accordion"]') === accordion,
  );
}
function setExpanded(trigger: HTMLElement, open: boolean): void {
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  const panel = byId(
    trigger.ownerDocument,
    trigger.getAttribute('aria-controls'),
  );
  if (panel) {
    panel.hidden = !open;
    panel.removeAttribute('data-nv-ui-collapsed');
  }
}
function setupAccordion(accordion: Element): void {
  for (const trigger of accordionTriggers(accordion))
    setExpanded(trigger, trigger.getAttribute('aria-expanded') === 'true');
}
function toggleAccordion(accordion: Element, trigger: HTMLElement): void {
  const open = trigger.getAttribute('aria-expanded') !== 'true';
  if (open && !accordion.hasAttribute('data-nv-ui-multiple'))
    for (const other of accordionTriggers(accordion))
      if (other !== trigger) setExpanded(other, false);
  setExpanded(trigger, open);
}
function accordionKey(
  accordion: Element,
  trigger: HTMLElement,
  event: KeyboardEvent,
): void {
  const triggers = accordionTriggers(accordion);
  const index = triggers.indexOf(trigger);
  let next: number | undefined;
  if (event.key === 'ArrowDown') next = index + 1;
  else if (event.key === 'ArrowUp') next = index - 1;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = triggers.length - 1;
  if (next === undefined || index < 0) return;
  event.preventDefault();
  const target = triggers[(next + triggers.length) % triggers.length];
  if (target) focus(target);
}

// Menu button ---------------------------------------------------------------
interface MenuParts {
  readonly root: Element;
  readonly button: HTMLElement;
  readonly list: HTMLElement;
}
const openMenus = new Set<Element>();
function menuParts(root: Element): MenuParts | null {
  const button = root.querySelector('[aria-haspopup="menu"]');
  const list = isHtml(button)
    ? byId(root.ownerDocument, button.getAttribute('aria-controls'))
    : null;
  return isHtml(button) && list ? { root, button, list } : null;
}
function menuItems(parts: MenuParts): HTMLElement[] {
  return [...parts.list.querySelectorAll('[role="menuitem"]')].filter(isHtml);
}
function setupMenu(root: Element): void {
  const parts = menuParts(root);
  if (!parts) return;
  for (const item of menuItems(parts)) item.setAttribute('tabindex', '-1');
  closeMenu(parts, false);
}
function openMenu(parts: MenuParts, position: 'first' | 'last'): void {
  for (const other of [...openMenus])
    if (other !== parts.root) {
      const otherParts = menuParts(other);
      if (otherParts) closeMenu(otherParts, false);
    }
  parts.list.hidden = false;
  parts.button.setAttribute('aria-expanded', 'true');
  openMenus.add(parts.root);
  const items = menuItems(parts);
  const target = position === 'first' ? items[0] : items.at(-1);
  if (target) focus(target);
}
function closeMenu(parts: MenuParts, returnFocus: boolean): void {
  parts.list.hidden = true;
  parts.list.removeAttribute('data-nv-ui-collapsed');
  parts.button.setAttribute('aria-expanded', 'false');
  openMenus.delete(parts.root);
  if (returnFocus) focus(parts.button);
}
function menuButtonKey(parts: MenuParts, event: KeyboardEvent): void {
  // Enter and Space reach the click handler through native button activation.
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu(parts, event.key === 'ArrowUp' ? 'last' : 'first');
  }
}
function activateMenuItem(parts: MenuParts, item: HTMLElement): void {
  if (item.getAttribute('aria-disabled') === 'true') return;
  const value = item.getAttribute('data-nv-ui-value');
  const view = item.ownerDocument.defaultView;
  closeMenu(parts, item.localName !== 'a');
  if (value !== null && view)
    parts.root.dispatchEvent(
      new view.CustomEvent('nv-ui-menu-select', {
        bubbles: true,
        detail: { menu: parts.root.id, value },
      }),
    );
}
function menuKey(
  parts: MenuParts,
  item: HTMLElement,
  event: KeyboardEvent,
): void {
  const items = menuItems(parts);
  const index = items.indexOf(item);
  let next: number | undefined;
  if (event.key === 'ArrowDown') next = index + 1;
  else if (event.key === 'ArrowUp') next = index - 1;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu(parts, true);
    return;
  } else if (event.key === 'Tab') {
    closeMenu(parts, false);
    return;
  } else if (event.key === ' ') {
    // Buttons activate natively; links only navigate on Enter, so Space clicks.
    if (item.localName === 'a') {
      event.preventDefault();
      if (item.getAttribute('aria-disabled') !== 'true') item.click();
    }
    return;
  } else if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    // Type-ahead: next item whose label starts with the typed character.
    const key = lowerFor(item, event.key);
    const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
    const match = ordered.find((entry) =>
      lowerFor(entry, (entry.textContent ?? '').trim()).startsWith(key),
    );
    if (match) focus(match);
    return;
  }
  if (next === undefined) return;
  event.preventDefault();
  const target = items[(next + items.length) % items.length];
  if (target) focus(target);
}

// Popover -------------------------------------------------------------------
interface PopoverParts {
  readonly root: Element;
  readonly trigger: HTMLElement;
  readonly panel: HTMLElement;
}
const openPopovers = new Set<Element>();
function popoverParts(root: Element): PopoverParts | null {
  const trigger = root.querySelector('.nv-popover__trigger');
  const panel = isHtml(trigger)
    ? byId(root.ownerDocument, trigger.getAttribute('aria-controls'))
    : null;
  return isHtml(trigger) && panel ? { root, trigger, panel } : null;
}
function setPopover(
  parts: PopoverParts,
  open: boolean,
  moveFocus: boolean,
): void {
  parts.panel.hidden = !open;
  parts.panel.removeAttribute('data-nv-ui-collapsed');
  parts.trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) openPopovers.add(parts.root);
  else openPopovers.delete(parts.root);
  if (!moveFocus) return;
  if (!open) {
    focus(parts.trigger);
    return;
  }
  const target = focusables(parts.panel)[0];
  if (target) focus(target);
  else {
    if (!parts.panel.hasAttribute('tabindex'))
      parts.panel.setAttribute('tabindex', '-1');
    focus(parts.panel);
  }
}
function setupPopover(root: Element): void {
  const parts = popoverParts(root);
  if (parts) setPopover(parts, false, false);
}

// Tooltip -------------------------------------------------------------------
function tooltipParts(
  root: Element,
): { trigger: HTMLElement; bubble: HTMLElement } | null {
  const trigger = root.querySelector('.nv-tooltip__trigger');
  const bubble = root.querySelector('[role="tooltip"]');
  return isHtml(trigger) && isHtml(bubble) ? { trigger, bubble } : null;
}
function setTooltip(root: Element, open: boolean): void {
  const parts = tooltipParts(root);
  if (parts) parts.bubble.hidden = !open;
}

// Date picker ---------------------------------------------------------------
type DateStyle = 'short' | 'medium' | 'long' | 'full';
function dateStyle(value: string | null): DateStyle {
  return value === 'short' || value === 'medium' || value === 'full'
    ? value
    : 'long';
}
function syncDate(wrapper: Element, notify: boolean): void {
  const input = wrapper.querySelector('input[type="date"]');
  if (!input || input.localName !== 'input') return;
  const date = input as HTMLInputElement;
  const output = wrapper.querySelector('output');
  const value = date.value;
  if (output) {
    let text = '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      try {
        text = new Intl.DateTimeFormat(
          wrapper.getAttribute('data-nv-ui-locale') ?? langOf(wrapper),
          {
            dateStyle: dateStyle(wrapper.getAttribute('data-nv-ui-date-style')),
            timeZone: 'UTC',
          },
        ).format(new Date(`${value}T00:00:00Z`));
      } catch {
        text = '';
      }
    }
    if (output.textContent !== text) output.textContent = text;
  }
  const mirror = wrapper.querySelector('input[data-nv-ui-date-value]');
  if (
    notify &&
    mirror &&
    mirror.localName === 'input' &&
    (mirror as HTMLInputElement).value !== value
  ) {
    (mirror as HTMLInputElement).value = value;
    emit(mirror as HTMLInputElement);
  }
}

// File uploader -------------------------------------------------------------
function uploadInput(wrapper: Element): HTMLInputElement | null {
  const input = wrapper.querySelector('input[type="file"]');
  return input && input.localName === 'input'
    ? (input as HTMLInputElement)
    : null;
}
function setupUpload(wrapper: Element): void {
  for (const zone of wrapper.querySelectorAll('[data-nv-ui-drop]'))
    if (isHtml(zone)) zone.hidden = false;
}
function formatBytes(element: Element, bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  try {
    return new Intl.NumberFormat(langOf(element), {
      style: 'unit',
      unit: units[unit] ?? 'byte',
      unitDisplay: 'short',
      maximumFractionDigits: unit === 0 ? 0 : 1,
    }).format(value);
  } catch {
    return `${bytes} B`;
  }
}
function describeFiles(wrapper: Element): void {
  const input = uploadInput(wrapper);
  const list = wrapper.querySelector('[data-nv-ui-files]');
  const status = wrapper.querySelector('[data-nv-ui-upload-status]');
  if (!input || !list) return;
  const doc = wrapper.ownerDocument;
  const files = [...(input.files ?? [])].slice(0, 100);
  list.replaceChildren(
    ...files.map((file) => {
      const item = doc.createElement('li');
      item.className = 'nv-upload__file';
      // File names are user data: text nodes only.
      item.textContent = `${file.name.slice(0, 255)} (${formatBytes(wrapper, file.size)})`;
      return item;
    }),
  );
  if (status) {
    const template = wrapper.getAttribute('data-nv-ui-selected-label') ?? '';
    status.textContent = files.length
      ? template.replaceAll('{count}', String(files.length))
      : '';
  }
}
/** Mirror the input's `accept` for dropped files, which bypass the picker. */
function accepted(input: HTMLInputElement, file: File): boolean {
  const tokens = input.accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return tokens.some((token) =>
    token.startsWith('.')
      ? name.endsWith(token)
      : token.endsWith('/*')
        ? type.startsWith(token.slice(0, -1))
        : type === token,
  );
}
function dropFiles(wrapper: Element, event: DragEvent): void {
  const input = uploadInput(wrapper);
  const view = wrapper.ownerDocument.defaultView;
  const dropped = event.dataTransfer?.files;
  if (!input || !view || !dropped || input.disabled) return;
  const files = [...dropped].filter((file) => accepted(input, file));
  const transfer = new view.DataTransfer();
  for (const file of input.multiple ? files : files.slice(0, 1))
    transfer.items.add(file);
  input.files = transfer.files;
  // Bubbling change lets nv:upload and forms observe the dropped selection.
  input.dispatchEvent(new view.Event('input', { bubbles: true }));
  input.dispatchEvent(new view.Event('change', { bubbles: true }));
}

// Data table ----------------------------------------------------------------
function tableRows(table: HTMLElement): HTMLElement[] {
  return [...table.querySelectorAll('tbody tr')].filter(isHtml);
}
function tableStatus(table: HTMLElement, message: string): void {
  const status = table
    .closest('[data-nv-ui="data-table"]')
    ?.querySelector('[data-nv-ui-table-status]');
  if (status && status.textContent !== message) status.textContent = message;
}
function checkbox(element: Element | null): HTMLInputElement | null {
  return element &&
    element.localName === 'input' &&
    (element as HTMLInputElement).type === 'checkbox'
    ? (element as HTMLInputElement)
    : null;
}
function rowBoxes(
  table: HTMLElement,
  visibleOnly: boolean,
): HTMLInputElement[] {
  return tableRows(table)
    .filter((row) => !visibleOnly || !row.hidden)
    .map((row) => checkbox(row.querySelector('input[data-nv-ui-select-row]')))
    .filter((box): box is HTMLInputElement => box !== null);
}
function syncSelection(table: HTMLElement): void {
  const doc = table.ownerDocument;
  const all = rowBoxes(table, false);
  for (const box of all)
    box.closest('tr')?.toggleAttribute('data-nv-ui-selected', box.checked);
  const shown = rowBoxes(table, true);
  const checked = shown.filter((box) => box.checked).length;
  for (const header of doc.querySelectorAll('input[data-nv-ui-select-all]')) {
    const box = checkbox(header);
    if (!box || box.getAttribute('data-nv-ui-select-all') !== table.id)
      continue;
    box.checked = shown.length > 0 && checked === shown.length;
    box.indeterminate = checked > 0 && checked < shown.length;
  }
  const label = table
    .closest('[data-nv-ui="data-table"]')
    ?.getAttribute('data-nv-ui-selection-label');
  const selectedCount = all.filter((box) => box.checked).length;
  const selection =
    label && selectedCount
      ? label.replaceAll('{count}', String(selectedCount))
      : '';
  // One polite status line: the filter result count, then the selection.
  tableStatus(
    table,
    [filterResults.get(table) ?? '', selection].filter(Boolean).join('. '),
  );
}
const filterResults = new WeakMap<HTMLElement, string>();
function filterTable(table: HTMLElement): void {
  const doc = table.ownerDocument;
  const controls = [
    ...doc.querySelectorAll('[data-nv-ui-filter-table]'),
  ].filter(
    (control) => control.getAttribute('data-nv-ui-filter-table') === table.id,
  );
  const query = controls
    .filter((control) => control.localName === 'input')
    .map((control) =>
      lowerFor(table, (control as HTMLInputElement).value.trim()),
    )
    .filter(Boolean);
  const filters = controls
    .filter((control) => control.localName === 'select')
    .map((control) => ({
      key: control.getAttribute('data-nv-ui-filter-key') ?? '',
      value: (control as HTMLSelectElement).value,
    }))
    .filter((entry) => entry.key && entry.value);
  let shown = 0;
  for (const row of tableRows(table)) {
    const text = lowerFor(table, row.textContent ?? '');
    const match =
      query.every((term) => text.includes(term)) &&
      filters.every(
        (entry) => row.getAttribute(`data-${entry.key}`) === entry.value,
      );
    row.hidden = !match;
    if (match) shown++;
  }
  const template = controls
    .map((control) => control.getAttribute('data-nv-ui-results-label'))
    .find((value) => value);
  const filtered = query.length > 0 || filters.length > 0;
  if (template && filtered)
    filterResults.set(table, template.replaceAll('{count}', String(shown)));
  else filterResults.delete(table);
  syncSelection(table);
}

function scan(root: ParentNode, element?: Element): void {
  const all = (selector: string): Element[] => [
    ...(element?.matches(selector) ? [element] : []),
    ...root.querySelectorAll(selector),
  ];
  for (const container of all('[data-nv-ui="tabs"]')) setupTabs(container);
  for (const wrapper of all('[data-nv-ui="combobox"]')) setupCombobox(wrapper);
  for (const alert of all('[data-nv-ui="alert"]')) setupAlert(alert);
  for (const accordion of all('[data-nv-ui="accordion"]'))
    setupAccordion(accordion);
  for (const menu of all('[data-nv-ui="menu"]')) setupMenu(menu);
  for (const popover of all('[data-nv-ui="popover"]')) setupPopover(popover);
  for (const wrapper of all('[data-nv-ui="date"]')) syncDate(wrapper, false);
  for (const wrapper of all('[data-nv-ui="upload"]')) setupUpload(wrapper);
  for (const wrapper of all('[data-nv-ui="data-table"]')) {
    const table = wrapper.querySelector('table');
    if (isHtml(table)) syncSelection(table);
  }
}

/**
 * Install delegated keyboard/focus behavior below root (default: document).
 * Idempotent per root; inserted primitives are initialized automatically.
 */
export function initUi(
  root?: Document | Element,
  options: UiOptions = {},
): UiController {
  const scope: Root = root ?? options.window?.document ?? document;
  const existing = controllers.get(scope);
  if (existing) return existing;
  const doc = isDocument(scope) ? scope : scope.ownerDocument;
  const view = options.window ?? doc.defaultView;
  if (!view) throw new TypeError('initUi requires a browsing context');
  const listeners = new AbortController();
  const signal = listeners.signal;
  const owned = (event: Event): boolean => {
    if (handled.has(event)) return false;
    handled.add(event);
    return true;
  };

  scope.addEventListener(
    'click',
    (event) => {
      const target = closestElement(event.target);
      if (!target || !owned(event)) return;
      // Light dismissal: a click outside an open menu or popover closes it.
      for (const root of [...openMenus]) {
        const menu = root.isConnected ? menuParts(root) : null;
        if (!menu) openMenus.delete(root);
        else if (!root.contains(target)) closeMenu(menu, false);
      }
      for (const root of [...openPopovers]) {
        const popover = root.isConnected ? popoverParts(root) : null;
        if (!popover) openPopovers.delete(root);
        else if (!root.contains(target)) setPopover(popover, false, false);
      }
      const trigger = target.closest('[data-nv-ui-open]');
      if (trigger && isHtml(trigger)) {
        const dialog = doc.getElementById(
          trigger.getAttribute('data-nv-ui-open') ?? '',
        );
        // Without a dialog an href trigger navigates (progressive enhancement).
        if (
          isDialog(dialog) &&
          dialog.getAttribute('data-nv-ui') === 'dialog'
        ) {
          event.preventDefault();
          openDialog(dialog, trigger);
        }
        return;
      }
      const close = target.closest('[data-nv-ui-close]');
      const owner = close?.closest('dialog');
      if (close && isDialog(owner)) {
        closeDialog(owner);
        return;
      }
      if (isDialog(target) && target.open && event instanceof view.MouseEvent) {
        const box = target.getBoundingClientRect();
        const outside =
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom;
        // Keyboard-synthesized clicks report 0,0; only real backdrop clicks close.
        if (outside && event.detail > 0) closeDialog(target);
        return;
      }
      const dismiss = target.closest('[data-nv-ui-dismiss]');
      const alert = dismiss?.closest('[data-nv-ui="alert"]');
      if (dismiss && alert) {
        dismissAlert(alert);
        return;
      }
      const header = target.closest('.nv-accordion__trigger');
      const accordion = header?.closest('[data-nv-ui="accordion"]');
      if (header && accordion && isHtml(header)) {
        toggleAccordion(accordion, header);
        return;
      }
      const menuRoot = target.closest('[data-nv-ui="menu"]');
      const menu = menuRoot ? menuParts(menuRoot) : null;
      if (menu && menu.button.contains(target)) {
        if (menu.list.hidden) openMenu(menu, 'first');
        else closeMenu(menu, true);
        return;
      }
      const item = target.closest('[role="menuitem"]');
      if (menu && item && isHtml(item) && menu.list.contains(item)) {
        if (item.getAttribute('aria-disabled') === 'true') {
          event.preventDefault();
          return;
        }
        activateMenuItem(menu, item);
        return;
      }
      const popoverRoot = target.closest('[data-nv-ui="popover"]');
      const popover = popoverRoot ? popoverParts(popoverRoot) : null;
      if (popover && popover.trigger.contains(target)) {
        setPopover(popover, popover.panel.hidden !== false, true);
        return;
      }
      const zone = target.closest('[data-nv-ui-drop]');
      const upload = zone?.closest('[data-nv-ui="upload"]');
      const picker = upload ? uploadInput(upload) : null;
      if (zone && picker) {
        // Pointer convenience only; keyboard users reach the labelled input.
        picker.click();
        return;
      }
      const tab = target.closest('[role="tab"]');
      const tabs = tab?.closest('[data-nv-ui="tabs"]');
      if (tab && tabs && isHtml(tab)) {
        selectTab(tabs, tab, false);
        return;
      }
      const option = target.closest('[role="option"]');
      const combo = option?.closest('[data-nv-ui="combobox"]');
      const parts = combo ? comboParts(combo) : null;
      if (option && parts && isHtml(option)) {
        commit(parts, option);
        focus(parts.input);
      }
    },
    { signal },
  );
  scope.addEventListener(
    'mousedown',
    (event) => {
      const target = closestElement(event.target);
      // Keep focus in the combobox input while choosing with a pointer.
      if (target?.closest('[data-nv-ui="combobox"] [role="option"]'))
        event.preventDefault();
    },
    { signal },
  );
  scope.addEventListener(
    'keydown',
    (event) => {
      const target = closestElement(event.target);
      if (!target || !(event instanceof view.KeyboardEvent) || !owned(event))
        return;
      if (event.key === 'Escape') {
        // WCAG 1.4.13: Escape dismisses a visible tooltip without moving focus.
        let dismissed = false;
        for (const bubble of scope.querySelectorAll(
          '[data-nv-ui="tooltip"] [role="tooltip"]',
        ))
          if (isHtml(bubble) && !bubble.hidden) {
            bubble.hidden = true;
            dismissed = true;
          }
        if (dismissed) {
          event.preventDefault();
          return;
        }
      }
      const dialog = target.closest('dialog');
      if (event.key === 'Tab' && isDialog(dialog) && dialog.open) {
        const combo = target.closest('[data-nv-ui="combobox"]');
        const parts = combo ? comboParts(combo) : null;
        if (parts && target === parts.input) setOpen(parts, false);
        const menuRoot = target.closest('[data-nv-ui="menu"]');
        const menu = menuRoot ? menuParts(menuRoot) : null;
        if (menu) closeMenu(menu, false);
        trapTab(dialog, event);
        return;
      }
      const header = target.closest('.nv-accordion__trigger');
      const accordion = header?.closest('[data-nv-ui="accordion"]');
      if (header === target && accordion && isHtml(target)) {
        accordionKey(accordion, target, event);
        return;
      }
      const menuRoot = target.closest('[data-nv-ui="menu"]');
      const menu = menuRoot ? menuParts(menuRoot) : null;
      if (menu && target === menu.button) {
        menuButtonKey(menu, event);
        return;
      }
      if (
        menu &&
        isHtml(target) &&
        target.getAttribute('role') === 'menuitem' &&
        menu.list.contains(target)
      ) {
        menuKey(menu, target, event);
        return;
      }
      const popoverRoot = target.closest('[data-nv-ui="popover"]');
      const popover = popoverRoot ? popoverParts(popoverRoot) : null;
      if (popover && event.key === 'Escape' && !popover.panel.hidden) {
        // Closing the popover takes precedence over an enclosing dialog.
        event.preventDefault();
        setPopover(popover, false, true);
        return;
      }
      if (
        (event.key === ' ' || event.key === 'Spacebar') &&
        target.localName === 'a' &&
        target.hasAttribute('data-nv-ui-open') &&
        isHtml(target)
      ) {
        event.preventDefault();
        target.click();
        return;
      }
      const tabs = target.closest('[data-nv-ui="tabs"]');
      if (target.getAttribute('role') === 'tab' && tabs && isHtml(target)) {
        tabKey(tabs, target, event);
        return;
      }
      const combo = target.closest('[data-nv-ui="combobox"]');
      const parts = combo ? comboParts(combo) : null;
      if (parts && target === parts.input) {
        comboKey(parts, event);
      }
    },
    { signal },
  );
  scope.addEventListener(
    'input',
    (event) => {
      const target = closestElement(event.target);
      const combo = target?.closest('[data-nv-ui="combobox"]');
      const parts = combo ? comboParts(combo) : null;
      if (parts && target === parts.input && owned(event)) {
        comboInput(parts);
        return;
      }
      const date = target?.closest('[data-nv-ui="date"]');
      if (date && target?.matches('input[type="date"]') && owned(event)) {
        syncDate(date, true);
        return;
      }
      const table = byId(
        doc,
        target?.getAttribute('data-nv-ui-filter-table') ?? null,
      );
      if (table && target?.localName === 'input' && owned(event))
        filterTable(table);
    },
    { signal },
  );
  scope.addEventListener(
    'change',
    (event) => {
      const target = closestElement(event.target);
      if (!target || !owned(event)) return;
      const date = target.closest('[data-nv-ui="date"]');
      if (date && target.matches('input[type="date"]')) {
        syncDate(date, true);
        return;
      }
      const upload = target.closest('[data-nv-ui="upload"]');
      if (upload && target === uploadInput(upload)) {
        describeFiles(upload);
        return;
      }
      const filtered = byId(
        doc,
        target.getAttribute('data-nv-ui-filter-table'),
      );
      if (filtered && target.localName === 'select') {
        filterTable(filtered);
        return;
      }
      const all = checkbox(target);
      const controlled = byId(
        doc,
        all?.getAttribute('data-nv-ui-select-all') ?? null,
      );
      if (all && controlled) {
        // Select-all applies to the rows the current filter shows.
        for (const box of rowBoxes(controlled, true)) box.checked = all.checked;
        syncSelection(controlled);
        return;
      }
      const row = all?.hasAttribute('data-nv-ui-select-row')
        ? all.closest('table')
        : null;
      if (isHtml(row)) syncSelection(row);
    },
    { signal },
  );
  // Tooltips: hover and focus show the bubble; it stays while the pointer is
  // over the trigger or the bubble itself (WCAG 1.4.13 hoverable).
  scope.addEventListener(
    'mouseover',
    (event) => {
      const tip = closestElement(event.target)?.closest(
        '[data-nv-ui="tooltip"]',
      );
      if (tip) setTooltip(tip, true);
    },
    { signal },
  );
  scope.addEventListener(
    'mouseout',
    (event) => {
      const tip = closestElement(event.target)?.closest(
        '[data-nv-ui="tooltip"]',
      );
      const next = closestElement((event as MouseEvent).relatedTarget);
      if (!tip || (next && tip.contains(next))) return;
      if (!tip.contains(doc.activeElement)) setTooltip(tip, false);
    },
    { signal },
  );
  scope.addEventListener(
    'focusin',
    (event) => {
      const target = closestElement(event.target);
      const tip = target?.closest('[data-nv-ui="tooltip"]');
      if (tip && target?.classList.contains('nv-tooltip__trigger'))
        setTooltip(tip, true);
    },
    { signal },
  );
  scope.addEventListener(
    'focusout',
    (event) => {
      const target = closestElement(event.target);
      const next = closestElement((event as FocusEvent).relatedTarget);
      const tip = target?.closest('[data-nv-ui="tooltip"]');
      if (tip && !(next && tip.contains(next))) setTooltip(tip, false);
      // Focus leaving a menu or popover closes it without moving focus back.
      const menuRoot = target?.closest('[data-nv-ui="menu"]');
      const menu = menuRoot ? menuParts(menuRoot) : null;
      if (menu && next && !menu.root.contains(next) && !menu.list.hidden)
        closeMenu(menu, false);
      const popoverRoot = target?.closest('[data-nv-ui="popover"]');
      const popover = popoverRoot ? popoverParts(popoverRoot) : null;
      if (
        popover &&
        next &&
        !popover.root.contains(next) &&
        !popover.panel.hidden
      )
        setPopover(popover, false, false);
    },
    { signal },
  );
  // Drag and drop is a pointer convenience on top of the native file input.
  scope.addEventListener(
    'dragover',
    (event) => {
      const upload = closestElement(event.target)?.closest(
        '[data-nv-ui="upload"]',
      );
      if (!upload || !upload.querySelector('[data-nv-ui-drop]')) return;
      event.preventDefault();
      upload.setAttribute('data-nv-ui-dragging', '');
    },
    { signal },
  );
  scope.addEventListener(
    'dragleave',
    (event) => {
      const upload = closestElement(event.target)?.closest(
        '[data-nv-ui="upload"]',
      );
      const next = closestElement((event as DragEvent).relatedTarget);
      if (upload && !(next && upload.contains(next)))
        upload.removeAttribute('data-nv-ui-dragging');
    },
    { signal },
  );
  scope.addEventListener(
    'drop',
    (event) => {
      const upload = closestElement(event.target)?.closest(
        '[data-nv-ui="upload"]',
      );
      if (
        !upload ||
        !upload.querySelector('[data-nv-ui-drop]') ||
        !(event instanceof view.DragEvent) ||
        !owned(event)
      )
        return;
      event.preventDefault();
      upload.removeAttribute('data-nv-ui-dragging');
      dropFiles(upload, event);
    },
    { signal },
  );
  scope.addEventListener(
    'focusout',
    (event) => {
      const target = closestElement(event.target);
      const combo = target?.closest('[data-nv-ui="combobox"]');
      const parts = combo ? comboParts(combo) : null;
      if (!parts || target !== parts.input) return;
      const next = closestElement((event as FocusEvent).relatedTarget);
      if (!next || !parts.listbox.contains(next)) setOpen(parts, false);
    },
    { signal },
  );
  // cancel/close do not bubble; capture them on the way to the dialog.
  scope.addEventListener(
    'close',
    (event) => {
      if (isDialog(event.target)) {
        openDialogs.delete(event.target);
        restoreFocus(event.target);
      }
    },
    { signal, capture: true },
  );
  view.addEventListener(
    'nestvexa:event',
    (event) => {
      const detail = eventDetail(event);
      if (!detail) return;
      for (const dialog of scope.querySelectorAll(
        'dialog[data-nv-ui-close-on]',
      ))
        if (
          isDialog(dialog) &&
          dialog.open &&
          dialog.getAttribute('data-nv-ui-close-on') === detail.name
        )
          closeDialog(dialog);
      const toast = toastPayload(detail.payload);
      if (!toast) return;
      for (const region of scope.querySelectorAll('[data-nv-ui="toasts"]'))
        if (
          (region.getAttribute('data-nv-ui-event') ?? 'toast') === detail.name
        )
          showToast(region, toast.message, { tone: toast.tone });
    },
    { signal },
  );
  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = closestElement(record.target);
        if (!target) continue;
        const name = record.attributeName ?? '';
        // A server re-render (Live morph) restored server-side state markers:
        // the server state wins and the primitive is set up again.
        if (name === 'data-nv-ui-inactive') {
          const tabs = target.closest('[data-nv-ui="tabs"]');
          if (tabs && target.hasAttribute(name)) setupTabs(tabs);
        } else if (name === 'data-nv-ui-collapsed') {
          const owner = target.closest(
            '[data-nv-ui="accordion"], [data-nv-ui="menu"], [data-nv-ui="popover"]',
          );
          if (owner && target.hasAttribute(name)) scan(owner, owner);
        } else if (
          name === 'data-nv-ui-current' &&
          target.getAttribute('data-nv-ui') === 'wizard' &&
          record.oldValue !== null &&
          record.oldValue !== target.getAttribute(name)
        ) {
          // Step changed in place: move focus to the new step heading.
          const heading = target.querySelector('.nv-wizard__heading');
          if (isHtml(heading)) focus(heading);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        const element = closestElement(node);
        if (element) scan(element, element);
      }
    }
    // A removed open dialog leaves focus on <body>; send it back to the opener.
    for (const dialog of [...openDialogs])
      if (!dialog.isConnected && dialog.ownerDocument === doc) {
        openDialogs.delete(dialog);
        const active = doc.activeElement;
        if (!active || active === doc.body || !active.isConnected)
          restoreFocus(dialog);
        else openers.delete(dialog);
      }
  });
  observer.observe(isDocument(scope) ? scope.documentElement : scope, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      'data-nv-ui-inactive',
      'data-nv-ui-collapsed',
      'data-nv-ui-current',
    ],
  });
  const controller: UiController = {
    refresh(target?: ParentNode) {
      scan(target ?? scope);
    },
    dispose() {
      listeners.abort();
      observer.disconnect();
      controllers.delete(scope);
    },
  };
  controllers.set(scope, controller);
  scan(scope);
  return controller;
}

/** The value of a `nv-ui-menu-select` event, or undefined if malformed. */
export function menuSelection(event: Event): string | undefined {
  const detail: unknown = Reflect.get(event, 'detail');
  if (detail === null || typeof detail !== 'object') return undefined;
  const value: unknown = Object.getOwnPropertyDescriptor(
    detail,
    'value',
  )?.value;
  return typeof value === 'string' ? value : undefined;
}

interface Connection {
  readonly controller: UiController;
  /** Created by connectUi (disposed with the last connection) or the app's own. */
  readonly owned: boolean;
  count: number;
}
const connections = new WeakMap<Document, Connection>();

/**
 * Connect a primitive rendered by a component framework (the React, Vue and
 * Svelte wrappers call this on mount) to the delegated behavior. All
 * connections of a document share one document-level controller, so light
 * dismissal and dialog triggers work across components; an existing
 * `initUi()` controller of the application is reused and never disposed here.
 * `element` is set up immediately. Call the returned function on unmount;
 * the shared controller is disposed with the last connection it created.
 */
export function connectUi(
  element: Element,
  options: UiOptions = {},
): () => void {
  const doc = element.ownerDocument;
  let connection = connections.get(doc);
  if (!connection || controllers.get(doc) !== connection.controller) {
    const existing = controllers.get(doc);
    connection = {
      controller: existing ?? initUi(doc, options),
      owned: existing === undefined,
      count: 0,
    };
    connections.set(doc, connection);
  }
  const current = connection;
  current.count++;
  scan(element, element);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.count--;
    if (current.count > 0 || connections.get(doc) !== current) return;
    connections.delete(doc);
    if (current.owned) current.controller.dispose();
  };
}

/** Values of a chart's data table, as read by {@link chartData}. */
export interface ChartData {
  readonly labels: readonly string[];
  readonly series: readonly {
    readonly name: string;
    readonly values: readonly number[];
  }[];
}
/**
 * Read the data table of a chart (`<figure data-nv-ui-chart>` rendered by
 * the chart helper or wrappers) back into labels and numeric series, for
 * example to feed a third-party chart mounted in a `type="custom"` chart's
 * `{id}-canvas` container from an external script. `root` is the figure or
 * an element inside it. Returns undefined when no well-formed table is found;
 * values come from each cell's `data-value`, never from formatted text.
 */
export function chartData(root: Element): ChartData | undefined {
  const figure = root.closest('[data-nv-ui-chart]');
  const table = figure?.querySelector(
    ':scope > .nv-chart__data > table.nv-chart__table',
  );
  const header = table?.querySelector(':scope > thead > tr');
  if (!table || !header) return undefined;
  const names = [...header.children]
    .slice(1)
    .map((cell) => cell.textContent ?? '');
  const labels: string[] = [];
  const values: number[][] = names.map(() => []);
  for (const row of table.querySelectorAll(':scope > tbody > tr')) {
    const [label, ...cells] = [...row.children];
    if (!label || cells.length !== names.length) return undefined;
    labels.push(label.textContent ?? '');
    for (const [index, cell] of cells.entries()) {
      const raw = cell.getAttribute('data-value');
      const value =
        raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
      if (!Number.isFinite(value)) return undefined;
      values[index]?.push(value);
    }
  }
  return Object.freeze({
    labels: Object.freeze(labels),
    series: Object.freeze(
      names.map((name, index) =>
        Object.freeze({ name, values: Object.freeze(values[index] ?? []) }),
      ),
    ),
  });
}
