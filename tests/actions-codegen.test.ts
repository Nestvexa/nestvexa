import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateActionClient } from '../packages/actions/dist/codegen/index.js';
import { createActionsClient } from '../packages/actions/dist/client/index.js';
import type { ActionsClient } from '../packages/actions/dist/client/index.js';

const root = process.cwd();
const fixtures = resolve('tests/fixtures/actions-codegen');
const shop = join(fixtures, 'shop.actions.ts');
const orders = join(fixtures, 'orders.actions.ts');
const invalid = join(fixtures, 'invalid.actions.ts');
const reports = join(fixtures, 'reports.actions.ts');
const tsc = join(root, 'node_modules/typescript/bin/tsc');
const cli = join(root, 'packages/actions/dist/cli.js');
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected codegen fixture directory');
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nestvexa-actions-codegen-'));
  directories.push(directory);
  return directory;
}

const consumerTsconfig = (files: string[]) =>
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022', 'DOM'],
      types: [],
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: false,
      paths: {
        '@nestvexa/actions/client': [
          join(root, 'packages/actions/dist/client/index.d.ts').replaceAll(
            '\\',
            '/',
          ),
        ],
      },
    },
    files,
  });

function typecheck(directory: string): {
  status: number | null;
  output: string;
} {
  const result = spawnSync(
    process.execPath,
    [tsc, '-p', join(directory, 'tsconfig.json')],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const goodConsumer = `import { createActionsClient } from '@nestvexa/actions/client';
import { createActions } from './actions-client.js';
import type { CartSummaryDto, Money, Money_2, NestvexaActions } from './actions-client.js';

const actions: NestvexaActions = createActions(createActionsClient({ baseUrl: 'http://localhost' }));

export async function run(signal: AbortSignal): Promise<unknown[]> {
  const summary: CartSummaryDto = await actions.cart.addItem(
    { productId: 'p', quantity: 1, tags: ['gift'] },
    { signal },
  );
  const iso: string = summary.updatedAt;
  const coupon: string | null = summary.coupon;
  const price: Money | undefined = summary.lines[0]?.price;
  const v2 = await actions.cart.addItemV2({ items: [['p', 1]] }, { idempotencyKey: 'key-0000000000000001' });
  const status: 'queued' | 'done' = v2.status;
  const cleared: null = await actions.cart.clear();
  const redirected: { orderId: string } | null = await actions.cart.checkout();
  const withCoupon = await actions.cart.checkout({ coupon: null }, { timeoutMs: 1000 });
  const tree = await actions.cart.categories();
  const child: string | undefined = tree.children[0]?.children[0]?.name;
  const at: string | undefined = (await actions.cart.history())[0]?.at;
  const renamed = await actions.userProfile.rename({ displayName: 'Ada' });
  const length: number | undefined = renamed.length;
  const order = await actions.orders.getV3({ id: 'o-1' });
  const state: 'open' | 'shipped' = order.state;
  const total: Money_2 = order.total;
  return [iso, coupon, price, status, cleared, redirected, withCoupon, child, at, length, state, total.cents];
}
`;

// Every line marked EXPECT must produce a compiler error, and no other line may.
const badConsumer = `import { createActionsClient } from '@nestvexa/actions/client';
import { createActions } from './actions-client.js';

const actions = createActions(createActionsClient());
const valid = { productId: 'p', quantity: 1, tags: [] };

export async function run(): Promise<unknown[]> {
  await actions.cart.addItem({ productId: 'p', quantity: '1', tags: [] }); // EXPECT
  await actions.cart.addItem({ productId: 'p', tags: [] }); // EXPECT
  await actions.cart.addItem(); // EXPECT
  const wrong: number = (await actions.cart.addItem(valid)).updatedAt; // EXPECT
  const missing = actions.cart.removeItem; // EXPECT
  const hidden = actions.cart.notExposed; // EXPECT
  await actions.cart.clear({ x: 1 }); // EXPECT
  const secret = (await actions.cart.addItem(valid)).internalSecret; // EXPECT
  await actions.userProfile.rename({ displayName: 1 }); // EXPECT
  await actions.cart.addItemV2({ items: [[1, 'p']] }); // EXPECT
  const state: 'cancelled' = (await actions.orders.getV3({ id: 'o' })).state; // EXPECT
  await actions.orders.get({ id: 'o' }); // EXPECT
  await actions.cart.addItem(valid, { signal: 'stop' }); // EXPECT
  return [wrong, missing, hidden, secret, state];
}
`;

const targetConsumer = `import { createActionsClient, settle } from '@nestvexa/actions/client';
import { createActions } from './actions-client.js';
import type { CartAddItemError, CartAddItemOptimistic, CartSummaryDto, ReportFile } from './actions-client.js';
import { createActionHooks } from './actions-client.react.js';
import { createActionComposables } from './actions-client.vue.js';
import { createActionStores } from './actions-client.svelte.js';
import { createActionBindings } from './actions-client.live.js';

const actions = createActions(createActionsClient());
const optimistic: CartAddItemOptimistic = (current, input) =>
  current ?? { lines: [], total: { amount: input.quantity, currency: 'EUR' }, updatedAt: '', coupon: null };

export function field(error: CartAddItemError): 'giftWrap' | 'productId' | 'quantity' | 'tags' | undefined {
  return error.issues[0]?.path[0];
}
export function hook() {
  const add = createActionHooks(actions).useCartAddItem({
    optimistic,
    onError: (error) => field(error),
  });
  const pending: boolean = add.pending;
  const data: CartSummaryDto | undefined = add.data;
  void add.run({ productId: 'p', quantity: 1, tags: [] });
  return [pending, data];
}
export function composable() {
  const rename = createActionComposables(actions).useReportsRename();
  const title: string | undefined = rename.state.value.data?.title;
  return title;
}
export function store() {
  const add = createActionStores(actions).cartAddItem();
  return add.subscribe((state) => state.error?.issues[0]?.path[0] === 'quantity');
}
export function live(form: HTMLFormElement) {
  return createActionBindings(actions).bindReportsRename(form, {
    input: (element) => ({ title: String(new FormData(element as HTMLFormElement).get('title')), tags: [] }),
  });
}
export async function job(): Promise<ReportFile> {
  const handle = await actions.reports.export({ rows: 10 });
  const channel: string | undefined = handle.stream?.channel;
  void channel;
  return handle.wait({ intervalMs: 500 });
}
export async function settled() {
  const outcome = await settle(actions.reports.rename({ title: 't', tags: [] }));
  return outcome.ok ? outcome.data.title : outcome.error.code;
}
`;

// Every line marked EXPECT must produce a compiler error, and no other line may.
const badTargetConsumer = `import { createActionsClient } from '@nestvexa/actions/client';
import { createActions } from './actions-client.js';
import type { CartAddItemError, CartAddItemOptimistic } from './actions-client.js';
import { createActionHooks } from './actions-client.react.js';
import { createActionStores } from './actions-client.svelte.js';
import { createActionBindings } from './actions-client.live.js';

const actions = createActions(createActionsClient());
export function run(error: CartAddItemError, form: HTMLFormElement) {
  const wrong: 'sku' | undefined = error.issues[0]?.path[0]; // EXPECT
  const optimistic: CartAddItemOptimistic = () => ({ lines: 'none' }); // EXPECT
  createActionHooks(actions).useCartRemove(); // EXPECT
  createActionHooks(actions).useCartAddItem().run({ productId: 1 }); // EXPECT
  createActionStores(actions).reportsRename().run({ title: 1, tags: [] }); // EXPECT
  createActionBindings(actions).bindReportsRename(form, { input: () => ({ title: 'x' }) }); // EXPECT
  return [wrong, optimistic];
}
export async function job() {
  const handle = await actions.reports.export({ rows: 1 });
  const rows: string = (await handle.wait()).rows; // EXPECT
  return rows;
}
`;

// Each generation builds a full TypeScript program (Nest declarations included).
describe('action client generation', { timeout: 120_000 }, () => {
  it('produces deterministic output independent of root file order', async () => {
    const out = await temporary();
    const first = await generateActionClient({
      files: [shop, orders],
      outDir: out,
      write: false,
    });
    const second = await generateActionClient({
      files: [orders, shop],
      outDir: out,
      write: false,
    });
    expect(first.ok).toBe(true);
    expect(first.diagnostics).toEqual([]);
    expect(second.files.map((file) => file.contents)).toEqual(
      first.files.map((file) => file.contents),
    );
    expect(first.groups).toEqual([
      expect.objectContaining({
        id: 'cart',
        key: 'cart',
        className: 'CartActions',
      }),
      expect.objectContaining({ id: 'orders', key: 'orders' }),
      expect.objectContaining({ id: 'user-profile', key: 'userProfile' }),
    ]);
    expect(first.groups[0]?.actions.map((action) => action.key)).toEqual([
      'addItem',
      'addItemV2',
      'categories',
      'checkout',
      'clear',
      'history',
    ]);
    const [js = '', dts = ''] = first.files.map((file) => file.contents);
    expect(js).not.toMatch(/notExposed|internalSecret|describe/);
    expect(dts).not.toMatch(/notExposed|internalSecret|describe\(/);
    expect(js).toContain(
      "addItemV2: Object.freeze({ group: 'cart', action: 'add-item', version: 2, idempotent: true }),",
    );
    expect(dts).toContain(
      'export interface Category {\n  name: string;\n  children: Category[];\n}',
    );
    expect(dts).toContain('  updatedAt: string;');
    expect(dts).toContain(
      'export interface Money {\n  amount: number;\n  currency: Currency;\n}',
    );
    expect(dts).toContain('export interface Money_2 {\n  cents: number;\n}');
    expect(dts).toContain("export type Currency = 'EUR' | 'USD';");
    expect(dts).toContain('readonly clear: ActionMethod<void, null, never>;');
    expect(dts).toContain(
      "readonly checkout: ActionMethod<{ coupon?: string | null } | undefined, { orderId: string } | null, 'coupon'>;",
    );
    expect(dts).toContain(
      "readonly rename: ActionMethod<{ displayName: string }, { displayName: string; length?: number }, 'displayName'>;",
    );
    expect(dts).toContain(
      "export type CartAddItemError = ActionFailure<ActionFieldOf<NestvexaActions['cart']['addItem']>>;",
    );
    expect(dts).toContain('state: OrderState;');
    expect(dts).toContain("export type OrderState = 'open' | 'shipped';");
    expect(js.endsWith('\n') && !js.includes('\r')).toBe(true);
  });

  it('typechecks a correct consumer and rejects misuse against the generated types', async () => {
    const out = await temporary();
    const result = await generateActionClient({
      files: [shop, orders],
      outDir: out,
    });
    expect(result.ok).toBe(true);
    await writeFile(join(out, 'consumer.ts'), goodConsumer);
    await writeFile(
      join(out, 'tsconfig.json'),
      consumerTsconfig(['consumer.ts']),
    );
    const good = typecheck(out);
    expect(good.output).toBe('');
    expect(good.status).toBe(0);

    await writeFile(join(out, 'consumer.ts'), badConsumer);
    const bad = typecheck(out);
    expect(bad.status).not.toBe(0);
    const expected = badConsumer
      .split('\n')
      .flatMap((line, index) =>
        line.includes('// EXPECT') ? [index + 1] : [],
      );
    const reported = [
      ...new Set(
        [...bad.output.matchAll(/consumer\.ts\((\d+),\d+\): error TS\d+/g)].map(
          (match) => Number(match[1]),
        ),
      ),
    ].sort((left, right) => left - right);
    expect(reported).toEqual(expected);
  });

  it('binds the generated manifest to real routes, versions and idempotency keys', async () => {
    const out = await temporary();
    await generateActionClient({ files: [shop, orders], outDir: out });
    const module = (await import(
      pathToFileURL(join(out, 'actions-client.js')).href
    )) as {
      createActions: (
        client: ActionsClient,
      ) => Record<
        string,
        Record<string, (input?: unknown) => Promise<unknown>>
      >;
      actionManifest: object;
    };
    expect(Object.isFrozen(module.actionManifest)).toBe(true);
    const requests: {
      url: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    const client = createActionsClient({
      baseUrl: 'http://app.test',
      csrf: 'csrf-token-0123456789',
      createIdempotencyKey: () => 'generated-key-000000001',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          headers: init?.headers as Record<string, string>,
          body: String(init?.body),
        });
        return new Response(
          JSON.stringify({
            protocol: 'nestvexa-actions/1',
            ok: true,
            requestId: 'r',
            data: 1,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const actions = module.createActions(client);
    await actions['cart']?.['addItemV2']?.({ items: [] });
    await actions['orders']?.['getV3']?.({ id: 'x' });
    await actions['cart']?.['clear']?.();
    expect(requests.map((request) => request.url)).toEqual([
      'http://app.test/_nestvexa/actions/cart/add-item/v2',
      'http://app.test/_nestvexa/actions/orders/get/v3',
      'http://app.test/_nestvexa/actions/cart/clear',
    ]);
    expect(requests[0]?.headers['idempotency-key']).toBe(
      'generated-key-000000001',
    );
    expect(requests[1]?.headers['idempotency-key']).toBeUndefined();
    expect(requests[0]?.headers['x-nestvexa-csrf']).toBe(
      'csrf-token-0123456789',
    );
    expect(requests[2]?.body).toBe('{}');
  });

  it('emits typed framework targets, validation unions, optimistic types and job handles', async () => {
    const out = await temporary();
    const result = await generateActionClient({
      files: [shop, reports],
      outDir: out,
      targets: ['svelte', 'react', 'live', 'vue', 'react'],
    });
    expect(result.diagnostics).toEqual([]);
    expect(
      result.files.map((file) => file.path.slice(out.length + 1)).sort(),
    ).toEqual(
      [
        'actions-client.d.ts',
        'actions-client.js',
        ...['live', 'react', 'svelte', 'vue'].flatMap((target) => [
          `actions-client.${target}.d.ts`,
          `actions-client.${target}.js`,
        ]),
      ].sort(),
    );
    const read = (name: string) =>
      readFile(join(out, `actions-client.${name}`), 'utf8');
    const dts = await read('d.ts');
    expect(dts).toContain(
      "readonly export: ActionMethod<ReportRequest, ActionJobHandle<ReportFile>, 'format' | 'rows'>;",
    );
    expect(dts).toContain(
      "readonly addItem: ActionMethod<AddItemInput, CartSummaryDto, 'giftWrap' | 'productId' | 'quantity' | 'tags'>;",
    );
    expect(await read('react.js')).toContain("from 'react'");
    expect(await read('vue.js')).toContain("from 'vue'");
    // Declarations depend on the client package only, never on a framework.
    for (const target of ['react', 'vue', 'svelte', 'live'])
      expect(await read(`${target}.d.ts`)).not.toMatch(
        /from '(?:react|vue|svelte)'/,
      );
    await writeFile(join(out, 'consumer.ts'), targetConsumer);
    await writeFile(
      join(out, 'tsconfig.json'),
      consumerTsconfig(['consumer.ts']),
    );
    const good = typecheck(out);
    expect(good.output).toBe('');
    await writeFile(join(out, 'consumer.ts'), badTargetConsumer);
    const bad = typecheck(out);
    const expected = badTargetConsumer
      .split('\n')
      .flatMap((line, index) =>
        line.includes('// EXPECT') ? [index + 1] : [],
      );
    const reported = [
      ...new Set(
        [...bad.output.matchAll(/consumer\.ts\((\d+),\d+\): error TS\d+/g)].map(
          (match) => Number(match[1]),
        ),
      ),
    ].sort((left, right) => left - right);
    expect(reported).toEqual(expected);

    // Runtime: the generated Svelte stores drive the shared controller.
    const clientUrl = pathToFileURL(
      join(root, 'packages/actions/dist/client/index.js'),
    ).href;
    const storesFile = join(out, 'stores.mjs');
    await writeFile(
      storesFile,
      (await read('svelte.js')).replace(
        "'@nestvexa/actions/client'",
        `'${clientUrl}'`,
      ),
    );
    const { createActionStores } = (await import(
      pathToFileURL(storesFile).href
    )) as {
      createActionStores: (actions: unknown) => Record<
        string,
        (options?: object) => {
          subscribe(
            run: (state: { status: string; data: unknown }) => void,
          ): () => void;
          run(input: unknown): Promise<{ ok: boolean }>;
        }
      >;
    };
    const { createActions } = (await import(
      pathToFileURL(join(out, 'actions-client.js')).href
    )) as { createActions: (client: ActionsClient) => unknown };
    let fail = false;
    const actions = createActions(
      createActionsClient({
        baseUrl: 'http://app.test',
        csrf: 'csrf-token-0123456789',
        fetch: (async () =>
          new Response(
            JSON.stringify(
              fail
                ? {
                    protocol: 'nestvexa-actions/1',
                    ok: false,
                    requestId: 'r',
                    error: {
                      code: 'VALIDATION',
                      message: 'Invalid',
                      issues: [{ path: ['title'], message: 'Required' }],
                    },
                  }
                : {
                    protocol: 'nestvexa-actions/1',
                    ok: true,
                    requestId: 'r',
                    data: { title: 'Server' },
                  },
            ),
            { status: fail ? 400 : 200 },
          )) as typeof fetch,
      }),
    );
    const stores = createActionStores(actions);
    const store = stores['reportsRename']?.({
      optimistic: (_current: unknown, input: { title: string }) => ({
        title: `${input.title} (saving)`,
      }),
    });
    const seen: string[] = [];
    const stop = store?.subscribe((state) =>
      seen.push(`${state.status}:${JSON.stringify(state.data ?? null)}`),
    );
    await store?.run({ title: 'Draft', tags: [] });
    fail = true;
    await store?.run({ title: 'Broken', tags: [] });
    stop?.();
    expect(seen).toEqual([
      'idle:null',
      'pending:{"title":"Draft (saving)"}',
      'success:{"title":"Server"}',
      'pending:{"title":"Broken (saving)"}',
      // Failure rolls the optimistic value back to the last server data.
      'error:{"title":"Server"}',
    ]);
  });

  it('reports contract diagnostics and never writes invalid output', async () => {
    const out = await temporary();
    const result = await generateActionClient({
      files: [invalid],
      outDir: out,
    });
    expect(result.ok).toBe(false);
    const messages = result.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '@ServerAction id must be a lowercase kebab-case string literal',
        ),
        expect.stringContaining("Duplicate action group id 'broken'"),
        'bigint is not JSON-serializable',
        expect.stringContaining('Map is not JSON-safe'),
      ]),
    );
    expect(
      result.diagnostics.find((diagnostic) =>
        diagnostic.message.includes('bigint'),
      ),
    ).toMatchObject({
      file: 'tests/fixtures/actions-codegen/invalid.actions.ts',
      line:
        (await readFile(invalid, 'utf8'))
          .split(/\r?\n/)
          .findIndex((line) => line.includes('callback(')) + 1,
    });
    await expect(stat(join(out, 'actions-client.js'))).rejects.toThrow();
  });

  it('rewrites only changed files and supports --check through the CLI', async () => {
    const out = await temporary();
    await writeFile(
      join(out, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          experimentalDecorators: true,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        files: [shop.replaceAll('\\', '/'), orders.replaceAll('\\', '/')],
      }),
    );
    const generated = join(out, 'generated');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: out,
        encoding: 'utf8',
        timeout: 120_000,
      });
    const check = run(
      '--project',
      'tsconfig.json',
      '--out',
      'generated',
      '--check',
    );
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('is out of date');
    const write = run(
      '--project',
      'tsconfig.json',
      '--out',
      'generated',
      '--name',
      'shop-client',
    );
    expect(write.stderr).toBe('');
    expect(write.status).toBe(0);
    expect(write.stdout).toContain(
      '3 group(s), 8 action(s); 2 file(s) written',
    );
    const before = await stat(join(generated, 'shop-client.d.ts'));
    const again = run(
      '--project',
      'tsconfig.json',
      '--out',
      'generated',
      '--name',
      'shop-client',
    );
    expect(again.stdout).toContain('0 file(s) written');
    expect((await stat(join(generated, 'shop-client.d.ts'))).mtimeMs).toBe(
      before.mtimeMs,
    );
    expect(
      run(
        '--project',
        'tsconfig.json',
        '--out',
        'generated',
        '--name',
        'shop-client',
        '--check',
      ).status,
    ).toBe(0);
    await writeFile(join(generated, 'shop-client.js'), '// edited\n');
    expect(
      run(
        '--project',
        'tsconfig.json',
        '--out',
        'generated',
        '--name',
        'shop-client',
        '--check',
      ).status,
    ).toBe(1);
    expect(await readFile(join(generated, 'shop-client.js'), 'utf8')).toBe(
      '// edited\n',
    );
    expect(run('--unknown').status).toBe(2);
    expect(run('--project').status).toBe(2);
    expect(run('--project', 'missing.json', '--out', 'x').status).toBe(1);
  });
});
