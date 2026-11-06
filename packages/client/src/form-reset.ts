import { LiveClientError } from './grammar.js';
import {
  getModelDirective,
  isCheckbox,
  readModelValue,
  sameModelValue,
} from './models.js';
import type { ModelDirective, ModelValue } from './models.js';

export interface ResetControl {
  readonly element: Element;
  readonly directive: ModelDirective;
  readonly signature: string;
}
export interface ResetField<Owner> {
  readonly owner: Owner;
  readonly field: string;
  readonly controls: readonly ResetControl[];
}
function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}
export function resetSignature(element: Element): string {
  return JSON.stringify([
    element.tagName,
    element.tagName === 'INPUT' ? (element as HTMLInputElement).type : null,
    element.tagName === 'SELECT'
      ? (element as HTMLSelectElement).multiple
      : null,
    [...element.attributes]
      .filter(({ name }) => name === 'nv:model' || name.startsWith('nv:model.'))
      .map(({ name, value }) => [name, value]),
  ]);
}
/** `group`: the field is array state, so its checkboxes reset as one value group. */
export function resetValue(
  controls: readonly ResetControl[],
  group = false,
): ModelValue {
  let value: ModelValue | undefined;
  const boxes = controls
    .map((control) => control.element)
    .filter((element) => group && isCheckbox(element));
  for (const control of controls) {
    const candidate = readModelValue(
      control.element,
      control.directive,
      boxes.includes(control.element) ? boxes : undefined,
    );
    if (candidate === undefined) continue;
    if (value !== undefined && !sameModelValue(candidate, value))
      invalid(
        'Native reset requires consistent defaults for controls sharing a model field',
      );
    value = candidate;
  }
  if (value === undefined)
    invalid(
      'Native reset requires a selected radio default for each model field',
    );
  return value;
}
/** Predict native defaults without touching the real form or acquiring another renderer's state. */
export function planFormReset<Owner>(
  form: HTMLFormElement,
  owner: (element: Element) => Owner | undefined,
  group: (owner: Owner, field: string) => boolean = () => false,
): readonly ResetField<Owner>[] {
  const native = [...form.elements].filter((element) =>
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName),
  );
  const entries = native.map((element) => {
    const scope = owner(element);
    return {
      element,
      owner: scope,
      directive: scope === undefined ? undefined : getModelDirective(element),
    };
  });
  if (!entries.some((entry) => entry.directive !== undefined)) return [];
  for (const entry of entries) {
    if (!entry.directive || entry.element.tagName !== 'INPUT') continue;
    const input = entry.element as HTMLInputElement;
    if (input.type !== 'radio' || !input.name) continue;
    if (
      entries.some(
        (other) =>
          other.element.tagName === 'INPUT' &&
          (other.element as HTMLInputElement).type === 'radio' &&
          (other.element as HTMLInputElement).name === input.name &&
          other.owner !== entry.owner,
      )
    )
      invalid(
        'Native reset cannot reconcile model radio groups across ownership boundaries',
      );
  }
  const probe = form.ownerDocument.createElement('form');
  const clones = new Map<Element, Element>();
  const radioNames = new Set(
    entries
      .filter(
        ({ element, directive }) =>
          directive &&
          element.tagName === 'INPUT' &&
          (element as HTMLInputElement).type === 'radio',
      )
      .map(({ element }) => (element as HTMLInputElement).name),
  );
  for (const { element, directive } of entries) {
    if (
      !directive &&
      !(
        element.tagName === 'INPUT' &&
        (element as HTMLInputElement).type === 'radio' &&
        radioNames.has((element as HTMLInputElement).name)
      )
    )
      continue;
    const clone = element.cloneNode(true) as Element;
    clone.removeAttribute('form');
    probe.append(clone);
    clones.set(element, clone);
  }
  const view = form.ownerDocument.defaultView;
  if (!view) invalid('Native reset requires an attached browser document');
  view.HTMLFormElement.prototype.reset.call(probe);
  const groups = new Map<Owner, Map<string, ResetControl[]>>();
  for (const entry of entries) {
    if (entry.owner === undefined || !entry.directive) continue;
    const fields = groups.get(entry.owner) ?? new Map<string, ResetControl[]>();
    const controls = fields.get(entry.directive.field) ?? [];
    controls.push({
      element: entry.element,
      directive: entry.directive,
      signature: resetSignature(entry.element),
    });
    fields.set(entry.directive.field, controls);
    groups.set(entry.owner, fields);
  }
  const result: ResetField<Owner>[] = [];
  for (const [scope, fields] of groups)
    for (const [field, controls] of fields) {
      resetValue(
        controls.map((control) => {
          const clone = clones.get(control.element);
          if (!clone) return invalid('Missing native reset prediction');
          return { ...control, element: clone };
        }),
        group(scope, field),
      );
      result.push({ owner: scope, field, controls });
    }
  return result;
}
