import { LiveClientError, parseIdentifier } from './grammar.js';

export type SortDirective =
  | { readonly kind: 'sort'; readonly value: string }
  | { readonly kind: 'sort-item'; readonly id: string }
  | { readonly kind: 'sort-handle' };

function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}
function itemId(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ||
    ['constructor', 'prototype', '__proto__'].includes(value)
  )
    invalid(
      'Sort items require a stable ASCII identifier of 1 through 64 characters',
    );
  return value;
}
/** Closed list/item/handle grammar; no modifier or attribute value is evaluated as code. */
export function parseSortDirective(name: string, value: string): SortDirective {
  if (name === 'nv:sort')
    return { kind: 'sort', value: parseIdentifier(value) };
  if (name === 'nv:sort.item') return { kind: 'sort-item', id: itemId(value) };
  if (name === 'nv:sort.handle' && value === '') return { kind: 'sort-handle' };
  return invalid('Unsupported sort directive, modifier or handle value');
}

interface SortItem {
  readonly element: Element;
  readonly handle: Element;
  readonly id: string;
  readonly label: string;
}
interface SortPlan {
  readonly list: Element;
  readonly owner: Element;
  readonly action: string;
  readonly label: string;
  readonly items: readonly SortItem[];
}
function owned(element: Element, owner: Element): boolean {
  if (element.closest('[data-nv-component]') !== owner) return false;
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute('nv:ignore') ||
      current.hasAttribute('data-nv-island')
    )
      return false;
    if (current === owner) break;
  }
  return true;
}
function declaration(element: Element, name: string): Element | undefined {
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  )
    if (current.hasAttribute(name)) return current;
  return undefined;
}
function label(element: Element, fallback: boolean, owner: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  let value = element.getAttribute('aria-label');
  if (labelledBy !== null) {
    const references = labelledBy.trim().split(/\s+/);
    if (
      references.length > 8 ||
      references.some((id) => !/^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/.test(id))
    )
      invalid('Sort labels require 1 through 8 valid element references');
    value = references
      .map((id) => {
        // Incoming server HTML is validated in a detached component preview.
        // Resolve new labels there before consulting external document labels.
        const target =
          (owner.id === id ? owner : owner.querySelector(`[id="${id}"]`)) ??
          element.ownerDocument.getElementById(id);
        if (!target) invalid('Sort label reference is missing');
        return target.textContent ?? '';
      })
      .join(' ');
  }
  value ??= fallback ? (element.textContent ?? '') : '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (
    !normalized ||
    normalized.length > 256 ||
    [...normalized].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid(
      'Sort lists and handles require a nonempty accessible label of at most 256 characters',
    );
  return normalized;
}
function plan(list: Element, owner: Element): SortPlan {
  const action = parseIdentifier(list.getAttribute('nv:sort') ?? '');
  const role = list.getAttribute('role');
  if (
    list.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    (!['UL', 'OL'].includes(list.tagName) && role !== 'list') ||
    (role !== null && role !== 'list')
  )
    invalid('nv:sort requires a semantic list');
  const children = [...list.children];
  if (!children.length || children.length > 200)
    invalid('Sortable lists require 1 through 200 direct items');
  const items = children.map((element): SortItem => {
    const id = itemId(element.getAttribute('nv:sort.item') ?? '');
    const itemRole = element.getAttribute('role');
    if (
      !owned(element, owner) ||
      element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      (!['UL', 'OL'].includes(list.tagName) && itemRole !== 'listitem') ||
      (['UL', 'OL'].includes(list.tagName) && element.tagName !== 'LI') ||
      (itemRole !== null && itemRole !== 'listitem')
    )
      invalid('Sort items must be owned direct semantic list items');
    const handles = [element, ...element.querySelectorAll('*')].filter(
      (candidate) =>
        candidate.hasAttribute('nv:sort.handle') &&
        owned(candidate, owner) &&
        declaration(candidate, 'nv:sort.item') === element,
    );
    const handle = handles[0];
    if (
      handles.length !== 1 ||
      !handle ||
      handle.tagName !== 'BUTTON' ||
      handle.getAttribute('type')?.toLowerCase() !== 'button' ||
      handle.getAttribute('nv:sort.handle') !== ''
    )
      invalid('Each sort item requires one native type=button nv:sort.handle');
    if (
      [...handle.attributes].some((attribute) =>
        /^nv:(?:click|submit|keydown|model|confirm|loading|bind|show|dirty|offline)(?:\.|$)/.test(
          attribute.name,
        ),
      ) ||
      handle.querySelector(
        'button,input,select,textarea,a[href],[contenteditable]',
      )
    )
      invalid(
        'Sort handles cannot share interactive directive or descendant ownership',
      );
    return { element, handle, id, label: label(handle, true, owner) };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalid('Sort item identifiers must be unique within a list');
  return { list, owner, action, label: label(list, false, owner), items };
}
function plans(component: Element): SortPlan[] {
  const lists: Element[] = [];
  for (const element of [component, ...component.querySelectorAll('*')]) {
    if (!owned(element, component)) continue;
    for (const attribute of element.attributes) {
      if (!/^nv:sort(?:\.|$)/.test(attribute.name)) continue;
      const directive = parseSortDirective(attribute.name, attribute.value);
      if (directive.kind === 'sort') lists.push(element);
      else if (directive.kind === 'sort-item') {
        if (
          !element.parentElement?.hasAttribute('nv:sort') ||
          !owned(element.parentElement, component)
        )
          invalid('nv:sort.item requires a directly owning sortable list');
      } else {
        const item = declaration(element, 'nv:sort.item');
        if (
          !item?.parentElement?.hasAttribute('nv:sort') ||
          !owned(item.parentElement, component)
        )
          invalid('nv:sort.handle requires an owned sortable item');
      }
    }
  }
  return lists.map((list) => plan(list, component));
}
/** Validate list semantics and all owned sort declarations without mutating DOM or attaching listeners. */
export function validateSort(component: Element): void {
  if (!component.hasAttribute('data-nv-component'))
    invalid('Sort directives require a Live component root');
  plans(component);
}
export interface SortControllerOptions {
  readonly window: Window & typeof globalThis;
  readonly invoke: (
    list: Element,
    action: string,
    input: Readonly<{ ids: readonly string[] }>,
  ) => Promise<void>;
  readonly usable: (element: Element) => boolean;
  readonly onError: (error: unknown, element: Element) => void;
  readonly maxLists?: number;
}
export interface SortController {
  refresh(root: ParentNode): void;
  remove(node: Element): void;
  dispose(): void;
}
interface AttributeEffect {
  readonly element: Element;
  readonly name: string;
  baseline: string | null;
  applied: string | null;
}
interface SortRecord {
  readonly plan: SortPlan;
  readonly effects: AttributeEffect[];
  readonly listeners: readonly { event: string; listener: EventListener }[];
  status: HTMLElement;
  message: string;
  pending: boolean;
}
function same(previous: SortPlan, next: SortPlan): boolean {
  return (
    previous.owner === next.owner &&
    previous.action === next.action &&
    previous.label === next.label &&
    previous.items.length === next.items.length &&
    previous.items.every((item, index) => {
      const other = next.items[index];
      return (
        item.element === other?.element &&
        item.handle === other.handle &&
        item.id === other.id &&
        item.label === other.label
      );
    })
  );
}

/** Submit bounded order proposals; only a successful server render commits DOM order. */
export function createSortController(
  options: SortControllerOptions,
): SortController {
  const view = options.window;
  const limit = options.maxLists ?? 64;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    invalid('Sortable list capacity must be an integer from 1 through 256');
  const records = new Map<Element, SortRecord>();
  let drag: { record: SortRecord; item: SortItem } | undefined;
  let disposed = false;
  function write(effect: AttributeEffect, value: string | null): void {
    const current = effect.element.getAttribute(effect.name);
    if (current !== effect.applied) effect.baseline = current;
    if (value === null) effect.element.removeAttribute(effect.name);
    else effect.element.setAttribute(effect.name, value);
    effect.applied = value;
  }
  function effect(
    record: SortRecord,
    element: Element,
    name: string,
  ): AttributeEffect {
    let found = record.effects.find(
      (entry) => entry.element === element && entry.name === name,
    );
    if (!found) {
      const baseline = element.getAttribute(name);
      found = { element, name, baseline, applied: baseline };
      record.effects.push(found);
    }
    return found;
  }
  function status(record: SortRecord, message: string): void {
    record.message = message;
    if (!record.status.isConnected) {
      record.status = view.document.createElement('p');
      record.status.setAttribute('role', 'status');
      record.status.setAttribute('aria-live', 'polite');
      record.status.setAttribute('aria-atomic', 'true');
      record.plan.list.after(record.status);
    }
    record.status.textContent = message;
  }
  function pending(record: SortRecord, active: boolean): void {
    record.pending = active;
    if (record.plan.list !== record.plan.owner) {
      const busy = effect(record, record.plan.list, 'aria-busy');
      write(busy, active ? 'true' : busy.baseline);
    }
    for (const item of record.plan.items) {
      const disabled = effect(record, item.handle, 'disabled');
      // Disabling the focused native button would discard focus before the server morph.
      write(
        disabled,
        active && item.handle !== view.document.activeElement
          ? ''
          : disabled.baseline,
      );
      const ariaDisabled = effect(record, item.handle, 'aria-disabled');
      write(ariaDisabled, active ? 'true' : ariaDisabled.baseline);
    }
  }
  function release(record: SortRecord): void {
    if (drag?.record === record) drag = undefined;
    for (const { event, listener } of record.listeners)
      record.plan.list.removeEventListener(event, listener);
    for (const entry of record.effects) {
      if (entry.element.getAttribute(entry.name) !== entry.applied) continue;
      if (entry.baseline === null) entry.element.removeAttribute(entry.name);
      else entry.element.setAttribute(entry.name, entry.baseline);
    }
    record.status.remove();
    records.delete(record.plan.list);
  }
  function valid(record: SortRecord): boolean {
    if (disposed || records.get(record.plan.list) !== record) return false;
    try {
      if (
        record.plan.list.isConnected &&
        owned(record.plan.list, record.plan.owner) &&
        options.usable(record.plan.list) &&
        same(record.plan, plan(record.plan.list, record.plan.owner))
      )
        return true;
    } catch {
      /* Reconfigured invalid markup is rejected by refresh; stale handlers cannot dispatch. */
    }
    release(record);
    return false;
  }
  function targetItem(
    record: SortRecord,
    event: Event,
    handleOnly: boolean,
  ): SortItem | undefined {
    const target = event.target;
    if (
      !(target instanceof view.Element) ||
      !owned(target, record.plan.owner) ||
      !options.usable(target)
    )
      return undefined;
    return record.plan.items.find((item) =>
      handleOnly
        ? declaration(target, 'nv:sort.handle') === item.handle
        : declaration(target, 'nv:sort.item') === item.element,
    );
  }
  function submit(
    record: SortRecord,
    item: SortItem,
    destination: number,
  ): void {
    if (
      !valid(record) ||
      record.pending ||
      item.handle.matches(':disabled') ||
      item.handle.getAttribute('aria-disabled') === 'true'
    )
      return;
    const from = record.plan.items.indexOf(item);
    if (
      from < 0 ||
      destination < 0 ||
      destination >= record.plan.items.length ||
      from === destination
    )
      return;
    const ids = record.plan.items.map((entry) => entry.id);
    ids.splice(from, 1);
    ids.splice(destination, 0, item.id);
    const input = Object.freeze({ ids: Object.freeze(ids) });
    let dispatched = false;
    pending(record, true);
    status(
      record,
      `Moving ${item.label} to position ${destination + 1} of ${ids.length}. Waiting for server.`,
    );
    void Promise.resolve()
      .then(() => {
        if (valid(record)) {
          dispatched = true;
          return options.invoke(record.plan.list, record.plan.action, input);
        }
        return undefined;
      })
      .then(
        () => {
          const current = records.get(record.plan.list);
          if (
            dispatched &&
            current &&
            valid(current) &&
            current.plan.owner === record.plan.owner &&
            current.plan.action === record.plan.action
          )
            status(current, `Order updated for ${current.plan.label}.`);
        },
        (error: unknown) => {
          const current = records.get(record.plan.list);
          if (
            current &&
            valid(current) &&
            current.plan.owner === record.plan.owner &&
            current.plan.action === record.plan.action
          ) {
            status(current, `Order was not updated for ${current.plan.label}.`);
            options.onError(error, current.plan.list);
          }
        },
      )
      .finally(() => {
        if (records.get(record.plan.list) === record && valid(record))
          pending(record, false);
      });
  }
  function keyboard(record: SortRecord, event: Event): void {
    if (
      !(event instanceof view.KeyboardEvent) ||
      event.defaultPrevented ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.repeat ||
      event.isComposing ||
      !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) ||
      !valid(record)
    )
      return;
    const item = targetItem(record, event, true);
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    const index = record.plan.items.indexOf(item);
    const destination =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? record.plan.items.length - 1
          : index + (event.key === 'ArrowUp' ? -1 : 1);
    submit(record, item, destination);
  }
  function dragStart(record: SortRecord, event: Event): void {
    if (!(event instanceof view.DragEvent)) return;
    const item =
      valid(record) && !record.pending
        ? targetItem(record, event, true)
        : undefined;
    if (
      !item ||
      item.handle.matches(':disabled') ||
      item.handle.getAttribute('aria-disabled') === 'true'
    ) {
      event.preventDefault();
      return;
    }
    drag = { record, item };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Some engines require a drag payload. It contains no identity and is never read.
      event.dataTransfer.setData('application/x-nestvexa-sort', '1');
    }
    event.stopPropagation();
  }
  function dragTarget(record: SortRecord, event: Event): SortItem | undefined {
    if (
      !(event instanceof view.DragEvent) ||
      !drag ||
      drag.record !== record ||
      record.pending ||
      !valid(record)
    )
      return undefined;
    return targetItem(record, event, false);
  }
  function dragOver(record: SortRecord, event: Event): void {
    const item = dragTarget(record, event);
    if (!item || !(event instanceof view.DragEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }
  function drop(record: SortRecord, event: Event): void {
    const target = dragTarget(record, event);
    const source = drag;
    drag = undefined;
    if (!target || !source || !(event instanceof view.DragEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = target.element.getBoundingClientRect();
    if (!Number.isFinite(event.clientY) || bounds.height <= 0) return;
    const from = record.plan.items.indexOf(source.item);
    let destination =
      record.plan.items.indexOf(target) +
      (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0);
    if (from < destination) destination--;
    submit(record, source.item, destination);
  }
  function cancelDrag(): void {
    drag = undefined;
  }
  function escape(event: Event): void {
    if (event instanceof view.KeyboardEvent && event.key === 'Escape')
      cancelDrag();
  }
  view.document.addEventListener('dragend', cancelDrag);
  view.document.addEventListener('keydown', escape);
  view.addEventListener('blur', cancelDrag);
  return {
    refresh(root): void {
      if (disposed) return;
      const elements =
        root instanceof view.Element
          ? [root, ...root.querySelectorAll('[data-nv-component]')]
          : [...root.querySelectorAll('[data-nv-component]')];
      const owners = new Set(
        elements
          .map((element) => element.closest('[data-nv-component]'))
          .filter((element): element is Element => element !== null),
      );
      const next = [...owners]
        .filter((owner) => options.usable(owner))
        .flatMap(plans)
        .filter((entry) => options.usable(entry.list));
      for (const record of records.values()) valid(record);
      const additions = next.filter((entry) => !records.has(entry.list));
      if (records.size + additions.length > limit)
        invalid('Sortable list capacity reached');
      for (const entry of additions) {
        const listeners: { event: string; listener: EventListener }[] = [];
        const record: SortRecord = {
          plan: entry,
          effects: [],
          listeners,
          status: view.document.createElement('p'),
          message: '',
          pending: false,
        };
        records.set(entry.list, record);
        const bind = (
          event: string,
          handle: (record: SortRecord, event: Event) => void,
        ): void => {
          const listener: EventListener = (emitted) => {
            try {
              handle(record, emitted);
            } catch (error) {
              if (valid(record)) options.onError(error, entry.list);
            }
          };
          listeners.push({ event, listener });
          entry.list.addEventListener(event, listener);
        };
        bind('keydown', keyboard);
        bind('dragstart', dragStart);
        bind('dragenter', dragOver);
        bind('dragover', dragOver);
        bind('drop', drop);
        for (const item of entry.items) {
          write(effect(record, item.handle, 'draggable'), 'true');
          write(
            effect(record, item.handle, 'aria-keyshortcuts'),
            'Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End',
          );
        }
        status(record, '');
      }
      for (const record of records.values())
        if (valid(record) && !record.status.isConnected)
          status(record, record.message);
    },
    remove(node): void {
      for (const record of records.values())
        if (
          record.plan.list === node ||
          node.contains(record.plan.list) ||
          record.plan.list.contains(node)
        )
          release(record);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelDrag();
      view.document.removeEventListener('dragend', cancelDrag);
      view.document.removeEventListener('keydown', escape);
      view.removeEventListener('blur', cancelDrag);
      for (const record of records.values()) release(record);
    },
  };
}
