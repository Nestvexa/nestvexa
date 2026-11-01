import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';
import { resolveOptions } from './options.js';
import type { UploadsHostOptions } from './options.js';
import { UPLOADS_OPTIONS, UploadsService } from './service.js';

export interface UploadsModuleOptions extends UploadsHostOptions {
  /** Route prefix. Default `/_nestvexa/uploads`. */
  readonly endpoint?: string;
  /** Register UploadsService globally (for Live components in other modules). Default false. */
  readonly global?: boolean;
  readonly imports?: ModuleMetadata['imports'];
}
export interface UploadsModuleAsyncOptions<
  Dependencies extends unknown[] = unknown[],
> {
  readonly endpoint?: string;
  readonly global?: boolean;
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => UploadsHostOptions | Promise<UploadsHostOptions>;
}

function endpointPath(value: unknown): string {
  const endpoint = value === undefined ? '/_nestvexa/uploads' : value;
  if (
    typeof endpoint !== 'string' ||
    endpoint.length > 256 ||
    !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(endpoint)
  )
    throw new Error('Invalid uploads endpoint prefix');
  return endpoint;
}

const headers = [
  ['Cache-Control', 'no-store'],
  ['X-Content-Type-Options', 'nosniff'],
] as const;
function secured(target: object, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) throw new Error('Missing uploads handler');
  for (const [name, value] of headers)
    Header(name, value)(target, key, descriptor);
}

/** Generated routes under the configured prefix. All state-changing routes need Origin + CSRF. */
function uploadsController(endpoint: string): Type<object> {
  @Controller({ path: endpoint, version: VERSION_NEUTRAL })
  class UploadsController {
    constructor(
      @Inject(UploadsService) private readonly uploads: UploadsService,
    ) {}
    @Post('files')
    @HttpCode(201)
    file(@Req() request: object, @Res({ passthrough: true }) response: object) {
      return this.uploads.receiveFile(request, response);
    }
    @Post('sessions')
    @HttpCode(201)
    create(@Req() request: object, @Body() body: unknown) {
      return this.uploads.createSession(request, body);
    }
    @Get('sessions/:id')
    status(@Req() request: object, @Param('id') id: string) {
      return this.uploads.sessionStatus(request, id);
    }
    @Put('sessions/:id/chunks/:index')
    chunk(
      @Req() request: object,
      @Param('id') id: string,
      @Param('index') index: string,
      @Res({ passthrough: true }) response: object,
    ) {
      return this.uploads.receiveChunk(request, id, index, response);
    }
    @Post('sessions/:id/complete')
    @HttpCode(200)
    complete(
      @Req() request: object,
      @Param('id') id: string,
      @Body() body: unknown,
    ) {
      return this.uploads.completeSession(request, id, body);
    }
    @Delete('sessions/:id')
    @HttpCode(204)
    async cancelSession(
      @Req() request: object,
      @Param('id') id: string,
    ): Promise<void> {
      await this.uploads.discardRequest(request, 'session', id);
    }
    @Delete('files/:token')
    @HttpCode(204)
    async cancelFile(
      @Req() request: object,
      @Param('token') token: string,
    ): Promise<void> {
      await this.uploads.discardRequest(request, 'file', token);
    }
  }
  for (const key of [
    'file',
    'create',
    'status',
    'chunk',
    'complete',
    'cancelSession',
    'cancelFile',
  ])
    secured(UploadsController.prototype, key);
  return UploadsController;
}

/** Opt-in upload subsystem. Remember `await configureUploads(app)` for Fastify hosts. */
@Module({})
export class UploadsModule {
  static register(options: UploadsModuleOptions): DynamicModule {
    const endpoint = endpointPath(options.endpoint);
    const resolved = resolveOptions(options);
    return {
      module: UploadsModule,
      global: options.global === true,
      imports: [...(options.imports ?? [])],
      controllers: [uploadsController(endpoint)],
      providers: [
        { provide: UPLOADS_OPTIONS, useValue: resolved },
        UploadsService,
      ],
      exports: [UploadsService],
    };
  }
  static registerAsync<Dependencies extends unknown[]>(
    options: UploadsModuleAsyncOptions<Dependencies>,
  ): DynamicModule {
    const endpoint = endpointPath(options.endpoint);
    if (typeof options.useFactory !== 'function')
      throw new Error('Uploads async configuration requires useFactory');
    const useFactory = options.useFactory;
    return {
      module: UploadsModule,
      global: options.global === true,
      imports: [...(options.imports ?? [])],
      controllers: [uploadsController(endpoint)],
      providers: [
        {
          provide: UPLOADS_OPTIONS,
          inject: [...(options.inject ?? [])],
          useFactory: async (...dependencies: Dependencies) => {
            const host = await useFactory(...dependencies);
            if (
              host &&
              typeof host === 'object' &&
              ('endpoint' in host || 'global' in host || 'imports' in host)
            )
              throw new Error(
                'Uploads factory cannot override static registration options',
              );
            return resolveOptions(host);
          },
        },
        UploadsService,
      ],
      exports: [UploadsService],
    };
  }
}

interface FastifyLike {
  hasContentTypeParser(type: string): boolean;
  addContentTypeParser(
    type: string,
    handler: (
      request: unknown,
      payload: unknown,
      done: (error: Error | null, body?: unknown) => void,
    ) => void,
  ): void;
}
function fastifyLike(value: unknown): value is FastifyLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'hasContentTypeParser') === 'function' &&
    typeof Reflect.get(value, 'addContentTypeParser') === 'function'
  );
}

/**
 * Prepare the HTTP adapter before `app.init()`/`listen()`. Fastify needs
 * pass-through content-type parsers so raw and multipart bodies stay
 * unconsumed streams; Express needs nothing (its JSON/urlencoded parsers skip
 * these types). Safe to call more than once.
 */
export async function configureUploads(app: {
  getHttpAdapter(): { getType(): string; getInstance(): unknown };
}): Promise<void> {
  const adapter = app.getHttpAdapter();
  if (adapter.getType() !== 'fastify') return;
  const instance = adapter.getInstance();
  if (!fastifyLike(instance)) throw new Error('Unsupported Fastify instance');
  for (const type of ['multipart/form-data', 'application/octet-stream'])
    if (!instance.hasContentTypeParser(type))
      instance.addContentTypeParser(type, (_request, _payload, done) =>
        done(null),
      );
}
