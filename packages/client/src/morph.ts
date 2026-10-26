import { LiveClientError } from './protocol.js';
import { modelField } from './models.js';

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
/** Keyed nodes remain the same objects. Boundaries retain their entire owned subtree. */
export function morphChildren(
  parent: Element | DocumentFragment,
  incoming: Element | DocumentFragment,
  dirty: ReadonlyMap<string, unknown>,
): void {
  const originals = [...parent.childNodes];
  const keyed = new Map<string, Node>();
  for (const node of originals) {
    const id = key(node);
    if (id) {
      if (keyed.has(id))
        throw new LiveClientError('HTML', 'Duplicate existing DOM key');
      keyed.set(id, node);
    }
  }
  const incomingKeys = new Set<string>();
  for (const node of incoming.childNodes) {
    const id = key(node);
    if (id) {
      if (incomingKeys.has(id))
        throw new LiveClientError('HTML', 'Duplicate incoming DOM key');
      incomingKeys.add(id);
    }
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
      current = candidate;
      if (current !== cursor) parent.insertBefore(current, cursor);
      morphNode(current, next, dirty);
    } else {
      current = next.cloneNode(true);
      parent.insertBefore(current, cursor);
    }
    retained.add(current);
    cursor = current.nextSibling;
  }
  for (const node of originals)
    if (!retained.has(node)) node.parentNode?.removeChild(node);
}
function morphNode(
  current: Node,
  next: Node,
  dirty: ReadonlyMap<string, unknown>,
): void {
  if (current.nodeType !== 1 || next.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue)
      current.nodeValue = next.nodeValue;
    return;
  }
  const element = current as Element;
  const replacement = next as Element;
  if (boundary(element)) return;
  const model = modelField(element);
  const retainValue =
    (model !== undefined && dirty.has(model)) ||
    element.hasAttribute('contenteditable');
  const selected =
    element.tagName === 'SELECT'
      ? (element as HTMLSelectElement).value
      : undefined;
  for (const attribute of [...element.attributes])
    if (!replacement.hasAttribute(attribute.name))
      element.removeAttribute(attribute.name);
  for (const attribute of replacement.attributes)
    if (element.getAttribute(attribute.name) !== attribute.value)
      element.setAttribute(attribute.name, attribute.value);
  if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement;
    const nextInput = replacement as HTMLInputElement;
    if (input.type !== 'file' && !retainValue) {
      input.value = nextInput.value;
      input.checked = nextInput.checked;
    }
    return;
  }
  if (element.tagName === 'TEXTAREA') {
    if (!retainValue)
      (element as HTMLTextAreaElement).value = (
        replacement as HTMLTextAreaElement
      ).value;
    return;
  }
  if (element.hasAttribute('contenteditable')) return;
  morphChildren(element, replacement, dirty);
  if (element.tagName === 'SELECT')
    (element as HTMLSelectElement).value =
      retainValue && selected !== undefined
        ? selected
        : (replacement as HTMLSelectElement).value;
}
