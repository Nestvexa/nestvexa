/**
 * Form-field wrappers of the @nestvexa/ui markup contract: one labelled
 * control with an optional hint and error message, wired with `for`/`id`,
 * `aria-describedby`, `aria-invalid` and `required`/`aria-required`.
 *
 * Ids are deterministic: the control is `{id}`, the hint `{id}-hint` and the
 * error `{id}-error`, the same ids `@nestvexa/forms` `fieldView()` produces,
 * so a field view can be passed as `field` (read structurally; this module
 * does not import the forms package). Errors render as forms' own templates
 * do: a `role="alert"` element present only while the field is invalid.
 */
import {
  UiError,
  classes,
  count,
  flag,
  id,
  joinIds,
  list,
  oneOf,
  optionalId,
  optionalText,
  record,
  text,
} from './html.js';
import { element } from './tree.js';
import type { MarkupElement, MarkupInput, MarkupNode } from './tree.js';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const segment = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Live model path: 1 to 8 identifier segments (`address.city`). */
function modelPath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parts = typeof value === 'string' ? value.split('.') : [];
  if (
    parts.length === 0 ||
    parts.length > 8 ||
    parts.some((part) => !segment.test(part) || forbidden.has(part))
  )
    throw new UiError('ID', 'model must be 1 to 8 dotted identifiers');
  return parts.join('.');
}
const modifierToken =
  /^(?:defer|live|blur|change|lazy|number|boolean|debounce|throttle|\d{1,5}ms)$/;
/** `nv:model` attribute name with closed-vocabulary modifiers (`blur`, `live.debounce.300ms`). */
function modelAttribute(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'nv:model';
  const tokens = typeof value === 'string' ? value.split('.') : [];
  if (
    tokens.length === 0 ||
    tokens.length > 4 ||
    tokens.some((token) => !modifierToken.test(token))
  )
    throw new UiError(
      'ARGUMENT',
      'modelModifiers must be Live model modifiers such as blur or live.debounce.300ms',
    );
  return `nv:model.${tokens.join('.')}`;
}
/**
 * Control name: an identifier, a dotted path (`address.city`) or a bracket
 * path (`items[0][name]`, `tags[]`), the shapes `@nestvexa/forms` parses.
 */
const namePattern =
  /^[A-Za-z][A-Za-z0-9_-]{0,63}(?:(?:\.[A-Za-z0-9_-]{1,64}){1,7}|(?:\[[A-Za-z0-9_-]{0,64}\]){1,8})?$/;
function controlName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !namePattern.test(value) ||
    value.split(/[.[\]]/).some((part) => forbidden.has(part))
  )
    throw new UiError('ID', 'name must be an identifier or a form path');
  return value;
}

/** Messages of a field: a string, up to 5 strings, or none. */
function messageList(value: unknown, name: string): readonly string[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') return [text(value, name, 500)];
  if (!Array.isArray(value) || value.length > 5)
    throw new UiError('ARGUMENT', `${name} must be text or up to 5 messages`);
  return value.map((message: unknown) => text(message, name, 500));
}

/**
 * The `fieldView()` shape of `@nestvexa/forms` (read structurally): its `id`,
 * `errorId` and `messages` (or `message`) are used; `invalid`, `ariaInvalid`
 * and `describedBy` are accepted and derived again from the messages and hint.
 */
export interface FieldViewLike {
  readonly id: string;
  readonly errorId: string;
  readonly invalid?: boolean;
  readonly ariaInvalid?: string;
  readonly message?: string;
  readonly messages?: readonly string[];
  readonly describedBy?: string;
}

interface FieldParts {
  readonly controlId: string;
  readonly name: string | undefined;
  readonly label: string;
  readonly hint: string | undefined;
  readonly hintId: string;
  readonly messages: readonly string[];
  readonly errorId: string;
  readonly required: boolean;
  readonly disabled: boolean;
  readonly className: string | undefined;
  readonly describedBy: string | undefined;
  /** `[attribute name, model path]` when a Live model is bound. */
  readonly model: readonly [string, string] | undefined;
}
const fieldKeys = [
  'id',
  'errorId',
  'invalid',
  'ariaInvalid',
  'message',
  'messages',
  'describedBy',
];
/** Validate the options every field variant shares. */
function parts(input: MarkupInput): FieldParts {
  const view =
    input['field'] === undefined || input['field'] === null
      ? undefined
      : record(input['field'], 'field', fieldKeys);
  if (view && input['error'] !== undefined && input['error'] !== null)
    throw new UiError('ARGUMENT', 'Use either field or error');
  const controlId = id(input['id'] ?? view?.['id'], 'id');
  if (view && view['id'] !== controlId)
    throw new UiError('ID', 'id must match field.id');
  const errorId = view ? id(view['errorId'], 'errorId') : `${controlId}-error`;
  const viewMessages = view ? messageList(view['messages'], 'messages') : [];
  const messages = view
    ? viewMessages.length > 0
      ? viewMessages
      : messageList(view['message'], 'message')
    : messageList(input['error'], 'error');
  const path = modelPath(input['model']);
  const name = controlName(input['name']);
  if (path === undefined && name === undefined)
    throw new UiError('ID', 'name is required without a model');
  return {
    controlId,
    name,
    label: text(input['label'], 'label'),
    hint: optionalText(input['hint'], 'hint'),
    hintId: `${controlId}-hint`,
    messages,
    errorId,
    required: flag(input['required'], 'required'),
    disabled: flag(input['disabled'], 'disabled'),
    className: classes(input['class']),
    describedBy: optionalId(input['describedBy'], 'describedBy'),
    model:
      path === undefined
        ? undefined
        : [modelAttribute(input['modelModifiers']), path],
  };
}
/** Hint first, then the error while invalid. */
function described(field: FieldParts): string | undefined {
  return joinIds(
    field.describedBy,
    field.hint ? field.hintId : undefined,
    field.messages.length > 0 ? field.errorId : undefined,
  );
}
/** ARIA and Live attributes of the control element. */
function controlAttributes(
  field: FieldParts,
): Record<string, string | boolean | undefined> {
  const invalid = field.messages.length > 0;
  return {
    name: field.name,
    required: field.required,
    disabled: field.disabled,
    'aria-required': field.required ? 'true' : undefined,
    'aria-invalid': invalid ? 'true' : undefined,
    'aria-describedby': described(field),
    ...(field.model ? { [field.model[0]]: field.model[1] } : {}),
  };
}
function requiredMark(field: FieldParts): MarkupNode[] {
  return field.required
    ? [
        element(
          'span',
          { class: 'nv-field__required', 'aria-hidden': 'true' },
          ['*'],
        ),
      ]
    : [];
}
function label(field: FieldParts, forId: string): MarkupElement {
  return element('label', { class: 'nv-field__label', for: forId }, [
    field.label,
    ...requiredMark(field),
  ]);
}
function hint(field: FieldParts): MarkupNode[] {
  return field.hint
    ? [
        element('p', { class: 'nv-field__hint', id: field.hintId }, [
          field.hint,
        ]),
      ]
    : [];
}
function error(field: FieldParts): MarkupNode[] {
  if (field.messages.length === 0) return [];
  return [
    element(
      'div',
      { class: 'nv-field__error', id: field.errorId, role: 'alert' },
      field.messages.map((message) =>
        element('p', { class: 'nv-field__message' }, [message]),
      ),
    ),
  ];
}
function wrapper(
  field: FieldParts,
  variant: string,
  children: readonly MarkupNode[],
): MarkupElement {
  const base = `nv-field nv-field--${variant}`;
  return element(
    'div',
    {
      class: field.className ? `${base} ${field.className}` : base,
      'data-invalid': field.messages.length > 0,
    },
    children,
  );
}
function length(value: unknown, name: string): number | undefined {
  return value === undefined || value === null
    ? undefined
    : count(value, name, 1_000_000);
}
function lengths(input: MarkupInput): {
  readonly minlength: number | undefined;
  readonly maxlength: number | undefined;
} {
  const minlength = length(input['minLength'], 'minLength');
  const maxlength = length(input['maxLength'], 'maxLength');
  if (
    minlength !== undefined &&
    maxlength !== undefined &&
    minlength > maxlength
  )
    throw new UiError('ARGUMENT', 'minLength must not exceed maxLength');
  return { minlength, maxlength };
}
const autocompleteToken = /^[a-z][a-z0-9-]{0,31}$/;
/** Autofill detail tokens (`email`, `shipping street-address`, `off`). */
function autocomplete(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const tokens = typeof value === 'string' ? value.trim().split(/\s+/) : [];
  if (
    tokens.length === 0 ||
    tokens.length > 4 ||
    tokens.some((token) => !autocompleteToken.test(token))
  )
    throw new UiError('ARGUMENT', 'autocomplete must be autofill tokens');
  return tokens.join(' ');
}

// Text input ----------------------------------------------------------------
export const fieldInputTypes = [
  'text',
  'email',
  'password',
  'search',
  'tel',
  'url',
  'number',
] as const;
export type FieldInputType = (typeof fieldInputTypes)[number];
/**
 * Labelled text-like `<input>` (`type`: text, email, password, search, tel,
 * url or number) with hint and error. `model` binds `nv:model` (with
 * `modelModifiers`) for Live; the React, Vue and Svelte wrappers drop it.
 */
export function textFieldMarkup(input: MarkupInput): MarkupElement {
  const field = parts(input);
  const type = oneOf(input['type'], 'type', fieldInputTypes, 'text');
  const value = optionalText(input['value'], 'value', 10_000);
  return wrapper(field, 'input', [
    label(field, field.controlId),
    ...hint(field),
    element('input', {
      id: field.controlId,
      class: 'nv-field__control',
      type,
      value,
      placeholder: optionalText(input['placeholder'], 'placeholder'),
      autocomplete: autocomplete(input['autocomplete']),
      ...lengths(input),
      readonly: flag(input['readOnly'], 'readOnly'),
      ...controlAttributes(field),
    }),
    ...error(field),
  ]);
}

// Textarea ------------------------------------------------------------------
/** Labelled `<textarea>` (`rows` 1–50); `value` is its initial text. */
export function textareaFieldMarkup(input: MarkupInput): MarkupElement {
  const field = parts(input);
  const value = optionalText(input['value'], 'value', 100_000);
  const rows =
    input['rows'] === undefined || input['rows'] === null
      ? undefined
      : count(input['rows'], 'rows', 50);
  if (rows === 0) throw new UiError('ARGUMENT', 'rows must be 1 to 50');
  return wrapper(field, 'textarea', [
    label(field, field.controlId),
    ...hint(field),
    element(
      'textarea',
      {
        id: field.controlId,
        class: 'nv-field__control',
        rows,
        placeholder: optionalText(input['placeholder'], 'placeholder'),
        ...lengths(input),
        readonly: flag(input['readOnly'], 'readOnly'),
        ...controlAttributes(field),
      },
      value === undefined ? [] : [value],
    ),
    ...error(field),
  ]);
}

// Choices -------------------------------------------------------------------
interface Choice {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}
function choices(value: unknown, max: number): readonly Choice[] {
  const seen = new Set<string>();
  return list(value, 'options', max).map((entry) => {
    const option = record(entry, 'option', ['value', 'label', 'disabled']);
    const optionValue = text(option['value'], 'option value', 256);
    if (seen.has(optionValue))
      throw new UiError('ARGUMENT', 'Duplicate option value');
    seen.add(optionValue);
    return {
      value: optionValue,
      label: text(option['label'], 'label'),
      disabled: flag(option['disabled'], 'disabled'),
    };
  });
}
function chosen(input: MarkupInput, options: readonly Choice[]): string {
  const value = optionalText(input['value'], 'value', 256) ?? '';
  if (value && !options.some((option) => option.value === value))
    throw new UiError('ARGUMENT', 'value must be one of the options');
  return value;
}

/**
 * Labelled native `<select>` of 1–500 `{ value, label, disabled? }` options.
 * `placeholder` adds a first empty option (so `required` rejects it).
 */
export function selectFieldMarkup(input: MarkupInput): MarkupElement {
  const field = parts(input);
  const options = choices(input['options'], 500);
  const value = chosen(input, options);
  const placeholder = optionalText(input['placeholder'], 'placeholder');
  if (options.some((option) => option.value === '') && placeholder)
    throw new UiError('ARGUMENT', 'placeholder needs no empty option value');
  return wrapper(field, 'select', [
    label(field, field.controlId),
    ...hint(field),
    element(
      'select',
      {
        id: field.controlId,
        class: 'nv-field__control',
        autocomplete: autocomplete(input['autocomplete']),
        ...controlAttributes(field),
      },
      [
        ...(placeholder
          ? [
              element('option', { value: '', selected: value === '' }, [
                placeholder,
              ]),
            ]
          : []),
        ...options.map((option) =>
          element(
            'option',
            {
              value: option.value,
              selected: option.value === value && value !== '',
              disabled: option.disabled,
            },
            [option.label],
          ),
        ),
      ],
    ),
    ...error(field),
  ]);
}

/** Single checkbox followed by its label; `value` defaults to the browser's `on`. */
export function checkboxFieldMarkup(input: MarkupInput): MarkupElement {
  const field = parts(input);
  return wrapper(field, 'checkbox', [
    element('input', {
      id: field.controlId,
      class: 'nv-field__checkbox',
      type: 'checkbox',
      value: optionalText(input['value'], 'value', 256),
      checked: flag(input['checked'], 'checked'),
      ...controlAttributes(field),
    }),
    label(field, field.controlId),
    ...hint(field),
    ...error(field),
  ]);
}

/**
 * Radio group: `<fieldset role="radiogroup">` named by its `<legend>`, with
 * the hint and error on the group (`aria-describedby`, `aria-required`) and
 * `aria-invalid` on each radio, so Live's focus-first-invalid and a forms
 * error summary link (`#{id}`) both land on the first radio (`id`). Further
 * radios are `{id}-2`, `{id}-3`, …
 */
export function radioGroupFieldMarkup(input: MarkupInput): MarkupElement {
  const field = parts(input);
  const options = choices(input['options'], 100);
  const value = chosen(input, options);
  const control = controlAttributes(field);
  const radios = options.map((option, index) => {
    const radioId =
      index === 0 ? field.controlId : `${field.controlId}-${index + 1}`;
    return element('div', { class: 'nv-field__option' }, [
      element('input', {
        id: radioId,
        class: 'nv-field__radio',
        type: 'radio',
        name: field.name,
        value: option.value,
        checked: option.value === value,
        required: field.required,
        disabled: option.disabled,
        'aria-invalid': control['aria-invalid'],
        ...(field.model ? { [field.model[0]]: field.model[1] } : {}),
      }),
      element('label', { class: 'nv-field__option-label', for: radioId }, [
        option.label,
      ]),
    ]);
  });
  const base = 'nv-field nv-field--radio';
  return element(
    'fieldset',
    {
      class: field.className ? `${base} ${field.className}` : base,
      role: 'radiogroup',
      'aria-required': control['aria-required'],
      'aria-describedby': control['aria-describedby'],
      'data-invalid': field.messages.length > 0,
      disabled: field.disabled,
    },
    [
      element('legend', { class: 'nv-field__legend' }, [
        field.label,
        ...requiredMark(field),
      ]),
      ...hint(field),
      element('div', { class: 'nv-field__options' }, radios),
      ...error(field),
    ],
  );
}
