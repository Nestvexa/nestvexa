import { LiveClientError, parseIdentifier } from './grammar.js';

export type SortDirective =
  | { readonly kind: 'sort'; readonly value: string }
  | { readonly kind: 'sort-item'; readonly id: string }
  | { readonly kind: 'sort-handle' }
  /** Connects the list, under this stable key, to same-action lists of its component. */
  | { readonly kind: 'sort-group'; readonly id: string };
/**
 * Proposal sent to the list action: the new order of an unconnected list, or
 * for connected lists the moved item and the new order of every list it left
 * or entered (one key for a move within a list, two across lists).
 */
export type SortInput =
  | Readonly<{ ids: readonly string[] }>
  | Readonly<{
      item: string;
      lists: Readonly<Record<string, readonly string[]>>;
    }>;

function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}
function itemId(value: string, what = 'Sort items'): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ||
    ['constructor', 'prototype', '__proto__'].includes(value)
  )
    invalid(
      `${what} require a stable ASCII identifier of 1 through 64 characters`,
    );
  return value;
}
/** Closed list/item/handle/group grammar; no modifier or attribute value is evaluated as code. */
export function parseSortDirective(name: string, value: string): SortDirective {
  if (name === 'nv:sort')
    return { kind: 'sort', value: parseIdentifier(value) };
  if (name === 'nv:sort.item') return { kind: 'sort-item', id: itemId(value) };
  if (name === 'nv:sort.handle' && value === '') return { kind: 'sort-handle' };
  if (name === 'nv:sort.group')
    return { kind: 'sort-group', id: itemId(value, 'Connected sort lists') };
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
  readonly group: string | undefined;
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
  const groupValue = list.getAttribute('nv:sort.group');
  const group =
    groupValue === null
      ? undefined
      : itemId(groupValue, 'Connected sort lists');
  const children = [...list.children];
  // A connected list may be emptied by a cross-list move and receive items later.
  if (children.length > 200 || (!children.length && group === undefined))
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
  return {
    list,
    owner,
    action,
    group,
    label: label(list, false, owner),
    items,
  };
}
function plans(component: Element): SortPlan[] {
  const lists: Element[] = [];
  for (const element of [component, ...component.querySelectorAll('*')]) {
    if (!owned(element, component)) continue;
    for (const attribute of element.attributes) {
      if (!/^nv:sort(?:\.|$)/.test(attribute.name)) continue;
      const directive = parseSortDirective(attribute.name, attribute.value);
      if (directive.kind === 'sort') lists.push(element);
      else if (directive.kind === 'sort-group') {
        if (!element.hasAttribute('nv:sort'))
          invalid('nv:sort.group belongs on a sortable list');
      } else if (directive.kind === 'sort-item') {
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
  const result = lists.map((list) => plan(list, component));
  // Connected lists exchange items, so keys and item IDs are unique per group.
  const groups = new Map<string, { keys: Set<string>; ids: Set<string> }>();
  for (const entry of result) {
    if (entry.group === undefined) continue;
    let group = groups.get(entry.action);
    if (!group) {
      group = { keys: new Set(), ids: new Set() };
      groups.set(entry.action, group);
    }
    if (group.keys.has(entry.group))
      invalid('Connected sort lists need unique keys per action');
    group.keys.add(entry.group);
    for (const item of entry.items) {
      if (group.ids.has(item.id))
        invalid('Sort item identifiers must be unique across connected lists');
      group.ids.add(item.id);
    }
  }
  return result;
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
    input: SortInput,
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
  /** Handles whose inline `touch-action` this record set, with the prior value. */
  readonly touch: { readonly handle: HTMLElement; readonly previous: string }[];
  status: HTMLElement;
  message: string;
  pending: boolean;
}
interface Gesture {
  readonly record: SortRecord;
  readonly item: SortItem;
}
function same(previous: SortPlan, next: SortPlan): boolean {
  return (
    previous.owner === next.owner &&
    previous.action === next.action &&
    previous.group === next.group &&
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
/**
 * Items laid out in rows: the number of leading items sharing the first
 * item's row (1 for a vertical list). Read from live geometry at each gesture,
 * so responsive grids keep working after a resize.
 */
function columns(items: readonly SortItem[]): number {
  const first = items[0]?.element.getBoundingClientRect();
  if (!first) return 1;
  let count = 0;
  for (const item of items) {
    const bounds = item.element.getBoundingClientRect();
    if (Math.abs(bounds.top - first.top) >= Math.max(1, first.height / 2))
      break;
    count++;
  }
  return Math.max(1, count);
}
const keys =
  'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Home Alt+End';

/** Submit bounded order proposals; only a successful server render commits DOM order. */
export function createSortController(
  options: SortControllerOptions,
): SortController {
  const view = options.window;
  const limit = options.maxLists ?? 64;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    invalid('Sortable list capacity must be an integer from 1 through 256');
  const records = new Map<Element, SortRecord>();
  let drag: Gesture | undefined;
  let touch:
    | (Gesture & {
        readonly pointer: number;
        x: number;
        y: number;
        moved: boolean;
      })
    | undefined;
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
    if (touch?.record === record) touch = undefined;
    for (const { event, listener } of record.listeners)
      record.plan.list.removeEventListener(event, listener);
    for (const entry of record.effects) {
      if (entry.element.getAttribute(entry.name) !== entry.applied) continue;
      if (entry.baseline === null) entry.element.removeAttribute(entry.name);
      else entry.element.setAttribute(entry.name, entry.baseline);
    }
    // CSSOM writes are CSP-safe (no inline style attribute is parsed).
    for (const { handle, previous } of record.touch)
      if (handle.style.touchAction === 'none')
        handle.style.touchAction = previous;
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
  /** Same component, same action, both declared with `nv:sort.group`. */
  function linked(a: SortRecord, b: SortRecord): boolean {
    return (
      a !== b &&
      a.plan.group !== undefined &&
      b.plan.group !== undefined &&
      a.plan.owner === b.plan.owner &&
      a.plan.action === b.plan.action
    );
  }
  function disabled(handle: Element): boolean {
    return (
      handle.matches(':disabled') ||
      handle.getAttribute('aria-disabled') === 'true'
    );
  }
  function rtl(element: Element): boolean {
    return view.getComputedStyle(element).direction === 'rtl';
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
    source: SortRecord,
    item: SortItem,
    destination: number,
    target: SortRecord = source,
  ): void {
    const across = target !== source;
    if (
      !valid(source) ||
      source.pending ||
      (across &&
        (!linked(source, target) || !valid(target) || target.pending)) ||
      disabled(item.handle)
    )
      return;
    const from = source.plan.items.indexOf(item);
    if (
      from < 0 ||
      destination < 0 ||
      destination > target.plan.items.length - (across ? 0 : 1) ||
      (!across && from === destination)
    )
      return;
    const left = source.plan.items.map((entry) => entry.id);
    left.splice(from, 1);
    const entered = across ? target.plan.items.map((entry) => entry.id) : left;
    entered.splice(destination, 0, item.id);
    const lists: Record<string, readonly string[]> = {};
    if (source.plan.group !== undefined)
      lists[source.plan.group] = Object.freeze(left);
    if (across && target.plan.group !== undefined)
      lists[target.plan.group] = Object.freeze(entered);
    const input: SortInput =
      source.plan.group === undefined
        ? Object.freeze({ ids: Object.freeze(entered) })
        : Object.freeze({ item: item.id, lists: Object.freeze(lists) });
    const involved = across ? [source, target] : [source];
    let dispatched = false;
    for (const record of involved) pending(record, true);
    status(
      target,
      `Moving ${item.label} to position ${destination + 1} of ${entered.length}${across ? ` in ${target.plan.label}` : ''}. Waiting for server.`,
    );
    // The latest registration of each list, if it still describes the same
    // component action; morphs may replace records while the request runs.
    const current = (record: SortRecord): SortRecord | undefined => {
      const latest = records.get(record.plan.list);
      return latest &&
        valid(latest) &&
        latest.plan.owner === record.plan.owner &&
        latest.plan.action === record.plan.action
        ? latest
        : undefined;
    };
    void Promise.resolve()
      .then(() => {
        if (involved.every((record) => valid(record))) {
          dispatched = true;
          return options.invoke(target.plan.list, target.plan.action, input);
        }
        return undefined;
      })
      .then(
        () => {
          const latest = current(target);
          if (dispatched && latest)
            status(latest, `Order updated for ${latest.plan.label}.`);
        },
        (error: unknown) => {
          const latest = current(target);
          if (latest) {
            status(latest, `Order was not updated for ${latest.plan.label}.`);
            options.onError(error, latest.plan.list);
          }
        },
      )
      .finally(() => {
        for (const record of involved)
          if (records.get(record.plan.list) === record && valid(record))
            pending(record, false);
      });
  }
  /** Lists connected to this one, in document (reading) order, itself included. */
  function connected(record: SortRecord): SortRecord[] {
    return [...records.values()]
      .filter((entry) => entry === record || linked(record, entry))
      .sort((a, b) =>
        a.plan.list.compareDocumentPosition(b.plan.list) & 4 ? -1 : 1,
      );
  }
  function keyboard(record: SortRecord, event: Event): void {
    if (
      !(event instanceof view.KeyboardEvent) ||
      event.defaultPrevented ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      event.isComposing ||
      !(
        event.shiftKey
          ? ['ArrowLeft', 'ArrowRight']
          : ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
      ).includes(event.key) ||
      !valid(record)
    )
      return;
    const item = targetItem(record, event, true);
    if (!item) return;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    // Left/right follow the visual direction of the list.
    const step = (event.key === 'ArrowLeft') === rtl(record.plan.list) ? 1 : -1;
    const index = record.plan.items.indexOf(item);
    if (event.shiftKey) {
      // Alt+Shift+Left/Right: the previous/next connected list, same position.
      if (record.plan.group === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      const lists = connected(record);
      const next = lists[lists.indexOf(record) + step];
      if (next)
        submit(record, item, Math.min(index, next.plan.items.length), next);
      return;
    }
    const width = columns(record.plan.items);
    // A vertical list leaves Alt+Left/Right to the page and assistive technology.
    if (horizontal && width === 1) return;
    event.preventDefault();
    event.stopPropagation();
    const destination =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? record.plan.items.length - 1
          : horizontal
            ? index + step
            : index + (event.key === 'ArrowUp' ? -width : width);
    submit(record, item, destination);
  }
  /**
   * Insertion index for a pointer at (x, y) over `hit` inside `record`'s list,
   * or undefined when the gesture cannot drop there. Rows use the horizontal
   * midpoint (mirrored right-to-left); single columns the vertical midpoint.
   */
  function place(
    gesture: Gesture,
    record: SortRecord,
    hit: Element,
    x: number,
    y: number,
  ): number | undefined {
    const across = record !== gesture.record;
    if (
      (across && !linked(gesture.record, record)) ||
      record.pending ||
      !valid(record) ||
      !owned(hit, record.plan.owner) ||
      !options.usable(hit) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      return undefined;
    const target = record.plan.items.find(
      (item) => declaration(hit, 'nv:sort.item') === item.element,
    );
    // Connected lists accept drops on their empty area or padding at the end.
    if (!target)
      return across && record.plan.list.contains(hit)
        ? record.plan.items.length
        : undefined;
    const bounds = target.element.getBoundingClientRect();
    if (bounds.height <= 0 || bounds.width <= 0) return undefined;
    const after =
      columns(record.plan.items) > 1
        ? rtl(record.plan.list)
          ? x < bounds.left + bounds.width / 2
          : x > bounds.left + bounds.width / 2
        : y > bounds.top + bounds.height / 2;
    let destination = record.plan.items.indexOf(target) + (after ? 1 : 0);
    if (!across && record.plan.items.indexOf(gesture.item) < destination)
      destination--;
    return destination;
  }
  /** The innermost registered list containing an element. */
  function listOf(element: Element | null): SortRecord | undefined {
    for (let current = element; current; current = current.parentElement) {
      const record = records.get(current);
      if (record) return record;
    }
    return undefined;
  }
  function dragStart(record: SortRecord, event: Event): void {
    if (!(event instanceof view.DragEvent)) return;
    const item =
      valid(record) && !record.pending
        ? targetItem(record, event, true)
        : undefined;
    if (!item || disabled(item.handle)) {
      event.preventDefault();
      return;
    }
    touch = undefined;
    drag = { record, item };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Some engines require a drag payload. It contains no identity and is never read.
      event.dataTransfer.setData('application/x-nestvexa-sort', '1');
    }
    event.stopPropagation();
  }
  function dropTarget(record: SortRecord, event: Event): number | undefined {
    if (
      !(event instanceof view.DragEvent) ||
      !drag ||
      drag.record.pending ||
      !valid(drag.record) ||
      !(event.target instanceof view.Element)
    )
      return undefined;
    return place(drag, record, event.target, event.clientX, event.clientY);
  }
  function dragOver(record: SortRecord, event: Event): void {
    if (dropTarget(record, event) === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (event instanceof view.DragEvent && event.dataTransfer)
      event.dataTransfer.dropEffect = 'move';
  }
  function drop(record: SortRecord, event: Event): void {
    const source = drag;
    const destination = dropTarget(record, event);
    drag = undefined;
    if (!source || destination === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    submit(source.record, source.item, destination, record);
  }
  /**
   * Touch and pen: native HTML dragging is unavailable or long-press only on
   * most touch browsers, so a primary non-mouse pointer on a handle is tracked
   * with Pointer Events and dropped where it is released.
   */
  function pointerDown(record: SortRecord, event: Event): void {
    if (
      !(event instanceof view.PointerEvent) ||
      event.pointerType === 'mouse' ||
      !event.isPrimary ||
      event.button !== 0 ||
      !valid(record) ||
      record.pending
    )
      return;
    const item = targetItem(record, event, true);
    if (!item || disabled(item.handle)) return;
    touch = {
      record,
      item,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    try {
      item.handle.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is an optimization; document listeners still see the pointer. */
    }
  }
  function pointerMove(event: Event): void {
    if (
      !(event instanceof view.PointerEvent) ||
      event.pointerId !== touch?.pointer
    )
      return;
    // A short tap stays a button press (focus) rather than a move.
    if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 8)
      touch.moved = true;
    if (touch.moved && event.cancelable) event.preventDefault();
  }
  function pointerUp(event: Event): void {
    const gesture = touch;
    if (
      !(event instanceof view.PointerEvent) ||
      event.pointerId !== gesture?.pointer
    )
      return;
    touch = undefined;
    if (!gesture.moved || !valid(gesture.record) || gesture.record.pending)
      return;
    const hit = view.document.elementFromPoint(event.clientX, event.clientY);
    const record = listOf(hit);
    if (!hit || !record) return;
    const destination = place(
      gesture,
      record,
      hit,
      event.clientX,
      event.clientY,
    );
    if (destination === undefined) return;
    if (event.cancelable) event.preventDefault();
    submit(gesture.record, gesture.item, destination, record);
  }
  function cancelDrag(): void {
    drag = undefined;
    touch = undefined;
  }
  function escape(event: Event): void {
    if (event instanceof view.KeyboardEvent && event.key === 'Escape')
      cancelDrag();
  }
  function cancelTouch(event: Event): void {
    if (
      event instanceof view.PointerEvent &&
      event.pointerId === touch?.pointer
    )
      touch = undefined;
  }
  view.document.addEventListener('dragend', cancelDrag);
  view.document.addEventListener('keydown', escape);
  view.document.addEventListener('pointermove', pointerMove, {
    passive: false,
  });
  view.document.addEventListener('pointerup', pointerUp);
  view.document.addEventListener('pointercancel', cancelTouch);
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
          touch: [],
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
        bind('pointerdown', pointerDown);
        for (const item of entry.items) {
          write(effect(record, item.handle, 'draggable'), 'true');
          write(
            effect(record, item.handle, 'aria-keyshortcuts'),
            entry.group === undefined
              ? keys
              : `${keys} Alt+Shift+ArrowLeft Alt+Shift+ArrowRight`,
          );
          if (item.handle instanceof view.HTMLElement) {
            record.touch.push({
              handle: item.handle,
              previous: item.handle.style.touchAction,
            });
            item.handle.style.touchAction = 'none';
          }
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
      view.document.removeEventListener('pointermove', pointerMove);
      view.document.removeEventListener('pointerup', pointerUp);
      view.document.removeEventListener('pointercancel', cancelTouch);
      view.removeEventListener('blur', cancelDrag);
      for (const record of records.values()) release(record);
    },
  };
}
