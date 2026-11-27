import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  LiveComponent,
  State,
  definition,
  describeLiveState,
} from '../packages/live/src/metadata.js';
import { SENSITIVE_KEY } from '../packages/islands/src/shared.js';

/** Defines a component with one `@State` field; decorators run at class definition (startup). */
function defineWith(field: string, options?: Parameters<typeof State>[0]) {
  @LiveComponent({ name: 'sensitive-probe', view: 'sensitive-probe' })
  class Probe {
    count = 0;
  }
  State(options)(Probe.prototype, field);
  return Probe;
}

const secretLike = [
  'password',
  'userPassword',
  'passwd',
  'pass',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'sessionToken',
  'apiKey',
  'api_key',
  'credentials',
  'session',
  'cookie',
  'authorization',
  'csrf',
  'privateKey',
  'private_key',
];
const ordinary = [
  'count',
  'query',
  'email',
  'items',
  'passenger',
  'compass',
  'keyboard',
  'author',
];

describe('Live secret-like @State guard (REVIEW-008)', () => {
  it.each(secretLike)('refuses a @State field named %s at definition time', (name) => {
    expect(() => defineWith(name)).toThrow(
      new RegExp(
        `@State field Probe\\.${name} looks like a secret: Live state is public page data sent to the browser`,
      ),
    );
  });

  it('names the opt-out in the error', () => {
    expect(() => defineWith('apiToken')).toThrow(/allowSensitiveName/);
  });

  it('fails as soon as the class is declared with the decorator syntax', () => {
    expect(() => {
      @LiveComponent({ name: 'account', view: 'account' })
      class Account {
        @State() password = 'hunter2';
      }
      return Account;
    }).toThrow(/Account\.password looks like a secret/);
  });

  it.each(ordinary)('accepts the ordinary field name %s', (name) => {
    const type = defineWith(name);
    expect(definition(type).states.has(name)).toBe(true);
  });

  it('accepts a secret-like name with an explicit reason per field', () => {
    @LiveComponent({ name: 'upload-form', view: 'upload-form' })
    class UploadForm {
      @State({ allowSensitiveName: 'session CSRF token the page embeds' })
      csrf = '';
      @State() items = 0;
    }
    const states = definition(UploadForm).states;
    expect([...states.keys()]).toEqual(['csrf', 'items']);
    expect(describeLiveState(new UploadForm(), 'csrf')).toEqual({
      writable: false,
      synthesized: false,
    });
    // The opt-out is per field: a second secret-like field still fails.
    expect(() => {
      @LiveComponent({ name: 'upload-form-2', view: 'upload-form' })
      class Second {
        @State({ allowSensitiveName: 'session CSRF token the page embeds' })
        csrf = '';
        @State() apiKey = '';
      }
      return Second;
    }).toThrow(/Second\.apiKey looks like a secret/);
  });

  it.each([
    ['', 'empty'],
    ['  ', 'blank'],
    ['ok', 'too short'],
    ['x'.repeat(501), 'too long'],
  ])('rejects the reason %j (%s)', (reason) => {
    expect(() => State({ allowSensitiveName: reason })).toThrow(
      'State allowSensitiveName must be a reason of 3-500 characters',
    );
  });

  it('rejects a non-string reason', () => {
    expect(() =>
      State({ allowSensitiveName: true as unknown as string }),
    ).toThrow('State allowSensitiveName must be a reason of 3-500 characters');
  });

  it('refuses exactly the names the islands props guard refuses', () => {
    for (const name of [...secretLike, ...ordinary]) {
      const refused = (() => {
        try {
          defineWith(name);
          return false;
        } catch {
          return true;
        }
      })();
      expect(refused, name).toBe(SENSITIVE_KEY.test(name));
    }
  });
});
