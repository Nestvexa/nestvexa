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

function insideEditor(element: Element): boolean {
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  )
    if (
      current.hasAttribute('contenteditable') &&
      current.getAttribute('contenteditable')?.toLowerCase() !== 'false'
    )
      return true;
  return false;
}
/** Wrapper-only ownership is deliberately separate from subtree ownership. */
export function validateIgnore(element: Element, root = false): void {
  const declarations = [...element.attributes].filter(
    (attribute) =>
      attribute.name === 'nv:ignore' || attribute.name.startsWith('nv:ignore.'),
  );
  if (!declarations.length) return;
  if (
    root ||
    declarations.length !== 1 ||
    declarations.some(
      (attribute) =>
        !['nv:ignore', 'nv:ignore.self'].includes(attribute.name) ||
        attribute.value !== '',
    )
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'Use one empty nv:ignore or nv:ignore.self on an inner element',
    );
  if (!element.hasAttribute('nv:ignore.self')) return;
  if (
    element.hasAttribute('data-nv-component') ||
    element.hasAttribute('data-nv-island') ||
    ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP'].includes(
      element.tagName,
    ) ||
    insideEditor(element)
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'nv:ignore.self requires a non-editable wrapper outside renderer roots; use nv:ignore for native controls or editors',
    );
  for (const attribute of element.attributes)
    if (
      /^nv:(?:bind|class|show|dirty|cloak|model|loading|target|replace)(?:\.|$)/.test(
        attribute.name,
      )
    )
      throw new LiveClientError(
        'DIRECTIVE',
        'nv:ignore.self cannot share a wrapper with attribute, model or replacement effects',
      );
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
      validateIgnore(element);
      if (!boundary(element)) {
        replacement(element);
        validateKeys(element, label);
      }
    }
  }
}

interface Pair {
  readonly next: Node;
  readonly candidate: Node | undefined;
}
/** The cursor is the first original node not yet consumed, including after keyed moves. */
function pairChildren(
  parent: Element | DocumentFragment,
  incoming: Element | DocumentFragment,
): Pair[] {
  const originals = [...parent.childNodes];
  const keyed = new Map<string, Node>();
  for (const node of originals) {
    const id = key(node);
    if (id) keyed.set(id, node);
  }
  const consumed = new Set<Node>();
  const pairs: Pair[] = [];
  let cursor = 0;
  for (const next of incoming.childNodes) {
    while (cursor < originals.length) {
      const node = originals[cursor];
      if (!node || !consumed.has(node)) break;
      cursor++;
    }
    const first = originals[cursor];
    const id = key(next);
    const found = id ? keyed.get(id) : first && !key(first) ? first : undefined;
    const candidate = found && !consumed.has(found) ? found : undefined;
    if (candidate) consumed.add(candidate);
    pairs.push({ next, candidate });
  }
  return pairs;
}
/** An explicitly refreshed child root replaces the retained one; others keep it. */
function refreshesComponent(current: Element, incoming: Element): boolean {
  return (
    current.hasAttribute('data-nv-component') &&
    incoming.hasAttribute('data-nv-component') &&
    incoming.hasAttribute('data-nv-refresh') &&
    !incoming.hasAttribute('data-nv-stub')
  );
}
function stubId(node: Node): string | undefined {
  if (node.nodeType !== 1) return undefined;
  const element = node as Element;
  if (!element.hasAttribute('data-nv-stub')) return undefined;
  return element.getAttribute('data-nv-component') ?? undefined;
}
/** Existing nested component roots by identity, for stubs whose position moved. */
function componentRoots(
  parent: Element | DocumentFragment,
): Map<string, Element> {
  const roots = new Map<string, Element>();
  for (const element of parent.querySelectorAll('[data-nv-component]')) {
    const id = element.getAttribute('data-nv-component');
    if (id) roots.set(id, element);
  }
  return roots;
}
function validateStubs(
  parent: Element | DocumentFragment,
  incoming: Element | DocumentFragment,
): void {
  const roots = componentRoots(parent);
  const seen = new Set<string>();
  for (const stub of incoming.querySelectorAll('[data-nv-stub]')) {
    const id = stub.getAttribute('data-nv-component');
    if (!id || stub.childNodes.length || seen.has(id) || !roots.has(id))
      throw new LiveClientError(
        'RESPONSE',
        'A retained child component is missing or duplicated; reload the page',
      );
    seen.add(id);
  }
}
/** Replace stubs inside a cloned subtree with the retained roots they name. */
function graftStubs(node: Node, roots: ReadonlyMap<string, Element>): Node {
  const own = roots.get(stubId(node) ?? '');
  if (own) return own;
  if (node.nodeType !== 1 && node.nodeType !== 11) return node;
  const container = node as Element | DocumentFragment;
  for (const stub of [...container.querySelectorAll('[data-nv-stub]')]) {
    const retained = roots.get(stub.getAttribute('data-nv-component') ?? '');
    if (retained) stub.replaceWith(retained);
  }
  return node;
}
function changesOwner(current: Element, incoming: Element): boolean {
  return (
    !boundary(current) &&
    (boundary(incoming) ||
      replacement(incoming) === 'self' ||
      current.hasAttribute('nv:ignore.self') !==
        incoming.hasAttribute('nv:ignore.self'))
  );
}
function directiveConfiguration(element: Element): string {
  return JSON.stringify(
    [...element.attributes]
      .filter((attribute) => attribute.name.startsWith('nv:'))
      .map((attribute) => [attribute.name, attribute.value])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}
function projectWrappers(
  parent: Element | DocumentFragment,
  incoming: Element | DocumentFragment,
): void {
  for (const { candidate, next } of pairChildren(parent, incoming)) {
    if (
      !candidate ||
      !compatible(candidate, next) ||
      candidate.nodeType !== 1 ||
      next.nodeType !== 1
    )
      continue;
    const current = candidate as Element;
    const target = next as Element;
    if (boundary(current) || changesOwner(current, target)) continue;
    if (current.hasAttribute('nv:ignore.self')) {
      if (directiveConfiguration(current) !== directiveConfiguration(target))
        throw new LiveClientError(
          'DIRECTIVE',
          'Retained nv:ignore.self directive configuration cannot change; replace its key or an ancestor',
        );
      for (const attribute of [...target.attributes])
        target.removeAttribute(attribute.name);
      for (const attribute of current.attributes)
        target.setAttribute(attribute.name, attribute.value);
    }
    if (!target.hasAttribute('nv:replace')) projectWrappers(current, target);
  }
}
/** Validate first, then project browser-owned wrapper attributes into an isolated incoming tree. */
export function prepareMorph(
  parent: Element | DocumentFragment,
  incoming: Element | DocumentFragment,
): Element | DocumentFragment {
  validateKeys(parent, 'existing');
  validateKeys(incoming, 'incoming');
  validateStubs(parent, incoming);
  if (
    !parent.querySelector('[nv\\:ignore\\.self]') &&
    !incoming.querySelector('[nv\\:ignore\\.self]')
  )
    return incoming;
  // The clone has the same root kind as the validated incoming DOM tree.
  const projected = incoming.cloneNode(true) as Element | DocumentFragment;
  projectWrappers(parent, projected);
  validateKeys(projected, 'projected');
  return projected;
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
  const projected = prepareMorph(parent, incoming);
  const controls = createControlMorph(parent, projected, dirty);
  patchChildren(
    parent,
    projected,
    dirty,
    lifecycle,
    controls,
    componentRoots(parent),
  );
  controls.restore();
}
function remove(node: Node, lifecycle: MorphLifecycle, parent?: Node): void {
  if (!node.parentNode || (parent && node.parentNode !== parent)) return;
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
  roots: ReadonlyMap<string, Element>,
): void {
  const originals = [...parent.childNodes];
  const retained = new Set<Node>();
  let cursor = parent.firstChild;
  for (const { next, candidate } of pairChildren(parent, incoming)) {
    let current: Node;
    if (candidate && !retained.has(candidate) && compatible(candidate, next)) {
      const element =
        candidate.nodeType === 1 ? (candidate as Element) : undefined;
      const incomingElement =
        next.nodeType === 1 ? (next as Element) : undefined;
      if (
        element &&
        incomingElement &&
        (changesOwner(element, incomingElement) ||
          refreshesComponent(element, incomingElement))
      ) {
        // Graft retained grandchildren before releasing the replaced subtree.
        current = graftStubs(next.cloneNode(true), roots);
        lifecycle.beforeRemove?.(candidate);
        parent.replaceChild(current, candidate);
        if (candidate !== cursor) parent.insertBefore(current, cursor);
        lifecycle.afterInsert?.(current);
      } else {
        current = candidate;
        if (current !== cursor) parent.insertBefore(current, cursor);
        morphNode(current, next, dirty, lifecycle, controls, roots);
      }
    } else {
      const moved = roots.get(stubId(next) ?? '');
      if (candidate && !retained.has(candidate)) {
        const insertionPoint =
          candidate === cursor ? candidate.nextSibling : cursor;
        remove(candidate, lifecycle, parent);
        cursor = insertionPoint;
      }
      if (moved) {
        // A retained child changed position: move the same root, never a stub.
        current = moved;
        parent.insertBefore(current, cursor);
      } else {
        current = graftStubs(next.cloneNode(true), roots);
        insert(parent, current, cursor, lifecycle);
      }
    }
    retained.add(current);
    cursor = current.nextSibling;
  }
  for (const node of originals)
    if (!retained.has(node)) remove(node, lifecycle, parent);
}
function morphNode(
  current: Node,
  next: Node,
  dirty: ReadonlyMap<string, unknown>,
  lifecycle: MorphLifecycle,
  controls: ControlMorph,
  roots: ReadonlyMap<string, Element>,
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
  if (!element.hasAttribute('nv:ignore.self')) {
    for (const attribute of [...element.attributes])
      if (!replacement.hasAttribute(attribute.name))
        element.removeAttribute(attribute.name);
    for (const attribute of replacement.attributes)
      if (element.getAttribute(attribute.name) !== attribute.value)
        element.setAttribute(attribute.name, attribute.value);
  }
  if (replacement.hasAttribute('nv:replace')) {
    replaceChildren(element, replacement, lifecycle);
    return;
  }
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return;
  if ('isContentEditable' in element && element.isContentEditable === true)
    return;
  patchChildren(element, replacement, dirty, lifecycle, controls, roots);
}
