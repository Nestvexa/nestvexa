import type { FlagContext, FlagService } from './core.js';

export interface LiveFlagIdentity {
  readonly binding: string;
  readonly csrfToken: string;
}
/** Same shape as the Live `authorize` host policy. */
export type LiveAuthorize = (
  identity: LiveFlagIdentity,
  component: string,
  action: string,
) => boolean | Promise<boolean>;

const componentPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const actionPattern = /^[$a-zA-Z][a-zA-Z0-9_:$-]{0,127}$/;

/**
 * Wrap a Live `authorize` policy so components (`'assistant-panel'`) or single
 * actions (`'assistant-panel.approve'`) require an enabled flag. The flag is
 * checked first; the wrapped policy still decides everything else.
 */
export function liveFlagPolicy(
  service: FlagService,
  requirements: Readonly<Record<string, string>>,
  authorize: LiveAuthorize,
  context: (identity: LiveFlagIdentity) => FlagContext = (identity) => ({
    identity: identity.binding,
  }),
): LiveAuthorize {
  if (typeof authorize !== 'function' || typeof context !== 'function')
    throw new Error('liveFlagPolicy requires authorize and context functions');
  const prototype: unknown =
    requirements && typeof requirements === 'object'
      ? Object.getPrototypeOf(requirements)
      : undefined;
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Live flag requirements must be a plain object');
  const table = new Map<string, string>();
  for (const key of Reflect.ownKeys(requirements)) {
    const descriptor = Object.getOwnPropertyDescriptor(requirements, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
      throw new Error('Live flag requirements must be data properties');
    const separator = key.indexOf('.');
    const component = separator < 0 ? key : key.slice(0, separator);
    const action = separator < 0 ? undefined : key.slice(separator + 1);
    if (
      !componentPattern.test(component) ||
      (action !== undefined && !actionPattern.test(action))
    )
      throw new Error(`Invalid Live flag requirement key: ${key}`);
    const flag: unknown = descriptor.value;
    if (typeof flag !== 'string' || !service.flags.includes(flag))
      throw new Error(`Unknown feature flag in Live requirement: ${key}`);
    table.set(key, flag);
  }
  return async (identity, component, action) => {
    const required = [
      table.get(component),
      table.get(`${component}.${action}`),
    ].filter((flag): flag is string => flag !== undefined);
    if (required.length) {
      const flagContext = context(identity);
      for (const flag of required)
        if (!(await service.isEnabled(flag, flagContext))) return false;
    }
    return (await authorize(identity, component, action)) === true;
  };
}
