import { LiveClientError } from './protocol.js';
import { createControlMorph } from './control-state.js';
import type { ControlMorph } from './control-state.js';

export function boundary(element: Element): boolean {
  return (
    element.hasAttribute('nv:ignore') ||
    element.hasAttribute('data-nv-component') ||
    element.hasAttribute('data-nv-island')
  );
}
function key(node: Node): string | undefined {
  if (node.nodeType !== 1) return undefined;
  const element = node as Element;
  for (const attr of [
    'data-nv-key',
    'data-nv-component',
    'data-nv-island',
    'id',
  ]) {
    const value = element.getAttribute(attr);
    if (value) return `${attr}:${value}`;
  }
  return undefined;
}
function compatible(old: Node, next: Node): boolean {
  return (
    old.nodeType === next.nodeType &&
    (old.nodeType !== 1 ||
      (old as Element).tagName === (next as Element).tagName)
  );
}
export interface MorphLifecycle {
  /** Called before removing an outermost subtree; descendants are included in that notification. */
  readonly beforeRemove?: (node: Node) => void;
  /** Called after inserting a new outermost subtree; moving retained keyed nodes does not notify. */
  readonly afterInsert?: (node: Node) => void;
}

function replacement(element: Element): 'children' | 'self' | undefined {
  const children = element.getAttribute('nv:replace');
  const self = element.getAttribute('nv:replace.self');
  if (
    (children !== null && children !== '') ||
    (self !== null && self !== '') ||
    (children !== null && self !== null)
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'Use one empty nv:replace or nv:replace.self declaration',
    );
  if (
    children !== null &&
    [
      'AREA',
      'BASE',
      'BR',
      'COL',
      'EMBED',
      'HR',
      'IMG',
      'INPUT',
      'LINK',
      'META',
      'PARAM',
      'SOURCE',
      'TRACK',
      'WBR',
      'TEXTAREA',
      'SELECT',
    ].includes(element.tagName)
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'nv:replace requires a container; use nv:replace.self for native controls',
    );
  return self !== null ? 'self' : children !== null ? 'children' : undefined;
}

/** Check all owned sibling sets before changing any DOM, including late nested duplicates. */
function validateKeys(parent: Element | DocumentFragment, label: string): void {
  const keys = new Set<string>();
  for (const node of parent.childNodes) {
    const id = key(node);
    if (id) {
      if (keys.has(id))
        throw new LiveClientError('HTML', `Duplicate ${label} DOM key`);
      keys.add(id);
    }
    if (node.nodeType === 1) {
      const element = node as Element;
      if (!boundary(element)) {
        replacement(element);
        validateKeys(element, label);
      }
    }
  }
}
export function validateFragment(fragment: DocumentFragment): void {
  for (const element of fragment.querySelectorAll('*')) {
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
      throw new LiveClientError(
        'HTML',
        'Non-HTML namespaces are not supported in Live fragments',
      );
    if (
      ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'BASE', 'META', 'LINK'].includes(
        element.localName.toUpperCase(),
      )
    )
      throw new LiveClientError(
        'HTML',
        'Active document content is forbidden in Live fragments',
      );
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc')
        throw new LiveClientError(
          'HTML',
          'Inline event handlers are forbidden in Live fragments',
        );
      const compact = [...attribute.value]
        .filter((character) => character.charCodeAt(0) > 32)
        .join('');
      if (
        ['href', 'src', 'xlink:href', 'formaction', 'action'].includes(
          attribute.name,
        ) &&
        /^(?:javascript|vbscript|data):/i.test(compact)
      )
        throw new LiveClientError('HTML', 'Unsafe URL in Live fragment');
    }
  }
}
/**
 * Keyed nodes remain the same objects unless incoming markup explicitly replaces them.
 * Ownership boundaries retain their subtree; replacement deliberately resets local DOM state.
 */
export function morphChildren(
  parent: Element | DocumentFragment,
  incoming: Element | DocumentFragment,
  dirty: ReadonlyMap<string, unknown>,
  lifecycle: MorphLifecycle = {},
): void {
  validateKeys(parent, 'existing');
  validateKeys(incoming, 'incoming');
  const controls = createControlMorph(parent, incoming, dirty);
  patchChildren(parent, incoming, dirty, lifecycle, controls);
  controls.restore();
}
function remove(node: Node, lifecycle: MorphLifecycle): void {
  if (!node.parentNode) return;
  lifecycle.beforeRemove?.(node);
  node.parentNode?.removeChild(node);
}
function insert(
  parent: Element | DocumentFragment,
  node: Node,
  cursor: Node | null,
  lifecycle: MorphLifecycle,
): void {
  parent.insertBefore(node, cursor);
  lifecycle.afterInsert?.(node);
}
function replaceChildren(
  element: Element,
  incoming: Element,
  lifecycle: MorphLifecycle,
): void {
  for (const child of [...element.childNodes]) remove(child, lifecycle);
  for (const child of incoming.childNodes)
    insert(element, child.cloneNode(true), null, lifecycle);
}
function patchChildren(
  parent: Element | DocumentFragment,
  incoming: Element | DocumentFragment,
  dirty: ReadonlyMap<string, unknown>,
  lifecycle: MorphLifecycle,
  controls: ControlMorph,
): void {
  const originals = [...parent.childNodes];
  const keyed = new Map<string, Node>();
  for (const node of originals) {
    const id = key(node);
    if (id) keyed.set(id, node);
  }
  const retained = new Set<Node>();
  let cursor = parent.firstChild;
  for (const next of [...incoming.childNodes]) {
    const id = key(next);
    const candidate = id
      ? keyed.get(id)
      : cursor && !key(cursor)
        ? cursor
        : undefined;
    let current: Node;
    if (candidate && !retained.has(candidate) && compatible(candidate, next)) {
      const element =
        candidate.nodeType === 1 ? (candidate as Element) : undefined;
      const incomingElement =
        next.nodeType === 1 ? (next as Element) : undefined;
      if (
        element &&
        incomingElement &&
        !boundary(element) &&
        (boundary(incomingElement) || replacement(incomingElement) === 'self')
      ) {
        current = next.cloneNode(true);
        lifecycle.beforeRemove?.(candidate);
        parent.replaceChild(current, candidate);
        if (candidate !== cursor) parent.insertBefore(current, cursor);
        lifecycle.afterInsert?.(current);
      } else {
        current = candidate;
        if (current !== cursor) parent.insertBefore(current, cursor);
        morphNode(current, next, dirty, lifecycle, controls);
      }
    } else if (candidate && !retained.has(candidate)) {
      const insertionPoint =
        candidate === cursor ? candidate.nextSibling : cursor;
      remove(candidate, lifecycle);
      current = next.cloneNode(true);
      insert(parent, current, insertionPoint, lifecycle);
    } else {
      current = next.cloneNode(true);
      insert(parent, current, cursor, lifecycle);
    }
    retained.add(current);
    cursor = current.nextSibling;
  }
  for (const node of originals)
    if (!retained.has(node)) remove(node, lifecycle);
}
function morphNode(
  current: Node,
  next: Node,
  dirty: ReadonlyMap<string, unknown>,
  lifecycle: MorphLifecycle,
  controls: ControlMorph,
): void {
  if (current.nodeType !== 1 || next.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue)
      current.nodeValue = next.nodeValue;
    return;
  }
  const element = current as Element;
  const replacement = next as Element;
  if (boundary(element)) return;
  controls.prepare(element, replacement);
  for (const attribute of [...element.attributes])
    if (!replacement.hasAttribute(attribute.name))
      element.removeAttribute(attribute.name);
  for (const attribute of replacement.attributes)
    if (element.getAttribute(attribute.name) !== attribute.value)
      element.setAttribute(attribute.name, attribute.value);
  if (replacement.hasAttribute('nv:replace')) {
    replaceChildren(element, replacement, lifecycle);
    return;
  }
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return;
  if ('isContentEditable' in element && element.isContentEditable === true)
    return;
  patchChildren(element, replacement, dirty, lifecycle, controls);
}
