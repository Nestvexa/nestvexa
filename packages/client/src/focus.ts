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
