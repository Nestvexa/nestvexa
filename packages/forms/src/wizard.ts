import { validateForm } from './adapter.js';
import type { SchemaAdapter } from './adapter.js';
import { pathWithin, pickErrors, safeKey } from './errors.js';
import type { FormErrors } from './errors.js';
import type { InputLimits } from './harden.js';

/** One wizard step: its top-level fields and the schema that validates them. */
export interface WizardStepDefinition {
  /** Stable step id, `[a-z][a-z0-9-]{0,63}`. */
  readonly id: string;
  readonly title?: string;
  readonly fields: readonly string[];
  readonly adapter: SchemaAdapter<unknown>;
}
/** JSON progress, safe to keep in read-only Live state or a session. */
export interface WizardState {
  readonly step: number;
  /** Ids of steps that passed validation, in step order. */
  readonly completed: readonly string[];
}
export interface WizardPosition {
  readonly id: string;
  readonly title: string;
  readonly index: number;
  /** 1-based number for display. */
  readonly number: number;
  readonly count: number;
  readonly first: boolean;
  readonly last: boolean;
  readonly fields: readonly string[];
}
export interface WizardStepResult {
  readonly ok: boolean;
  readonly state: WizardState;
  readonly errors: FormErrors;
}
export type WizardFinish<T> =
  | { readonly ok: true; readonly value: T; readonly state: WizardState }
  | {
      readonly ok: false;
      readonly errors: FormErrors;
      readonly state: WizardState;
    };
export interface Wizard<T> {
  readonly steps: readonly Omit<WizardStepDefinition, 'adapter'>[];
  /** Every field across all steps. */
  readonly fields: readonly string[];
  initial(): WizardState;
  position(state: WizardState): WizardPosition;
  /** Validate the current step; on success mark it complete and advance. */
  next(
    state: WizardState,
    values: Readonly<Record<string, unknown>>,
  ): Promise<WizardStepResult>;
  /** Go one step back (never below the first). Completed steps stay complete. */
  back(state: WizardState): WizardState;
  /** Jump to a completed step or the first incomplete one; later steps are refused. */
  goTo(state: WizardState, id: string): WizardState;
  reset(): WizardState;
  /**
   * Re-validate every step in order (the server never trusts `completed`), then
   * the optional final adapter. On failure the state points at the first step
   * with errors.
   */
  finish(
    state: WizardState,
    values: Readonly<Record<string, unknown>>,
  ): Promise<WizardFinish<T>>;
}
export interface WizardOptions<T> {
  /** Cross-step schema run on all fields after every step passed. */
  readonly final?: SchemaAdapter<T>;
  readonly limits?: InputLimits;
}

/** Define a multi-step form; definitions are validated once at startup. */
export function defineWizard(
  steps: readonly WizardStepDefinition[],
  options?: Omit<WizardOptions<never>, 'final'>,
): Wizard<Record<string, unknown>>;
export function defineWizard<T>(
  steps: readonly WizardStepDefinition[],
  options: WizardOptions<T> & { readonly final: SchemaAdapter<T> },
): Wizard<T>;
export function defineWizard<T>(
  steps: readonly WizardStepDefinition[],
  options: WizardOptions<T> = {},
): Wizard<T | Record<string, unknown>> {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20)
    throw new Error('A wizard needs 1–20 steps');
  const ids = new Set<string>();
  const owners = new Map<string, string>();
  const definitions = steps.map((step) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(step.id) || ids.has(step.id))
      throw new Error(`Invalid or duplicate wizard step id ${String(step.id)}`);
    ids.add(step.id);
    if (!step.adapter || typeof step.adapter.validate !== 'function')
      throw new Error(`Wizard step ${step.id} needs an adapter`);
    if (!Array.isArray(step.fields) || !step.fields.length)
      throw new Error(`Wizard step ${step.id} needs fields`);
    for (const field of step.fields) {
      if (typeof field !== 'string' || !safeKey(field))
        throw new Error(`Invalid wizard field ${String(field)}`);
      if (owners.has(field))
        throw new Error(`Wizard field ${field} belongs to two steps`);
      owners.set(field, step.id);
    }
    return Object.freeze({
      id: step.id,
      title: step.title ?? step.id,
      fields: Object.freeze([...step.fields]),
      adapter: step.adapter,
    });
  });
  const count = definitions.length;
  const read = (state: WizardState): WizardState => {
    const step: unknown =
      state && typeof state === 'object' ? Reflect.get(state, 'step') : 0;
    const completed: unknown =
      state && typeof state === 'object' ? Reflect.get(state, 'completed') : [];
    const done = new Set(
      Array.isArray(completed)
        ? completed.filter(
            (id): id is string => typeof id === 'string' && ids.has(id),
          )
        : [],
    );
    // Progress is a contiguous prefix: a later step is never complete before an earlier one.
    const prefix: string[] = [];
    for (const definition of definitions)
      if (done.has(definition.id)) prefix.push(definition.id);
      else break;
    const index =
      typeof step === 'number' && Number.isSafeInteger(step) ? step : 0;
    return freeze(
      Math.min(Math.max(index, 0), prefix.length, count - 1),
      prefix,
    );
  };
  const pick = (
    fields: readonly string[],
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const field of fields)
      if (Object.hasOwn(values, field)) result[field] = values[field];
    return result;
  };
  const check = async (
    index: number,
    values: Readonly<Record<string, unknown>>,
  ) => {
    const definition = definitions[index];
    if (!definition) throw new Error('Unknown wizard step');
    return validateForm(definition.adapter, pick(definition.fields, values), {
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  };
  const wizard: Wizard<T | Record<string, unknown>> = {
    steps: Object.freeze(
      definitions.map(({ id, title, fields }) =>
        Object.freeze({ id, title, fields }),
      ),
    ),
    fields: Object.freeze(definitions.flatMap((step) => step.fields)),
    initial: () => freeze(0, []),
    reset: () => freeze(0, []),
    position(state) {
      const current = read(state);
      const definition = definitions[current.step] ?? definitions[0];
      if (!definition) throw new Error('Unknown wizard step');
      return Object.freeze({
        id: definition.id,
        title: definition.title,
        index: current.step,
        number: current.step + 1,
        count,
        first: current.step === 0,
        last: current.step === count - 1,
        fields: definition.fields,
      });
    },
    async next(state, values) {
      const current = read(state);
      const result = await check(current.step, values);
      const definition = definitions[current.step];
      if (!definition) throw new Error('Unknown wizard step');
      if (!result.ok)
        return Object.freeze({
          ok: false,
          state: current,
          errors: pickErrors(result.errors, definition.fields),
        });
      const completed = current.completed.includes(definition.id)
        ? current.completed
        : [...current.completed, definition.id];
      return Object.freeze({
        ok: true,
        state: freeze(Math.min(current.step + 1, count - 1), completed),
        errors: Object.freeze({}),
      });
    },
    back(state) {
      const current = read(state);
      return freeze(Math.max(current.step - 1, 0), current.completed);
    },
    goTo(state, id) {
      const current = read(state);
      const index = definitions.findIndex((step) => step.id === id);
      if (index === -1 || index > current.completed.length)
        throw new Error('Wizard step is not reachable yet');
      return freeze(Math.min(index, count - 1), current.completed);
    },
    async finish(state, values) {
      read(state);
      const merged: Record<string, unknown> = {};
      const completed: string[] = [];
      for (let index = 0; index < count; index++) {
        const result = await check(index, values);
        const definition = definitions[index];
        if (!definition) throw new Error('Unknown wizard step');
        if (!result.ok)
          return Object.freeze({
            ok: false as const,
            errors: pickErrors(result.errors, definition.fields),
            state: freeze(index, completed),
          });
        completed.push(definition.id);
        const output = result.value;
        if (
          output !== null &&
          typeof output === 'object' &&
          !Array.isArray(output)
        )
          for (const field of definition.fields)
            if (Object.hasOwn(output, field))
              merged[field] = Reflect.get(output, field);
      }
      if (!options.final)
        return Object.freeze({
          ok: true as const,
          value: Object.freeze(merged),
          state: freeze(count - 1, completed),
        });
      const final = await validateForm(
        options.final,
        pick(wizard.fields, values),
        {
          ...(options.limits === undefined ? {} : { limits: options.limits }),
        },
      );
      if (final.ok)
        return Object.freeze({
          ok: true as const,
          value: final.value,
          state: freeze(count - 1, completed),
        });
      const failing = definitions.findIndex((step) =>
        Object.keys(final.errors).some((path) =>
          step.fields.some((field) => pathWithin(path, field)),
        ),
      );
      const index = failing === -1 ? count - 1 : failing;
      return Object.freeze({
        ok: false as const,
        errors: final.errors,
        state: freeze(index, completed.slice(0, index)),
      });
    },
  };
  return Object.freeze(wizard);
}
function freeze(step: number, completed: readonly string[]): WizardState {
  return Object.freeze({ step, completed: Object.freeze([...completed]) });
}
