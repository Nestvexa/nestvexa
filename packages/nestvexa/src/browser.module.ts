import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { SafeHtml } from '@nestvexa/views';
import { NestvexaAssetsModule, NestvexaAssetsService } from './assets.js';
import { normalizeAssetOptions } from './asset-catalog.js';

/** Automatic bundled Alpine, or explicit host-owned browser startup. */
export interface NestvexaBrowserOptions {
  readonly mode?: 'alpine' | 'manual';
  /** Controller prefix for boot.js; the public host prefix comes from Live basePath. */
  readonly path?: string;
  readonly assetsPath?: string;
  /** Public version-neutral host prefix; override when Live basePath includes a URI version. */
  readonly basePath?: string;
  /** Trusted explicit public POST paths, including any host prefix. Never taken from markup. */
  readonly streams?: Readonly<Record<string, { readonly endpoint: string }>>;
  /** Trusted realtime route prefix and transport for @nestvexa/realtime. */
  readonly realtime?: {
    readonly endpoint: string;
    readonly transport?: 'auto' | 'sse' | 'websocket' | 'polling';
  };
  /** Public prefix of the opt-in @nestvexa/uploads routes, including any host prefix. */
  readonly uploads?: { readonly endpoint: string };
}
interface BrowserOptions {
  readonly mode: 'alpine' | 'manual';
  readonly path: string;
  readonly basePath: string;
  readonly streams: Readonly<Record<string, { readonly endpoint: string }>>;
  readonly realtime?: {
    readonly endpoint: string;
    readonly transport: 'auto' | 'sse' | 'websocket' | 'polling';
  };
  readonly uploads: { readonly endpoint: string } | undefined;
}
const BROWSER_OPTIONS = Symbol('nv:browser-options');
function normalizeStreams(value: unknown): BrowserOptions['streams'] {
  const result: Record<string, { readonly endpoint: string }> = Object.create(
    null,
  ) as Record<string, { readonly endpoint: string }>;
  if (value === undefined) return Object.freeze(result);
  const plain = (entry: object): boolean =>
    Object.getPrototypeOf(entry) === Object.prototype ||
    Object.getPrototypeOf(entry) === null;
  if (
    !value ||
    typeof value !== 'object' ||
    !plain(value) ||
    Reflect.ownKeys(value).length > 64
  )
    throw new Error('Invalid browser stream map');
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) ||
      ['constructor', 'prototype', '__proto__'].includes(key)
    )
      throw new Error('Invalid browser stream identifier');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new Error('Browser streams require plain data properties');
    const entry: unknown = descriptor.value;
    if (
      !entry ||
      typeof entry !== 'object' ||
      !plain(entry) ||
      Reflect.ownKeys(entry).length !== 1
    )
      throw new Error('Invalid browser stream endpoint');
    const endpoint = Object.getOwnPropertyDescriptor(entry, 'endpoint');
    if (
      !endpoint?.enumerable ||
      !('value' in endpoint) ||
      typeof endpoint.value !== 'string'
    )
      throw new Error('Browser stream endpoint must be a string data property');
    const path = normalizeAssetOptions({
      path: endpoint.value,
      basePath: '',
    }).path;
    result[key] = Object.freeze({ endpoint: path });
  }
  return Object.freeze(result);
}
function normalizeUploads(value: unknown): BrowserOptions['uploads'] {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== 1
  )
    throw new Error('Invalid browser uploads option');
  const endpoint = Object.getOwnPropertyDescriptor(value, 'endpoint');
  if (
    !endpoint?.enumerable ||
    !('value' in endpoint) ||
    typeof endpoint.value !== 'string'
  )
    throw new Error('Browser uploads endpoint must be a string data property');
  return Object.freeze({
    endpoint: normalizeAssetOptions({ path: endpoint.value, basePath: '' })
      .path,
  });
}
function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
/** Validated, escaped ` nonce="…"` attribute (empty without a nonce). */
function scriptNonce(nonce: unknown): string {
  if (nonce === undefined) return '';
  if (
    typeof nonce !== 'string' ||
    /[\r\n]/.test(nonce) ||
    !/^[a-zA-Z0-9+/_-]{1,256}={0,2}$/.test(nonce)
  )
    throw new Error('Invalid browser script nonce');
  return ` nonce="${attribute(nonce)}"`;
}

/** Application-local document script integration; does not contain identity or session data. */
@Injectable()
export class NestvexaBrowserService implements OnApplicationShutdown {
  private closed = false;
  constructor(
    @Inject(BROWSER_OPTIONS) private readonly options: BrowserOptions,
    @Inject(NestvexaAssetsService)
    private readonly assets: NestvexaAssetsService,
  ) {}
  /** Boot is version-neutral; use the same public host prefix as the asset manifest. */
  getBootUrl(): string {
    if (this.closed)
      throw new ServiceUnavailableException('Nestvexa browser has shut down');
    if (this.options.mode !== 'alpine')
      throw new Error('Browser startup is host-owned in manual mode');
    this.assets.getManifest();
    return `${this.options.basePath}${this.options.path}/boot.js`;
  }
  /**
   * Trusted external module tag for document layouts; optional CSP nonce is
   * validated and escaped. `integrity: true` prefixes `importMap()` so the
   * browser verifies the entry and every on-demand chunk it loads.
   */
  scripts(
    nonce?: string,
    options: { readonly integrity?: boolean } = {},
  ): SafeHtml {
    const nonceAttribute = scriptNonce(nonce);
    const url = this.getBootUrl();
    const tag = `<script type="module" src="${attribute(url)}"${nonceAttribute}></script>`;
    return SafeHtml.trusted(
      options.integrity === true ? `${this.importMap(nonce).value}${tag}` : tag,
    );
  }
  /**
   * Inline import map whose `integrity` section pins every served client
   * module (entry, feature chunks, Alpine and its adapter) to its SHA-384
   * digest. Place it before any module script; it maps no specifiers.
   */
  importMap(nonce?: string): SafeHtml {
    const nonceAttribute = scriptNonce(nonce);
    if (this.closed)
      throw new ServiceUnavailableException('Nestvexa browser has shut down');
    const { files, integrity } = this.assets.getManifest();
    const pinned: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [name, url] of Object.entries(files)) {
      const digest = integrity[name];
      if (digest !== undefined) pinned[url] = digest;
    }
    const json = JSON.stringify({ integrity: pinned }).replaceAll(
      '<',
      '\\u003c',
    );
    return SafeHtml.trusted(
      `<script type="importmap"${nonceAttribute}>${json}</script>`,
    );
  }
  /** Generated trusted module imports only the current installed allowlist; no inline application code. */
  boot(): string {
    this.getBootUrl();
    const { entries } = this.assets.getManifest();
    return `import {createLiveClient} from ${JSON.stringify(entries.live)};
import Alpine from ${JSON.stringify(entries.alpine)};
import {adoptLiveAlpine, hostAlpine, startLiveAlpine} from ${JSON.stringify(entries.alpineAdapter)};
const configure = (Alpine, client) => {
  document.dispatchEvent(new CustomEvent('nestvexa:alpine:init', {detail: Object.freeze({Alpine, client})}));
};
const host = hostAlpine();
const app = host === undefined
  ? startLiveAlpine(Alpine, createLiveClient(${this.clientConfig()}), {configure})
  : adoptLiveAlpine(host, createLiveClient(${this.clientConfig()}), {configure});
export {app};\n`;
  }
  private clientConfig(): string {
    const config = {
      ...(Object.keys(this.options.streams).length
        ? { streams: this.options.streams }
        : {}),
      ...(this.options.realtime ? { realtime: this.options.realtime } : {}),
      ...(this.options.uploads ? { uploads: this.options.uploads } : {}),
    };
    return Object.keys(config).length
      ? JSON.stringify(config).replaceAll('<', '\u003c')
      : '';
  }
  onApplicationShutdown(): void {
    this.closed = true;
  }
}
function controller(path: string) {
  @Controller({ path, version: VERSION_NEUTRAL })
  class NestvexaBrowserController {
    constructor(
      @Inject(NestvexaBrowserService)
      private readonly browser: NestvexaBrowserService,
    ) {}
    @Get('boot.js')
    @Header('Cache-Control', 'no-store')
    @Header('Content-Type', 'text/javascript; charset=utf-8')
    @Header('X-Content-Type-Options', 'nosniff')
    boot(): string {
      return this.browser.boot();
    }
  }
  return NestvexaBrowserController;
}

/** Internal composition module; use the umbrella root registration for shared renderer ownership. */
@Module({})
export class NestvexaBrowserModule {
  static register(
    options: NestvexaBrowserOptions = {},
    basePath = '',
  ): DynamicModule {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    )
      throw new Error('Invalid browser options');
    const prototype: unknown = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error('Invalid browser options');
    for (const key of Reflect.ownKeys(options)) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (
        ![
          'mode',
          'path',
          'assetsPath',
          'basePath',
          'streams',
          'realtime',
          'uploads',
        ].includes(String(key)) ||
        typeof key !== 'string' ||
        !descriptor ||
        !('value' in descriptor)
      )
        throw new Error('Invalid browser options');
    }
    const read = (key: string): unknown =>
      Object.getOwnPropertyDescriptor(options, key)?.value;
    const modeValue = read('mode');
    const mode = modeValue === undefined ? 'alpine' : modeValue;
    if (mode !== 'alpine' && mode !== 'manual')
      throw new Error('Invalid browser mode');
    const streams = normalizeStreams(read('streams'));
    const realtimeValue = read('realtime');
    let realtime: BrowserOptions['realtime'];
    if (realtimeValue !== undefined) {
      const endpoint: unknown =
        realtimeValue && typeof realtimeValue === 'object'
          ? Reflect.get(realtimeValue, 'endpoint')
          : undefined;
      const transport: unknown =
        realtimeValue && typeof realtimeValue === 'object'
          ? (Reflect.get(realtimeValue, 'transport') ?? 'auto')
          : undefined;
      if (
        typeof endpoint !== 'string' ||
        !['auto', 'sse', 'websocket', 'polling'].includes(String(transport))
      )
        throw new Error('Invalid browser realtime options');
      if (mode === 'manual')
        throw new Error(
          'Configure realtime on the host-owned client in manual browser mode',
        );
      realtime = Object.freeze({
        endpoint: normalizeAssetOptions({ path: endpoint, basePath: '' }).path,
        transport: transport as 'auto' | 'sse' | 'websocket' | 'polling',
      });
    }
    if (mode === 'manual' && Object.keys(streams).length)
      throw new Error(
        'Configure streams on the host-owned client in manual browser mode',
      );
    const uploads = normalizeUploads(read('uploads'));
    if (mode === 'manual' && uploads)
      throw new Error(
        'Configure uploads on the host-owned client in manual browser mode',
      );
    const prefix = normalizeAssetOptions({
      path: read('path') === undefined ? '/_nestvexa' : read('path'),
      basePath: read('basePath') === undefined ? basePath : read('basePath'),
    });
    const assets = normalizeAssetOptions({
      path:
        read('assetsPath') === undefined
          ? '/_nestvexa/assets'
          : read('assetsPath'),
      basePath: prefix.basePath,
    });
    // GET <assets>/:version/:file would also match this boot.js route.
    // Express and Fastify prioritize that collision differently; reject it.
    if (
      mode === 'alpine' &&
      prefix.path.startsWith(`${assets.path}/`) &&
      !prefix.path.slice(assets.path.length + 1).includes('/')
    )
      throw new Error('Browser boot route overlaps client asset route');
    return {
      module: NestvexaBrowserModule,
      imports: [NestvexaAssetsModule.register(assets)],
      controllers: mode === 'alpine' ? [controller(prefix.path)] : [],
      providers: [
        {
          provide: BROWSER_OPTIONS,
          useValue: Object.freeze({
            ...prefix,
            mode,
            streams,
            uploads,
            ...(realtime === undefined ? {} : { realtime }),
          }),
        },
        NestvexaBrowserService,
      ],
      exports: [NestvexaAssetsModule, NestvexaBrowserService],
    };
  }
}

/** Handlebars passes its options object as the sole argument for {{nvScripts}}. */
export function documentScripts(
  browser: NestvexaBrowserService,
  args: readonly unknown[],
): SafeHtml {
  const options = args[0];
  const usage = 'nvScripts accepts only optional nonce and integrity hash keys';
  if (args.length !== 1 || typeof options !== 'object' || options === null)
    throw new Error(usage);
  const hash: unknown = Reflect.get(options, 'hash');
  if (
    typeof hash !== 'object' ||
    hash === null ||
    Object.keys(hash).some((key) => key !== 'nonce' && key !== 'integrity')
  )
    throw new Error(usage);
  const nonce: unknown = Reflect.get(hash, 'nonce');
  if (nonce !== undefined && typeof nonce !== 'string')
    throw new Error('Invalid browser script nonce');
  const integrity: unknown = Reflect.get(hash, 'integrity');
  if (integrity !== undefined && typeof integrity !== 'boolean')
    throw new Error('nvScripts integrity must be true or false');
  return browser.scripts(nonce, { integrity: integrity === true });
}
