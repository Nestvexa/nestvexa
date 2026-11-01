/** Native focus can fail silently when a target becomes hidden or disabled. */
export function availableForFocus(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.matches(':disabled') ||
    element.closest('[hidden], [inert]') ||
    element.getClientRects().length === 0
  )
    return false;
  const visibility =
    element.ownerDocument.defaultView?.getComputedStyle(element).visibility;
  return visibility !== 'hidden' && visibility !== 'collapse';
}

/** A body/document fallback does not distinguish native focus loss from an explicit host choice. */
export function focusMoved(document: Document, previous: Element): boolean {
  const active = document.activeElement;
  return (
    active !== null &&
    active !== previous &&
    active !== document.body &&
    active !== document.documentElement
  );
}

/**
 * After an `nv:submit` response: focus the first available control marked
 * `aria-invalid="true"` inside the submitted form, unless focus moved elsewhere
 * during the request (`previous` is the element focused at submit time;
 * `fallback` is the component root the client may refocus after a morph).
 */
export function focusFirstInvalid(
  form: Element,
  previous: Element | null,
  fallback: Element,
  owns: (element: Element) => boolean,
): boolean {
  if (!form.isConnected) return false;
  const document = form.ownerDocument;
  const active = document.activeElement;
  if (active !== fallback && previous && focusMoved(document, previous))
    return false;
  const view = document.defaultView;
  if (!view) return false;
  for (const candidate of form.querySelectorAll('[aria-invalid="true"]'))
    if (
      candidate instanceof view.HTMLElement &&
      owns(candidate) &&
      availableForFocus(candidate)
    ) {
      candidate.focus();
      return document.activeElement === candidate;
    }
  return false;
}

interface SelectionPoints {
  readonly anchor: Node;
  readonly anchorOffset: number;
  readonly focus: Node;
  readonly focusOffset: number;
}
function selectionPoints(document: Document): SelectionPoints | null {
  const selected = document.getSelection();
  if (
    !selected ||
    selected.rangeCount !== 1 ||
    !selected.anchorNode ||
    !selected.focusNode
  )
    return null;
  return {
    anchor: selected.anchorNode,
    anchorOffset: selected.anchorOffset,
    focus: selected.focusNode,
    focusOffset: selected.focusOffset,
  };
}
function sameSelection(
  left: SelectionPoints | null,
  right: SelectionPoints | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.anchor === right.anchor &&
      left.anchorOffset === right.anchorOffset &&
      left.focus === right.focus &&
      left.focusOffset === right.focusOffset)
  );
}
function editorPoint(host: HTMLElement, node: Node, offset: number): boolean {
  if (
    !host.contains(node) ||
    !node.isConnected ||
    ![1, 3].includes(node.nodeType)
  )
    return false;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const view = host.ownerDocument.defaultView;
  if (
    !view ||
    !(element instanceof view.HTMLElement) ||
    !element.isContentEditable
  )
    return false;
  for (
    let current: Element | null = element;
    current && current !== host;
    current = current.parentElement
  )
    if (current.matches('[nv\\:ignore], [data-nv-component], [data-nv-island]'))
      return false;
  const length =
    node.nodeType === 3
      ? (node.nodeValue?.length ?? 0)
      : node.childNodes.length;
  return offset >= 0 && offset <= length;
}

export interface EditorSelection {
  /** Synchronous host callbacks can deliberately replace or clear the selection. */
  observe(operation: () => void): void;
  restore(): void;
}

/** Preserve native anchor/focus points only in one retained, Live-owned light-DOM editing host. */
export function captureEditorSelection(
  focused: Element | null,
  root: Element,
): EditorSelection | null {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (
    !view ||
    !(focused instanceof view.HTMLElement) ||
    focused === root ||
    !focused.isContentEditable ||
    focused.parentElement?.isContentEditable ||
    focused.closest('[data-nv-component]') !== root ||
    focused.closest('[nv\\:ignore], [data-nv-island]')
  )
    return null;
  const points = selectionPoints(document);
  if (
    !points ||
    !editorPoint(focused, points.anchor, points.anchorOffset) ||
    !editorPoint(focused, points.focus, points.focusOffset)
  )
    return null;
  let interrupted = false;
  return {
    observe(operation): void {
      const before = selectionPoints(document);
      try {
        operation();
      } finally {
        if (!sameSelection(before, selectionPoints(document)))
          interrupted = true;
      }
    },
    restore(): void {
      if (
        interrupted ||
        focusMoved(document, focused) ||
        !availableForFocus(focused) ||
        !focused.isContentEditable ||
        focused.parentElement?.isContentEditable ||
        focused.closest('[data-nv-component]') !== root ||
        focused.closest('[nv\\:ignore], [data-nv-island]') ||
        !editorPoint(focused, points.anchor, points.anchorOffset) ||
        !editorPoint(focused, points.focus, points.focusOffset)
      )
        return;
      // Restore before explicit focus: WebKit can reset its caret after the focus
      // event. Selection restoration itself may focus the host; its focus handlers
      // then get the final choice, without a second range write afterward.
      document
        .getSelection()
        ?.setBaseAndExtent(
          points.anchor,
          points.anchorOffset,
          points.focus,
          points.focusOffset,
        );
    },
  };
}

interface LeaseOwner {
  forget(target: HTMLElement, record: TemporaryFocus): void;
}
interface TemporaryFocus {
  readonly leases: Map<LeaseOwner, Set<Element>>;
  cleanup(): void;
}
// DOM presentation ownership only: no application state or DOM access on import.
// Controllers from this module coordinate a shared parent fallback instead of
// removing another controller's still-active temporary tabindex.
const temporaryFocus = new WeakMap<HTMLElement, TemporaryFocus>();

function temporary(target: HTMLElement): TemporaryFocus {
  let released = false;
  const record: TemporaryFocus = {
    leases: new Map(),
    cleanup(): void {
      if (released) return;
      released = true;
      target.removeEventListener('blur', record.cleanup);
      if (temporaryFocus.get(target) === record) temporaryFocus.delete(target);
      if (target.getAttribute('tabindex') === '-1')
        target.removeAttribute('tabindex');
      for (const owner of record.leases.keys()) owner.forget(target, record);
      record.leases.clear();
    },
  };
  temporaryFocus.set(target, record);
  target.setAttribute('tabindex', '-1');
  // Attach before focus(): a trusted focus handler can redirect focus immediately.
  target.addEventListener('blur', record.cleanup, { once: true });
  return record;
}

export interface FocusController {
  /** Focus an available owning root or ancestor, borrowing tabindex only when absent. */
  focus(target: HTMLElement, owner: Element): void;
  beforeHiding(root: Element, element: Element): void;
  /** Release leases whose owner or target lies in this subtree. */
  release(node: Element): void;
  /** Release leases for detached or reparented owners/targets. */
  prune(): void;
  dispose(): void;
}

/** Temporary focusability with explicit owner lifetime, shared across this module's controllers. */
export function createFocusController(): FocusController {
  const records = new Map<HTMLElement, TemporaryFocus>();
  let disposed = false;
  const leaseOwner: LeaseOwner = {
    forget(target, record): void {
      if (records.get(target) === record) records.delete(target);
    },
  };
  function releaseOwners(
    predicate: (target: HTMLElement, owner: Element) => boolean,
  ): void {
    for (const [target, record] of records) {
      const owners = record.leases.get(leaseOwner);
      if (!owners) {
        records.delete(target);
        continue;
      }
      for (const owner of owners)
        if (predicate(target, owner)) owners.delete(owner);
      if (owners.size) continue;
      record.leases.delete(leaseOwner);
      leaseOwner.forget(target, record);
      if (!record.leases.size) record.cleanup();
    }
  }
  const controller: FocusController = {
    focus(target, owner): void {
      if (
        disposed ||
        !owner.isConnected ||
        (target !== owner && !target.contains(owner)) ||
        !availableForFocus(target)
      )
        return;
      let record = temporaryFocus.get(target);
      if (record && target.getAttribute('tabindex') !== '-1') {
        record.cleanup();
        record = undefined;
      }
      if (!target.hasAttribute('tabindex')) record = temporary(target);
      if (record) {
        const owners = record.leases.get(leaseOwner) ?? new Set<Element>();
        owners.add(owner);
        record.leases.set(leaseOwner, owners);
        records.set(target, record);
      }
      try {
        target.focus({ preventScroll: true });
      } catch (error) {
        releaseOwners(
          (candidate, scope) => candidate === target && scope === owner,
        );
        throw error;
      }
      if (target.ownerDocument.activeElement !== target)
        releaseOwners(
          (candidate, scope) => candidate === target && scope === owner,
        );
    },
    beforeHiding(root, element): void {
      const document = root.ownerDocument;
      const active = document.activeElement;
      const target = root === element ? root.parentElement : root;
      const view = document.defaultView;
      if (
        !active ||
        !element.contains(active) ||
        !target ||
        !view ||
        !(target instanceof view.HTMLElement)
      )
        return;
      controller.focus(target, root);
    },
    release(node): void {
      releaseOwners(
        (target, owner) =>
          node === target ||
          node.contains(target) ||
          node === owner ||
          node.contains(owner),
      );
    },
    prune(): void {
      releaseOwners(
        (target, owner) =>
          !target.isConnected ||
          !owner.isConnected ||
          (target !== owner && !target.contains(owner)),
      );
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      releaseOwners(() => true);
    },
  };
  return controller;
}
