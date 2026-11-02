import 'reflect-metadata';
import {
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Render,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  ActionGroup,
  ActionInput,
  ActionsModule,
  ServerAction,
  actionGroupDefinition,
  isActionGroup,
} from '../packages/actions/dist/index.js';
import type {
  ActionsModuleOptions,
  ServerActionOptions,
} from '../packages/actions/dist/index.js';

const policy = {
  origin: 'http://localhost:4100',
  resolveIdentity: () => null,
  authorize: () => true,
} as const;

function decorate(options: unknown) {
  return ServerAction(options as ServerActionOptions);
}

describe('action decorators', () => {
  it.each([
    null,
    [],
    'add-item',
    {},
    { id: '' },
    { id: 'Add-Item' },
    { id: 'add_item' },
    { id: 'add--item' },
    { id: '-add' },
    { id: 'a'.repeat(65) },
    { id: 'ok', version: 0 },
    { id: 'ok', version: 1.5 },
    { id: 'ok', version: 1001 },
    { id: 'ok', idempotent: 'yes' },
    { id: 'ok', timeoutMs: 0 },
    { id: 'ok', timeoutMs: 600_001 },
    { id: 'ok', concurrency: 'queue' },
    { id: 'ok', input: {} },
    { id: 'ok', output: 'schema' },
    { id: 'ok', unknown: true },
    { id: 'ok', [Symbol('x')]: true },
    Object.create({ id: 'inherited' }) as object,
  ])('rejects invalid @ServerAction options %j', (options) => {
    expect(() => decorate(options)).toThrow();
  });

  it('rejects accessor options without evaluating them', () => {
    let reads = 0;
    const options = Object.defineProperty({}, 'id', {
      enumerable: true,
      get() {
        reads++;
        return 'sneaky';
      },
    });
    expect(() => decorate(options)).toThrow('own data properties');
    expect(reads).toBe(0);
  });

  it.each(['', 'Cart', 'cart_items', 'cart/', '__proto__', 'constructor!'])(
    'rejects invalid group id %j',
    (id) => {
      expect(() => ActionGroup(id)).toThrow('kebab-case');
    },
  );

  it('rejects reserved method names, duplicates and double inputs', () => {
    expect(() => {
      class Reserved {
        @ServerAction({ id: 'then' }) then() {}
      }
      return Reserved;
    }).toThrow('cannot be a server action');
    expect(() => {
      class Twice {
        @ServerAction({ id: 'a' })
        @ServerAction({ id: 'b' })
        run() {}
      }
      return Twice;
    }).toThrow('more than once');
    expect(() => {
      class TwoInputs {
        @ServerAction({ id: 'a' })
        run(@ActionInput() a: unknown, @ActionInput() b: unknown) {
          return [a, b];
        }
      }
      return TwoInputs;
    }).toThrow('@ActionInput more than once');
    expect(() => {
      @ActionGroup('dup')
      @ActionGroup('dup')
      class DoubleGroup {}
      return DoubleGroup;
    }).toThrow('more than once');
  });
});

describe('action group definitions', () => {
  it('builds frozen sorted definitions with keys, paths and inheritance', () => {
    class Base {
      @ServerAction({ id: 'list' }) list() {}
      @ServerAction({ id: 'remove' }) remove() {}
    }
    @Injectable()
    @ActionGroup('cart')
    class Cart extends Base {
      @ServerAction({ id: 'add-item', idempotent: true, timeoutMs: 500 })
      add(@ActionInput() input: unknown) {
        return input;
      }
      @ServerAction({ id: 'add-item', version: 2, concurrency: 'serial' })
      addV2() {}
      @ServerAction({ id: 'remove', version: 3 })
      override remove() {}
      notAnAction() {}
    }
    const definition = actionGroupDefinition(Cart);
    expect(isActionGroup(Cart)).toBe(true);
    expect(isActionGroup(Base)).toBe(false);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(definition.id).toBe('cart');
    expect(
      definition.actions.map(
        ({
          id,
          version,
          key,
          path,
          method,
          idempotent,
          concurrency,
          inputIndex,
          timeoutMs,
        }) => ({
          id,
          version,
          key,
          path,
          method,
          idempotent,
          concurrency,
          inputIndex,
          timeoutMs,
        }),
      ),
    ).toEqual([
      {
        id: 'add-item',
        version: null,
        key: 'addItem',
        path: 'add-item',
        method: 'add',
        idempotent: true,
        concurrency: 'parallel',
        inputIndex: 0,
        timeoutMs: 500,
      },
      {
        id: 'add-item',
        version: 2,
        key: 'addItemV2',
        path: 'add-item/v2',
        method: 'addV2',
        idempotent: false,
        concurrency: 'serial',
        inputIndex: undefined,
        timeoutMs: undefined,
      },
      {
        id: 'list',
        version: null,
        key: 'list',
        path: 'list',
        method: 'list',
        idempotent: false,
        concurrency: 'parallel',
        inputIndex: undefined,
        timeoutMs: undefined,
      },
      {
        id: 'remove',
        version: 3,
        key: 'removeV3',
        path: 'remove/v3',
        method: 'remove',
        idempotent: false,
        concurrency: 'parallel',
        inputIndex: undefined,
        timeoutMs: undefined,
      },
    ]);
  });

  it('never exposes @Injectable classes or plain methods', () => {
    @Injectable()
    class Service {
      charge() {}
    }
    expect(() => actionGroupDefinition(Service)).toThrow(
      '@Injectable alone never exposes methods',
    );
    @ActionGroup('empty')
    class Empty {
      run() {}
    }
    expect(() => actionGroupDefinition(Empty)).toThrow('has no @ServerAction');
  });

  it('rejects overrides without @ServerAction and route-shaping Nest metadata', () => {
    class Base {
      @ServerAction({ id: 'save' }) save() {}
    }
    @ActionGroup('override')
    class Override extends Base {
      override save() {}
    }
    expect(() => actionGroupDefinition(Override)).toThrow(
      'without @ServerAction',
    );
    @ActionGroup('shaped')
    class Shaped {
      @ServerAction({ id: 'run' })
      @HttpCode(204)
      run() {}
    }
    expect(() => actionGroupDefinition(Shaped)).toThrow('route metadata');
    @ActionGroup('rendered')
    class Rendered {
      @ServerAction({ id: 'run' })
      @Render('view')
      run() {}
    }
    expect(() => actionGroupDefinition(Rendered)).toThrow('route metadata');
    @ActionGroup('routed')
    class Routed {
      @ServerAction({ id: 'run' })
      @Get('x')
      run() {}
    }
    expect(() => actionGroupDefinition(Routed)).toThrow('route metadata');
    @Controller('double')
    @ActionGroup('double')
    class Double {
      @ServerAction({ id: 'run' }) run() {}
    }
    expect(() => actionGroupDefinition(Double)).toThrow(
      'also a Nest @Controller',
    );
  });

  it('rejects duplicate ids/versions, client-name collisions and schema without input', () => {
    @ActionGroup('dupes')
    class Dupes {
      @ServerAction({ id: 'run' }) a() {}
      @ServerAction({ id: 'run' }) b() {}
    }
    expect(() => actionGroupDefinition(Dupes)).toThrow(
      'Duplicate server action dupes/run: declared by Dupes.a and Dupes.b',
    );
    @ActionGroup('versions')
    class Versions {
      @ServerAction({ id: 'run', version: 2 }) a() {}
      @ServerAction({ id: 'run', version: 2 }) b() {}
    }
    expect(() => actionGroupDefinition(Versions)).toThrow('version 2');
    @ActionGroup('names')
    class Names {
      @ServerAction({ id: 'add-item', version: 2 }) a() {}
      @ServerAction({ id: 'add-item-v2' }) b() {}
    }
    expect(() => actionGroupDefinition(Names)).toThrow(
      'same client name "addItemV2"',
    );
    @ActionGroup('schema')
    class Schema {
      @ServerAction({ id: 'run', input: { parse: (value: unknown) => value } })
      run() {}
    }
    expect(() => actionGroupDefinition(Schema)).toThrow('no @ActionInput');
  });
});

describe('ActionsModule startup validation', () => {
  @ActionGroup('cart')
  class Cart {
    @ServerAction({ id: 'add' }) add() {}
  }
  @ActionGroup('cart')
  class OtherCart {
    @ServerAction({ id: 'add' }) add() {}
  }
  const base: ActionsModuleOptions = { groups: [Cart], ...policy };

  it.each([
    [{ ...base, groups: [] }, 'non-empty groups'],
    [
      { ...base, groups: [Cart, OtherCart] },
      'Duplicate action group id "cart"',
    ],
    [{ ...base, prefix: 'actions' }, 'Invalid ActionsModule prefix'],
    [{ ...base, prefix: '/a/../b' }, 'Invalid ActionsModule prefix'],
    [{ ...base, origin: 'http://localhost:4100/' }, 'exact origin'],
    [{ ...base, origin: 'ftp://localhost' }, 'exact origin'],
    [{ ...base, origin: [] }, 'non-empty list'],
    [{ ...base, authorize: undefined }, 'authorization-first'],
    [{ ...base, resolveIdentity: undefined }, 'authorization-first'],
    [{ ...base, limits: { maxBodyBytes: 0 } }, 'limits.maxBodyBytes'],
    [{ ...base, limits: { bogus: 1 } }, 'Unknown actions limit bogus'],
    [{ ...base, csrf: { header: 'X-Bad Header' } }, 'csrf.header'],
    [{ ...base, rateLimit: 5 }, 'rateLimit'],
    [{ ...base, idempotency: { store: {} } }, 'idempotency.store'],
    [{ ...base, errorEnvelope: 'json' }, 'errorEnvelope'],
    [
      { ...base, unknown: true },
      'Unknown ActionsModule.register option unknown',
    ],
  ])('rejects invalid registration %#', (options, message) => {
    expect(() =>
      ActionsModule.register(options as ActionsModuleOptions),
    ).toThrow(message);
  });

  it('rejects the same group or route across registrations at bootstrap', async () => {
    @Module({ imports: [ActionsModule.register(base)] })
    class First {}
    @Module({
      imports: [ActionsModule.register({ ...base, groups: [OtherCart] })],
    })
    class Second {}
    await expect(
      Test.createTestingModule({ imports: [First, Second] }).compile(),
    ).rejects.toThrow(
      'Duplicate server action route POST /_nestvexa/actions/cart/add',
    );
    @Module({
      imports: [ActionsModule.register({ ...base, prefix: '/other' })],
    })
    class Third {}
    await expect(
      Test.createTestingModule({ imports: [First, Third] }).compile(),
    ).rejects.toThrow('registered by more than one ActionsModule');
    const disjoint = await Test.createTestingModule({
      imports: [
        First,
        ActionsModule.register({
          ...base,
          groups: [OtherCart],
          prefix: '/admin-actions',
        }),
      ],
    }).compile();
    await disjoint.close();
  });
});
