/**
 * Live/HBS helper: binds a server-rendered form or button to a typed action
 * without a framework. State is reflected in attributes the page can style
 * (`data-nv-action-state`, `aria-busy`), validation issues are mapped to
 * `aria-invalid` fields and `[data-nv-error-for]` slots, and every outcome
 * is dispatched as a bubbling `nv:action` event. Text is assigned with
 * `textContent`; server messages are never parsed as HTML.
 */
import { createActionController } from './state.js';
import type { ActionControllerOptions } from './state.js';
import type {
  ActionFailure,
  ActionFieldOf,
  ActionOutputOf,
  AnyActionMethod,
} from './index.js';

export interface ActionElementOptions<
  M extends AnyActionMethod,
> extends ActionControllerOptions<M> {
  /** Builds the action input from the element (for example from `FormData`). */
  readonly input: (element: HTMLElement, event: Event) => Parameters<M>[0];
  /** DOM event, default `submit` for forms and `click` otherwise. */
  readonly event?: string;
  readonly onSettled?: (
    outcome:
      | { readonly ok: true; readonly data: ActionOutputOf<M> }
      | { readonly ok: false; readonly error: ActionFailure<ActionFieldOf<M>> },
    element: HTMLElement,
  ) => void;
}

function fieldErrors(
  element: HTMLElement,
  error: ActionFailure | undefined,
): void {
  for (const field of element.querySelectorAll('[aria-invalid="true"]'))
    field.removeAttribute('aria-invalid');
  for (const slot of element.querySelectorAll<HTMLElement>(
    '[data-nv-error-for]',
  ))
    slot.textContent = '';
  if (!error) return;
  for (const issue of error.issues) {
    const name = issue.path[0];
    if (typeof name !== 'string' || !/^[A-Za-z_][\w.-]{0,127}$/.test(name))
      continue;
    for (const field of element.querySelectorAll(`[name="${name}"]`))
      field.setAttribute('aria-invalid', 'true');
    for (const slot of element.querySelectorAll<HTMLElement>(
      `[data-nv-error-for="${name}"]`,
    ))
      slot.textContent = issue.message;
  }
}

/** Returns an unbind function that removes the listener and aborts a running call. */
export function bindActionElement<M extends AnyActionMethod>(
  element: HTMLElement,
  method: M,
  options: ActionElementOptions<M>,
): () => void {
  const controller = createActionController(method, options);
  const type =
    options.event ?? (element.tagName === 'FORM' ? 'submit' : 'click');
  const view = element.ownerDocument.defaultView;
  const listener = (event: Event) => {
    event.preventDefault();
    if (controller.getSnapshot().pending) return;
    let input: Parameters<M>[0];
    try {
      input = options.input(element, event);
    } catch {
      return;
    }
    element.setAttribute('aria-busy', 'true');
    element.setAttribute('data-nv-action-state', 'pending');
    const settled = Reflect.apply(controller.run, undefined, [
      input,
    ]) as ReturnType<typeof controller.run>;
    void settled.then((outcome) => {
      element.removeAttribute('aria-busy');
      element.setAttribute(
        'data-nv-action-state',
        outcome.ok ? 'success' : 'error',
      );
      fieldErrors(element, outcome.ok ? undefined : outcome.error);
      options.onSettled?.(outcome, element);
      if (view)
        element.dispatchEvent(
          new view.CustomEvent('nv:action', {
            bubbles: true,
            detail: outcome.ok
              ? { ok: true, data: outcome.data }
              : {
                  ok: false,
                  code: outcome.error.code,
                  reason: outcome.error.reason,
                  issues: outcome.error.issues,
                },
          }),
        );
    });
  };
  element.addEventListener(type, listener);
  return () => {
    element.removeEventListener(type, listener);
    controller.abort();
  };
}
