import {
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Res,
  ServiceUnavailableException,
  StreamableFile,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type {
  DynamicModule,
  OnApplicationShutdown,
  OnModuleInit,
  Type,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { readFile } from 'node:fs/promises';
import {
  CLIENT_MODULES,
  assetTag,
  catalogVersion,
  matchesAssetTag,
  normalizeAssetOptions,
} from './asset-catalog.js';
import type {
  AssetOptions,
  ClientAsset,
  ClientAssetManifest,
  NestvexaAssetOptions,
} from './asset-catalog.js';
export type {
  ClientAsset,
  ClientAssetManifest,
  NestvexaAssetOptions,
} from './asset-catalog.js';

const ASSET_OPTIONS = Symbol('nv:asset-options');

@Injectable()
class AssetRegistration {
  private claimed = false;
  claim(): void {
    if (this.claimed)
      throw new Error('Register NestvexaAssetsModule once per application');
    this.claimed = true;
  }
}
@Module({ providers: [AssetRegistration], exports: [AssetRegistration] })
class AssetInfrastructureModule {}

async function installedAssets(): Promise<ReadonlyMap<string, string>> {
  const client = new URL(import.meta.resolve('@nestvexa/client'));
  const sources: readonly (readonly [string, URL])[] = [
    ...CLIENT_MODULES.map((name) => [name, new URL(name, client)] as const),
    ['alpine-adapter.js', new URL(import.meta.resolve('@nestvexa/alpine'))],
    [
      'alpine.js',
      new URL('./module.esm.js', import.meta.resolve('@alpinejs/csp')),
    ],
  ];
  return new Map(
    await Promise.all(
      sources.map(
        async ([name, file]) => [name, await readFile(file, 'utf8')] as const,
      ),
    ),
  );
}

/** App-local immutable asset snapshot. Importing the package does not read or serve files. */
@Injectable()
export class NestvexaAssetsService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly assets = new Map<string, ClientAsset>();
  private manifest: ClientAssetManifest | undefined;
  private initialization: Promise<void> | undefined;
  private closed = false;
  constructor(
    @Inject(ASSET_OPTIONS) private readonly options: AssetOptions,
    @Inject(AssetRegistration) registration: AssetRegistration,
  ) {
    registration.claim();
  }

  onModuleInit(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error('Nestvexa assets have shut down'));
    this.initialization ??= this.initialize();
    return this.initialization;
  }
  private async initialize(): Promise<void> {
    const files = await installedAssets();
    if (this.closed) throw new Error('Nestvexa assets have shut down');
    const version = catalogVersion(files);
    const prefix = `${this.options.basePath}${this.options.path}/${version}`;
    const urls: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [name, content] of files) {
      this.assets.set(
        name,
        Object.freeze({ content, etag: assetTag(content) }),
      );
      urls[name] = `${prefix}/${name}`;
    }
    this.manifest = Object.freeze({
      version,
      files: Object.freeze(urls),
      entries: Object.freeze({
        live: `${prefix}/index.js`,
        alpine: `${prefix}/alpine.js`,
        alpineAdapter: `${prefix}/alpine-adapter.js`,
      }),
    });
  }
  /** Available after app.init()/listen(). basePath must match the host's actual public prefix. */
  getManifest(): ClientAssetManifest {
    if (this.closed || !this.manifest)
      throw new ServiceUnavailableException('Nestvexa assets are not ready');
    return this.manifest;
  }
  /** Retrieve approved snapshotted bytes only; no request value is used as a filesystem path. */
  read(version: string, name: string): ClientAsset {
    const manifest = this.getManifest();
    const asset = this.assets.get(name);
    if (version !== manifest.version || !asset)
      throw new NotFoundException('Nestvexa client asset not found');
    return asset;
  }
  onApplicationShutdown(): void {
    this.closed = true;
    this.manifest = undefined;
    this.assets.clear();
  }
}

function assetController(path: string): Type<object> {
  @Controller({ path, version: VERSION_NEUTRAL })
  class ClientAssetsController {
    constructor(
      @Inject(NestvexaAssetsService)
      private readonly assets: NestvexaAssetsService,
      @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    ) {}
    @Get(':version/:asset')
    serve(
      @Param('version') version: string,
      @Param('asset') name: string,
      @Headers('if-none-match') condition: unknown,
      @Res({ passthrough: true }) response: unknown,
    ): StreamableFile | undefined {
      const adapter = this.host.httpAdapter;
      adapter.setHeader(response, 'Cache-Control', 'no-store');
      const asset = this.assets.read(version, name);
      adapter.setHeader(
        response,
        'Content-Type',
        'text/javascript; charset=utf-8',
      );
      adapter.setHeader(response, 'X-Content-Type-Options', 'nosniff');
      adapter.setHeader(
        response,
        'Cache-Control',
        'public, max-age=31536000, immutable',
      );
      adapter.setHeader(response, 'ETag', asset.etag);
      if (matchesAssetTag(condition, asset.etag)) {
        adapter.status(response, 304);
        return;
      }
      // Express res.send() would independently reinterpret conditional headers.
      // Nest's public stream response preserves this handler's checked status.
      return new StreamableFile(Buffer.from(asset.content, 'utf8'), {
        type: 'text/javascript; charset=utf-8',
      });
    }
  }
  return ClientAssetsController;
}

/** Explicit same-origin asset hosting; does not start Alpine, configure sessions or register Live actions. */
@Module({})
export class NestvexaAssetsModule {
  static register(options: NestvexaAssetOptions = {}): DynamicModule {
    const normalized = normalizeAssetOptions(options);
    return {
      module: NestvexaAssetsModule,
      imports: [AssetInfrastructureModule],
      controllers: [assetController(normalized.path)],
      providers: [
        { provide: ASSET_OPTIONS, useValue: normalized },
        NestvexaAssetsService,
      ],
      exports: [NestvexaAssetsService],
    };
  }
}
