import { LiveClientError, parseIdentifier, parsePath } from './grammar.js';
import { createFocusController } from './focus.js';
import type { FocusController } from './focus.js';

export type BindingAttribute =
  | 'title'
  | 'aria-label'
  | 'aria-expanded'
  | 'aria-disabled'
  | 'href'
  | 'src'
  | 'disabled'
  | 'readonly';

export type BindingDirective =
  | { readonly kind: 'text' | 'show'; readonly field: string }
  | {
      readonly kind: 'bind';
      readonly field: string;
      readonly attribute: BindingAttribute;
    }
  | { readonly kind: 'dirty'; readonly field?: string }
  | { readonly kind: 'cloak' }
  | { readonly kind: 'ref'; readonly name: string };

const attributes = new Set<string>([
  'title',
  'aria-label',
  'aria-expanded',
  'aria-disabled',
  'href',
  'src',
  'disabled',
  'readonly',
]);

function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}

/** Parse configuration only: no expressions, indices, modifiers or executable code; fields may be dotted paths. */
export function parseBindingDirective(
  name: string,
  value: string,
): BindingDirective {
  switch (name) {
    case 'nv:text':
      return { kind: 'text', field: parsePath(value) };
    case 'nv:show':
      return { kind: 'show', field: parsePath(value) };
    case 'nv:dirty':
      return value === ''
        ? { kind: 'dirty' }
        : { kind: 'dirty', field: parsePath(value) };
    case 'nv:cloak':
      if (value !== '') invalid('nv:cloak must have an empty value');
      return { kind: 'cloak' };
    case 'nv:ref':
      return { kind: 'ref', name: parseIdentifier(value) };
    case 'nv:bind': {
      const parts = value.split(':');
      const attribute = parts[0];
      const field = parts[1];
      if (
        parts.length !== 2 ||
        !attribute ||
        !attributes.has(attribute) ||
        !field
      )
        invalid(
          'nv:bind requires an allowlisted attribute and public state field',
        );
      // Membership in the closed attribute set above proves this union.
      return {
        kind: 'bind',
        attribute: attribute as BindingAttribute,
        field: parsePath(field),
      };
    }
    default:
      return invalid('Unsupported binding directive or modifier');
  }
}

function text(value: unknown): string {
  if (value === null) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return String(value);
  return invalid('Text bindings require finite primitive public state');
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean')
    return invalid(
      'Visibility and boolean attributes require boolean public state',
    );
  return value;
}

function url(value: unknown, baseURI: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return invalid('URL binding contains an unsupported value');
  let parsed: URL;
  try {
    parsed = new URL(value, baseURI);
  } catch {
    return invalid('URL binding is invalid');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    return invalid('URL binding requires an HTTP(S) URL without credentials');
  return value;
}

/** Validate a resolved state value before applying any DOM changes. */
export function evaluateBinding(
  binding: BindingDirective,
  value: unknown,
  baseURI: string,
): string | boolean | null {
  switch (binding.kind) {
    case 'text':
      return text(value);
    case 'show':
    case 'dirty':
      return boolean(value);
    case 'bind':
      if (binding.attribute === 'href' || binding.attribute === 'src')
        return url(value, baseURI);
      if (
        binding.attribute === 'disabled' ||
        binding.attribute === 'readonly' ||
        binding.attribute === 'aria-expanded' ||
        binding.attribute === 'aria-disabled'
      )
        return boolean(value);
      return value === null ? null : text(value);
    case 'cloak':
    case 'ref':
      return invalid('This binding does not read state');
  }
}

function ownedElements(root: Element): Element[] {
  if (!root.hasAttribute('data-nv-component'))
    return invalid('Bindings require a Live component root');
  const result: Element[] = [];
  const visit = (element: Element): void => {
    if (
      element !== root &&
      (element.hasAttribute('data-nv-component') ||
        element.hasAttribute('data-nv-island'))
    )
      return;
    if (element.hasAttribute('nv:ignore')) return;
    result.push(element);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return result;
}

/** Resolve refs from current owned DOM only; duplicate names fail instead of choosing an unstable node. */
export function queryRefs(root: Element): ReadonlyMap<string, Element> {
  const refs = new Map<string, Element>();
  for (const element of ownedElements(root)) {
    const name = element.getAttribute('nv:ref');
    if (name === null) continue;
    const binding = parseBindingDirective('nv:ref', name);
    if (binding.kind !== 'ref') return invalid('Invalid ref binding');
    if (refs.has(binding.name)) return invalid('Duplicate Live reference name');
    refs.set(binding.name, element);
  }
  return refs;
}

interface Operation {
  readonly element: Element;
  readonly binding: BindingDirective;
  readonly value: string | boolean | null;
}

/**
 * Apply the implemented state bindings to one owned component.
 * Validate every operation and ref before mutating DOM; cloak disappears only after success.
 */
export function applyBindings(
  root: Element,
  read: (field: string) => unknown,
  isDirty: (field?: string) => boolean,
  focus: FocusController = createFocusController(),
  visibility?: (element: Element, shown: boolean, apply: () => void) => void,
): void {
  prepareBindings(root, read, isDirty, focus, visibility)();
}

/** Validate local state effects without cloning or mutating a live subtree. */
export function prepareBindings(
  root: Element,
  read: (field: string) => unknown,
  isDirty: (field?: string) => boolean,
  focus: FocusController = createFocusController(),
  visibility?: (element: Element, shown: boolean, apply: () => void) => void,
): () => void {
  const operations: Operation[] = [];
  const cloaked: Element[] = [];
  queryRefs(root);
  for (const element of ownedElements(root)) {
    for (const attribute of element.attributes) {
      if (
        ![
          'nv:text',
          'nv:show',
          'nv:bind',
          'nv:dirty',
          'nv:cloak',
          'nv:ref',
        ].includes(attribute.name)
      )
        continue;
      const binding = parseBindingDirective(attribute.name, attribute.value);
      if (binding.kind === 'cloak') {
        cloaked.push(element);
        continue;
      }
      if (binding.kind === 'ref') continue;
      if (
        binding.kind === 'text' &&
        (element.children.length > 0 ||
          ['INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE'].includes(
            element.tagName,
          ))
      )
        invalid('nv:text requires a non-interactive text-only element');
      if (
        (binding.kind === 'show' || binding.kind === 'dirty') &&
        element.hasAttribute('nv:show') &&
        element.hasAttribute('nv:dirty')
      )
        invalid('nv:show and nv:dirty cannot share a target');
      const value = evaluateBinding(
        binding,
        binding.kind === 'dirty' ? isDirty(binding.field) : read(binding.field),
        root.ownerDocument.baseURI,
      );
      operations.push({ element, binding, value });
    }
  }
  return (): void => {
    for (const { element, binding, value } of operations) {
      switch (binding.kind) {
        case 'text':
          element.textContent = String(value);
          break;
        case 'show':
        case 'dirty': {
          const shown = value === true;
          if (!shown) focus.beforeHiding(root, element);
          const apply = (): void => {
            element.toggleAttribute('hidden', !shown);
            element.setAttribute('aria-hidden', shown ? 'false' : 'true');
          };
          if (visibility) visibility(element, shown, apply);
          else apply();
          break;
        }
        case 'bind':
          if (
            binding.attribute === 'disabled' ||
            binding.attribute === 'readonly'
          )
            element.toggleAttribute(binding.attribute, value === true);
          else if (value === null) element.removeAttribute(binding.attribute);
          else element.setAttribute(binding.attribute, String(value));
          break;
        case 'cloak':
        case 'ref':
          break;
      }
    }
    for (const element of cloaked) element.removeAttribute('nv:cloak');
  };
}
