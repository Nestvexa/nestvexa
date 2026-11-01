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
function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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
  /** Trusted external module tag for document layouts; optional CSP nonce is validated and escaped. */
  scripts(nonce?: string): SafeHtml {
    if (
      nonce !== undefined &&
      (typeof nonce !== 'string' ||
        /[\r\n]/.test(nonce) ||
        !/^[a-zA-Z0-9+/_-]{1,256}={0,2}$/.test(nonce))
    )
      throw new Error('Invalid browser script nonce');
    const url = this.getBootUrl();
    return SafeHtml.trusted(
      `<script type="module" src="${attribute(url)}"${nonce === undefined ? '' : ` nonce="${attribute(nonce)}"`}></script>`,
    );
  }
  /** Generated trusted module imports only the current installed allowlist; no inline application code. */
  boot(): string {
    this.getBootUrl();
    const { entries } = this.assets.getManifest();
    return `import {createLiveClient} from ${JSON.stringify(entries.live)};
import Alpine from ${JSON.stringify(entries.alpine)};
import {startLiveAlpine} from ${JSON.stringify(entries.alpineAdapter)};
const app = startLiveAlpine(Alpine, createLiveClient(${this.clientConfig()}), {
  configure(Alpine, client) {
    document.dispatchEvent(new CustomEvent('nestvexa:alpine:init', {detail: Object.freeze({Alpine, client})}));
  }
});
export {app};\n`;
  }
  private clientConfig(): string {
    const config = {
      ...(Object.keys(this.options.streams).length
        ? { streams: this.options.streams }
        : {}),
      ...(this.options.realtime ? { realtime: this.options.realtime } : {}),
    };
    return Object.keys(config).length
      ? JSON.stringify(config).replaceAll('<', '\\u003c')
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
  if (args.length !== 1 || typeof options !== 'object' || options === null)
    throw new Error('nvScripts accepts only an optional nonce hash');
  const hash: unknown = Reflect.get(options, 'hash');
  if (
    typeof hash !== 'object' ||
    hash === null ||
    Object.keys(hash).some((key) => key !== 'nonce')
  )
    throw new Error('nvScripts accepts only an optional nonce hash');
  const nonce: unknown = Reflect.get(hash, 'nonce');
  if (nonce !== undefined && typeof nonce !== 'string')
    throw new Error('Invalid browser script nonce');
  return browser.scripts(nonce);
}
