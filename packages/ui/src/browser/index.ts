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

function scan(root: ParentNode, element?: Element): void {
  const all = (selector: string): Element[] => [
    ...(element?.matches(selector) ? [element] : []),
    ...root.querySelectorAll(selector),
  ];
  for (const container of all('[data-nv-ui="tabs"]')) setupTabs(container);
  for (const wrapper of all('[data-nv-ui="combobox"]')) setupCombobox(wrapper);
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
      const dialog = target.closest('dialog');
      if (event.key === 'Tab' && isDialog(dialog) && dialog.open) {
        const combo = target.closest('[data-nv-ui="combobox"]');
        const parts = combo ? comboParts(combo) : null;
        if (parts && target === parts.input) setOpen(parts, false);
        trapTab(dialog, event);
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
      if (parts && target === parts.input && owned(event)) comboInput(parts);
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
        const tabs = closestElement(record.target)?.closest(
          '[data-nv-ui="tabs"]',
        );
        const target = closestElement(record.target);
        if (tabs && target?.hasAttribute('data-nv-ui-inactive'))
          setupTabs(tabs);
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
    attributeFilter: ['data-nv-ui-inactive'],
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
