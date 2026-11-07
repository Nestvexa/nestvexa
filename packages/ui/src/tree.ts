/**
 * Element tree of the @nestvexa/ui markup contract, shared by the builders in
 * `markup.ts`, `fields.ts` and `chart.ts`. Browser-safe: no Node or DOM access.
 */
import { attributes, escapeHtml } from './html.js';

/** `true` renders a bare (boolean) attribute. */
export type MarkupAttributeValue = string | true;
export interface MarkupElement {
  readonly tag: string;
  /** Attributes in output order. */
  readonly attributes: Readonly<Record<string, MarkupAttributeValue>>;
  readonly children: readonly MarkupNode[];
}
/** Placeholder for caller content: a block body, tab panel or table body. */
export interface MarkupSlot {
  readonly slot: string;
}
/** Strings are text and are always escaped by renderers. */
export type MarkupNode = MarkupElement | MarkupSlot | string;
/** Builder input: a plain object (template hash or framework props). */
export type MarkupInput = Readonly<Record<string, unknown>>;

/** Elements that never have children or a closing tag. */
export const voidElements: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
/** Attributes whose presence (not value) carries the meaning. */
export const booleanAttributes: ReadonlySet<string> = new Set([
  'checked',
  'disabled',
  'hidden',
  'multiple',
  'open',
  'readonly',
  'required',
  'selected',
]);

export function element(
  tag: string,
  values: Readonly<Record<string, string | number | boolean | undefined>>,
  children: readonly MarkupNode[] = [],
): MarkupElement {
  const output: Record<string, MarkupAttributeValue> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    output[name] = value === true ? true : String(value);
  }
  return Object.freeze({
    tag,
    attributes: Object.freeze(output),
    children: Object.freeze([...children]),
  });
}
export const slot = (name: string): MarkupSlot => Object.freeze({ slot: name });

export function isMarkupSlot(node: MarkupNode): node is MarkupSlot {
  return typeof node === 'object' && 'slot' in node;
}

/**
 * Print a tree as HTML. Text is escaped; slot contents are inserted as given,
 * so they must already be trusted HTML (for example a rendered template block).
 */
export function renderMarkup(
  node: MarkupNode,
  slots: Readonly<Record<string, string>> = {},
): string {
  if (typeof node === 'string') return escapeHtml(node);
  if (isMarkupSlot(node))
    return Object.hasOwn(slots, node.slot) ? (slots[node.slot] ?? '') : '';
  const open = `<${node.tag}${attributes(node.attributes)}>`;
  if (voidElements.has(node.tag)) return open;
  return `${open}${node.children.map((child) => renderMarkup(child, slots)).join('')}</${node.tag}>`;
}
