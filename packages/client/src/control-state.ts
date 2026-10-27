import { coerceModelValue, getModelDirective } from './models.js';
import type { ModelDirective } from './models.js';

type Root = Element | DocumentFragment;
interface Base {
  readonly element: Element;
  readonly model: ModelDirective | undefined;
}
interface Input extends Base {
  readonly kind: 'input';
  readonly type: string;
  readonly value: string;
  readonly defaultValue: string;
  readonly checked: boolean;
  readonly defaultChecked: boolean;
  readonly group: string;
}
interface Textarea extends Base {
  readonly kind: 'textarea';
  readonly value: string;
  readonly defaultValue: string;
}
interface Select extends Base {
  readonly kind: 'select';
  readonly multiple: boolean;
  readonly selected: ReadonlySet<string>;
  readonly defaults: string;
}
type Control = Input | Textarea | Select;
interface Plan {
  readonly current: Control;
  readonly incoming: Control;
  readonly preserve: boolean;
  readonly preserveChecked: boolean;
}
function elements(root: Root): Element[] {
  const result: Element[] = [];
  const visit = (element: Element): void => {
    if (
      element.hasAttribute('nv:ignore') ||
      element.hasAttribute('data-nv-component') ||
      element.hasAttribute('data-nv-island')
    )
      return;
    result.push(element);
    for (const child of element.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return result;
}
function key(element: Element): string | undefined {
  for (const name of ['data-nv-key', 'id']) {
    const value = element.getAttribute(name);
    if (value) return JSON.stringify([name, value]);
  }
  return undefined;
}
function path(element: Element, root: Root): string {
  const indices: number[] = [];
  let node = element;
  while (node !== root) {
    const parent = node.parentNode;
    if (!parent || (parent.nodeType !== 1 && parent.nodeType !== 11))
      return 'outside';
    // DOM parents on this owned path are elements or document fragments.
    indices.unshift([...(parent as Root).children].indexOf(node));
    if (parent === root) break;
    node = parent as Element;
  }
  return JSON.stringify(indices);
}
function group(
  input: HTMLInputElement,
  root: Root,
  outer: HTMLFormElement | null,
  projected?: ReadonlyMap<string, HTMLFormElement | null>,
): string {
  if (!input.name)
    return JSON.stringify(['single', key(input) ?? path(input, root)]);
  let form = input.form;
  // Detached template radios do not resolve every explicit internal/external
  // form reference. Resolve against the projected tree, not the attribute text.
  if (projected) {
    const associated = input.getAttribute('form');
    const ancestor = input.closest('form');
    form =
      associated === null
        ? ancestor && ancestor !== root && root.contains(ancestor)
          ? ancestor
          : outer
        : associated === ''
          ? null
          : (projected.get(associated) ?? null);
  }
  const scope =
    form === null
      ? 'none'
      : form.id
        ? `id:${form.id}`
        : form !== root && root.contains(form)
          ? (key(form) ?? path(form, root))
          : 'outer';
  return JSON.stringify([scope, input.name]);
}
function projectedForms(
  current: Root,
  incoming: Root,
): ReadonlyMap<string, HTMLFormElement | null> {
  const targets = new Set(
    [...incoming.querySelectorAll('input[form]')].map(
      (element) => element.getAttribute('form') ?? '',
    ),
  );
  const owners = new Map<string, HTMLFormElement | null>();
  if (!targets.size) return owners;
  const visit = (node: Node): void => {
    if (node.nodeType === 1) {
      const element = node as Element;
      // The first matching ID controls association, including non-form IDs.
      if (targets.has(element.id) && !owners.has(element.id))
        owners.set(
          element.id,
          element.tagName === 'FORM' ? (element as HTMLFormElement) : null,
        );
    }
    const children = node === current ? incoming.childNodes : node.childNodes;
    for (const child of children) visit(child);
  };
  visit(current.getRootNode());
  return owners;
}
function options(select: HTMLSelectElement): Map<string, HTMLOptionElement> {
  const result = new Map<string, HTMLOptionElement>();
  const counts = new Map<string, number>();
  for (const option of select.options) {
    const identity = JSON.stringify([key(option) ?? 'value', option.value]);
    const occurrence = counts.get(identity) ?? 0;
    counts.set(identity, occurrence + 1);
    result.set(JSON.stringify([identity, occurrence]), option);
  }
  return result;
}
function capture(
  root: Root,
  outer: HTMLFormElement | null,
  projected?: ReadonlyMap<string, HTMLFormElement | null>,
): Map<Element, Control> {
  const result = new Map<Element, Control>();
  for (const element of elements(root)) {
    if (element.tagName === 'INPUT') {
      const input = element as HTMLInputElement;
      result.set(element, {
        element,
        model: getModelDirective(element),
        kind: 'input',
        type: input.type,
        value: input.value,
        defaultValue: input.defaultValue,
        checked: input.checked,
        defaultChecked: input.defaultChecked,
        group: group(input, root, outer, projected),
      });
    } else if (element.tagName === 'TEXTAREA') {
      const textarea = element as HTMLTextAreaElement;
      result.set(element, {
        element,
        model: getModelDirective(element),
        kind: 'textarea',
        value: textarea.value,
        defaultValue: textarea.defaultValue,
      });
    } else if (element.tagName === 'SELECT') {
      const select = element as HTMLSelectElement;
      const choices = [...options(select)];
      result.set(element, {
        element,
        model: getModelDirective(element),
        kind: 'select',
        multiple: select.multiple,
        selected: new Set(
          choices
            .filter(([, option]) => option.selected)
            .map(([identity]) => identity),
        ),
        defaults: JSON.stringify(
          choices
            .filter(([, option]) => option.defaultSelected)
            .map(([identity]) => identity)
            .sort(),
        ),
      });
    }
  }
  return result;
}
function radioDefaults(
  controls: ReadonlyMap<Element, Control>,
): Map<string, string> {
  const groups = new Map<string, string[]>();
  const counts = new Map<string, number>();
  for (const control of controls.values()) {
    if (control.kind !== 'input' || control.type !== 'radio') continue;
    const identity = JSON.stringify([
      control.group,
      key(control.element) ?? control.value,
    ]);
    const occurrence = counts.get(identity) ?? 0;
    counts.set(identity, occurrence + 1);
    const list = groups.get(control.group) ?? [];
    if (control.defaultChecked)
      list.push(JSON.stringify([identity, occurrence]));
    groups.set(control.group, list);
  }
  return new Map(
    [...groups].map(([name, defaults]) => [name, JSON.stringify(defaults)]),
  );
}
function sameModel(current: Control, incoming: Control): boolean {
  return (
    current.model !== undefined &&
    incoming.model !== undefined &&
    current.model.field === incoming.model.field &&
    current.model.cast === incoming.model.cast
  );
}
function radioValueKey(
  group: string,
  model: ModelDirective,
  value: string,
): string {
  return JSON.stringify([group, model.field, model.cast, value]);
}

export interface ControlMorph {
  prepare(current: Element, incoming: Element): void;
  restore(): void;
}
/** Snapshot browser values before any patch can change radio groups or option selectedness. */
export function createControlMorph(
  root: Root,
  incoming: Root,
  dirty: ReadonlyMap<string, unknown>,
): ControlMorph {
  const outerForm =
    root.nodeType === 1 ? (root as Element).closest('form') : null;
  const previous = capture(root, outerForm);
  const next = capture(incoming, outerForm, projectedForms(root, incoming));
  const previousDefaults = radioDefaults(previous);
  const nextDefaults = radioDefaults(next);
  const plans = new Map<Element, Plan>();
  const draftGroups = new Map<string, ModelDirective>();
  const radioValues = new Map<string, boolean>();
  // Do conversions before DOM mutation, including values on newly inserted radios.
  for (const control of next.values())
    if (
      control.kind === 'input' &&
      control.type === 'radio' &&
      control.model &&
      dirty.has(control.model.field)
    )
      radioValues.set(
        radioValueKey(control.group, control.model, control.value),
        Object.is(
          coerceModelValue(control.value, control.model.cast),
          dirty.get(control.model.field),
        ),
      );
  return {
    prepare(element, replacement): void {
      const current = previous.get(element);
      const target = next.get(replacement);
      if (!current || !target || current.kind !== target.kind) return;
      const local =
        sameModel(current, target) && dirty.has(current.model?.field ?? '');
      const unbound = current.model === undefined && target.model === undefined;
      let preserve = false;
      let preserveChecked = false;
      if (
        current.kind === 'input' &&
        target.kind === 'input' &&
        current.type === target.type
      ) {
        preserve =
          local || (unbound && current.defaultValue === target.defaultValue);
        preserveChecked =
          local ||
          (unbound &&
            current.defaultValue === target.defaultValue &&
            current.defaultChecked === target.defaultChecked &&
            current.group === target.group &&
            (current.type !== 'radio' ||
              previousDefaults.get(current.group) ===
                nextDefaults.get(target.group)));
        if (local && current.type === 'radio' && target.model)
          draftGroups.set(target.group, target.model);
      } else if (current.kind === 'textarea' && target.kind === 'textarea') {
        preserve =
          local || (unbound && current.defaultValue === target.defaultValue);
      } else if (
        current.kind === 'select' &&
        target.kind === 'select' &&
        current.multiple === target.multiple
      ) {
        preserve = local || (unbound && current.defaults === target.defaults);
      }
      plans.set(element, {
        current,
        incoming: target,
        preserve,
        preserveChecked,
      });
    },
    restore(): void {
      const remaining = elements(root);
      const owned = new Set(remaining);
      for (const [element, plan] of plans) {
        if (!owned.has(element)) continue;
        const { current, incoming: target, preserve } = plan;
        if (current.kind === 'input' && target.kind === 'input') {
          const input = element as HTMLInputElement;
          const value =
            preserve && !['checkbox', 'radio'].includes(input.type)
              ? current.value
              : target.value;
          if (input.type !== 'file' && input.value !== value)
            input.value = value;
          if (input.type === 'checkbox')
            input.checked = plan.preserveChecked
              ? current.checked
              : target.defaultChecked;
        } else if (current.kind === 'textarea' && target.kind === 'textarea') {
          const textarea = element as HTMLTextAreaElement;
          if (textarea.defaultValue !== target.defaultValue)
            textarea.defaultValue = target.defaultValue;
          const value = preserve ? current.value : target.value;
          if (textarea.value !== value) textarea.value = value;
        } else if (current.kind === 'select' && target.kind === 'select') {
          const select = element as HTMLSelectElement;
          const choices = options(select);
          let desired = preserve ? current.selected : target.selected;
          const available = [...desired].filter((identity) =>
            choices.has(identity),
          );
          if (
            !select.multiple &&
            !available.length &&
            preserve &&
            !current.model
          )
            desired = target.selected;
          if (
            [...choices].some(
              ([identity, option]) => option.selected !== desired.has(identity),
            )
          ) {
            select.selectedIndex = -1;
            for (const [identity, option] of choices)
              option.selected = desired.has(identity);
          }
        }
      }
      const radios: { input: HTMLInputElement; checked: boolean }[] = [];
      for (const element of remaining) {
        if (
          element.tagName !== 'INPUT' ||
          (element as HTMLInputElement).type !== 'radio'
        )
          continue;
        if (previous.has(element) && !plans.has(element)) continue;
        const input = element as HTMLInputElement;
        const scope = group(input, root, outerForm);
        const draft = draftGroups.get(scope);
        const model = getModelDirective(input);
        const plan = plans.get(element);
        const checked =
          draft &&
          model &&
          draft.field === model.field &&
          draft.cast === model.cast
            ? radioValues.get(radioValueKey(scope, model, input.value)) === true
            : plan?.current.kind === 'input' && plan.incoming.kind === 'input'
              ? plan.preserveChecked
                ? plan.current.checked
                : plan.incoming.defaultChecked
              : input.defaultChecked;
        radios.push({ input, checked });
      }
      for (const { input, checked } of radios)
        if (!checked) input.checked = false;
      for (const { input, checked } of radios)
        if (checked) input.checked = true;
    },
  };
}
