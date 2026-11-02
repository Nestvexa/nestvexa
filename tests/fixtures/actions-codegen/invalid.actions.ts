// Diagnostics fixture for tests/actions-codegen.test.ts: valid TypeScript whose
// action contracts are rejected by the generator.
import 'reflect-metadata';
import {
  ActionGroup,
  ActionInput,
  ServerAction,
} from '../../../packages/actions/dist/index.js';

const dynamicId = 'computed';

@ActionGroup('broken')
export class BrokenActions {
  @ServerAction({ id: dynamicId })
  dynamic(): null {
    return null;
  }

  @ServerAction({ id: 'map-output' })
  map(): Map<string, number> {
    return new Map();
  }

  @ServerAction({ id: 'callback' })
  callback(@ActionInput() input: { run: () => void; value: bigint }): string {
    return typeof input;
  }
}

@ActionGroup('broken')
export class DuplicateGroup {
  @ServerAction({ id: 'ok' })
  ok(): null {
    return null;
  }
}
