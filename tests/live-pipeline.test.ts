import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Catch,
  Controller,
  Get,
  HttpException,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  RequestMethod,
  Scope,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  ArgumentMetadata,
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExecutionContext,
  MiddlewareConsumer,
  NestInterceptor,
  NestModule,
  PipeTransform,
  Type,
} from '@nestjs/common';
import { BaseExceptionFilter, REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';
import {
  Action,
  ActionInput,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Prop,
  State,
} from '../packages/live/dist/index.js';
import {
  application,
  cleanup,
  envelope,
  marker,
  platforms,
  policies,
  renderer,
  send,
} from './support/live-fixture.js';

const events: string[] = [];
beforeEach(() => {
  events.length = 0;
});
afterEach(cleanup);

@Injectable({ scope: Scope.REQUEST })
class RequestScoped {
  readonly id = randomUUID();
  constructor(@Inject(REQUEST) readonly request: object) {}
}
@Injectable({ scope: Scope.TRANSIENT })
class TransientDependency {
  readonly id = randomUUID();
}
const ASYNC_VALUE = Symbol('ASYNC_VALUE');
@Module({
  providers: [
    RequestScoped,
    TransientDependency,
    {
      provide: ASYNC_VALUE,
      scope: Scope.REQUEST,
      inject: [RequestScoped],
      useFactory: async (scoped: RequestScoped) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return `async:${scoped.id}`;
      },
    },
  ],
  exports: [RequestScoped, TransientDependency, ASYNC_VALUE],
})
class ScopedServices {}

@Injectable()
class GlobalGuard implements CanActivate {
  canActivate(): boolean {
    events.push('global-guard');
    return true;
  }
}
@Injectable()
class ClassGuard implements CanActivate {
  canActivate(): boolean {
    events.push('class-guard');
    return true;
  }
}
@Injectable()
class MethodGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    events.push('method-guard');
    const headers = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers;
    return headers['x-deny'] !== 'yes';
  }
}
function interceptor(label: string): Type<NestInterceptor> {
  @Injectable()
  class Recorder implements NestInterceptor {
    intercept(
      _context: ExecutionContext,
      next: CallHandler,
    ): Observable<unknown> {
      events.push(`${label}:before`);
      return next.handle().pipe(tap(() => events.push(`${label}:after`)));
    }
  }
  return Recorder;
}
const MethodInterceptor = interceptor('method-interceptor');
class GlobalPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === 'body' && metadata.data === 'input')
      events.push('global-pipe');
    return value;
  }
}
class InputPipe implements PipeTransform {
  transform(value: unknown): unknown {
    events.push('param-pipe');
    return value;
  }
}
@Catch()
class GlobalFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    events.push(
      `filter:${exception instanceof HttpException ? exception.getStatus() : 500}`,
    );
    super.catch(exception, host);
  }
}

function hooks(label: string) {
  return class {
    boot(): void {
      events.push(`${label}:boot`);
    }
    mount(): void {
      events.push(`${label}:mount`);
    }
    hydrate(): void {
      events.push(`${label}:hydrate`);
    }
    beforeAction(): void {
      events.push(`${label}:beforeAction`);
    }
    afterAction(): void {
      events.push(`${label}:afterAction`);
    }
    dehydrate(): void {
      events.push(`${label}:dehydrate`);
    }
    beforeRender(): void {
      events.push(`${label}:beforeRender`);
    }
    afterRender(): void {
      events.push(`${label}:afterRender`);
    }
    onError(): void {
      events.push(`${label}:onError`);
    }
    dispose(): void {
      events.push(`${label}:dispose`);
    }
  };
}

@LiveComponent({ name: 'pipeline-child', view: 'child' })
class PipelineChild extends hooks('child') {
  @Prop() @State() label = '';
  @State() requestId = '';
  @State() transientId = '';
  constructor(
    @Inject(RequestScoped) private readonly scoped: RequestScoped,
    @Inject(TransientDependency)
    private readonly transient: TransientDependency,
  ) {
    super();
  }
  override mount(): void {
    super.mount();
    this.requestId = this.scoped.id;
    this.transientId = this.transient.id;
  }
}

@LiveComponent({
  name: 'pipeline',
  view: 'pipeline',
  children: { item: PipelineChild },
})
@UseGuards(ClassGuard)
class Pipeline extends hooks('parent') {
  @State() requestId = '';
  @State() transientId = '';
  @State() asyncValue = '';
  constructor(
    @Inject(RequestScoped) private readonly scoped: RequestScoped,
    @Inject(TransientDependency)
    private readonly transient: TransientDependency,
    @Inject(ASYNC_VALUE) private readonly async: string,
  ) {
    super();
  }
  override mount(): void {
    super.mount();
    this.requestId = this.scoped.id;
    this.transientId = this.transient.id;
    this.asyncValue = this.async;
  }
  @Action()
  @UseGuards(MethodGuard)
  @UseInterceptors(MethodInterceptor)
  run(@ActionInput(InputPipe) input: unknown): void {
    events.push(`action:${JSON.stringify(input)}`);
    this.requestId = this.scoped.id;
  }
  @Action()
  explode(): void {
    throw new Error('database password=hunter2 at /srv/app/secret.ts:12');
  }
  @Action()
  teapot(): void {
    throw new HttpException(
      { statusCode: 418, message: 'short and stout' },
      418,
    );
  }
}

@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get('pipeline')
  async page(@Req() req: object) {
    return { html: (await this.live.mount(Pipeline, req)).value };
  }
}

@Module({})
class MiddlewareModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_request: unknown, _response: unknown, next: () => void) => {
        events.push('middleware');
        next();
      })
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}

async function boot(platform: (typeof platforms)[number]) {
  const env = await renderer({
    pipeline: '<p>{{requestId}}</p>{{nvChild "item" "one" label="first"}}',
    child: '<i>{{label}}|{{requestId}}|{{transientId}}</i>',
  });
  const app = await application(
    platform,
    [
      MiddlewareModule,
      LiveModule.registerAsync({
        components: [Pipeline, PipelineChild],
        imports: [ScopedServices],
        useFactory: () =>
          policies(env.engine, (component, action) => {
            events.push(`authorize:${component}:${action}`);
            return true;
          }),
      }),
    ],
    [Pages],
    env.resource,
    (app) => {
      app.useGlobalGuards(new GlobalGuard());
      app.useGlobalInterceptors(new (interceptor('global-interceptor'))());
      app.useGlobalPipes(new GlobalPipe());
      app.useGlobalFilters(new GlobalFilter(app.getHttpAdapter()));
    },
  );
  return app;
}

describe.each(platforms)(
  'Live through the full Nest pipeline on %s',
  (platform) => {
    it('resolves request, transient and async providers per request and orders nested hooks', async () => {
      const app = await boot(platform);
      const page = await send(app, '/pipeline');
      expect(page.status).toBe(200);
      const html = String(page.json()['html']);
      const parentRequest = /<p>([^<]+)<\/p>/.exec(html)?.[1];
      const child = /<i>first\|([^|]+)\|([^<]+)<\/i>/.exec(html);
      expect(parentRequest).toBeTruthy();
      // Parent and child share the request context but not transient instances.
      expect(child?.[1]).toBe(parentRequest);
      const state = JSON.parse(
        (
          /data-nv-name="pipeline"[^>]*data-nv-state="([^"]+)"/.exec(
            html,
          )?.[1] ?? '{}'
        ).replaceAll('&quot;', '"'),
      ) as Record<string, string>;
      expect(state['asyncValue']).toBe(`async:${parentRequest}`);
      expect(state['transientId']).not.toBe(child?.[2]);
      expect(events.filter((entry) => !entry.startsWith('authorize'))).toEqual([
        'middleware',
        'global-guard',
        'global-interceptor:before',
        'parent:boot',
        'parent:mount',
        'parent:dehydrate',
        'parent:beforeRender',
        'child:boot',
        'child:mount',
        'child:dehydrate',
        'child:beforeRender',
        'child:afterRender',
        'child:dispose',
        'parent:afterRender',
        'parent:dispose',
        'global-interceptor:after',
      ]);
      const second = String((await send(app, '/pipeline')).json()['html']);
      expect(/<p>([^<]+)<\/p>/.exec(second)?.[1]).not.toBe(parentRequest);
    });

    it('runs middleware, guards, host authorization, interceptors and pipes before the action in Nest order', async () => {
      const app = await boot(platform);
      const html = String((await send(app, '/pipeline')).json()['html']);
      events.length = 0;
      const reply = await send(
        app,
        '/_nestvexa/live/pipeline/run',
        envelope(marker(html, 'pipeline'), { input: { id: 1 } }),
      );
      expect(reply.status).toBe(201);
      expect(events).toEqual([
        'middleware',
        'global-guard',
        'authorize:pipeline:run',
        'class-guard',
        'method-guard',
        'global-interceptor:before',
        'method-interceptor:before',
        'global-pipe',
        'param-pipe',
        'parent:boot',
        'parent:hydrate',
        'parent:beforeAction',
        'action:{"id":1}',
        'parent:afterAction',
        'parent:dehydrate',
        'parent:beforeRender',
        // The retained child's props did not change: it is neither re-run nor re-rendered.
        'parent:afterRender',
        'parent:dispose',
        'method-interceptor:after',
        'global-interceptor:after',
      ]);
      events.length = 0;
      const denied = await send(
        app,
        '/_nestvexa/live/pipeline/run',
        envelope({ ...marker(html, 'pipeline'), revision: 1 }, { input: 1 }),
        { 'x-deny': 'yes' },
      );
      expect(denied.status).toBe(403);
      expect(events).not.toContain('param-pipe');
      expect(events.some((entry) => entry.startsWith('parent:'))).toBe(false);
      expect(events).toContain('filter:403');
    });

    it('maps errors through filters without exposing internals and invalidates uncertain state', async () => {
      const app = await boot(platform);
      const html = String((await send(app, '/pipeline')).json()['html']);
      const reference = marker(html, 'pipeline');
      events.length = 0;
      const exploded = await send(
        app,
        '/_nestvexa/live/pipeline/explode',
        envelope(reference),
      );
      expect(exploded.status).toBe(500);
      expect(exploded.json()).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
      expect(exploded.body).not.toContain('hunter2');
      expect(exploded.body).not.toContain('secret.ts');
      expect(events).toContain('parent:onError');
      expect(events).toContain('filter:500');
      const replay = await send(
        app,
        '/_nestvexa/live/pipeline/explode',
        envelope(reference),
      );
      expect(replay.status).toBe(410);
      expect(replay.json()).toEqual({
        statusCode: 410,
        code: 'INVALID_SNAPSHOT',
      });
      const fresh = marker(
        String((await send(app, '/pipeline')).json()['html']),
        'pipeline',
      );
      const teapot = await send(
        app,
        '/_nestvexa/live/pipeline/teapot',
        envelope(fresh),
      );
      expect(teapot.status).toBe(418);
      expect(teapot.json()).toEqual({
        statusCode: 418,
        message: 'short and stout',
      });
      const csrf = await send(
        app,
        '/_nestvexa/live/pipeline/run',
        envelope(fresh),
        {
          'x-nestvexa-csrf': 'forged',
        },
      );
      expect(csrf.json()).toEqual({ statusCode: 403, code: 'CSRF_REJECTED' });
    });
  },
);

@LiveComponent({ name: 'collide', view: 'child' })
class Collide {
  @State() label = '';
  @Action() save(): void {
    this.label = 'saved';
  }
}
@Controller('_nestvexa/live/collide')
class ExactCollision {
  @Post('save') save(): string {
    return 'host';
  }
}
@Controller('_nestvexa/live')
class ParameterCollision {
  @Post(':component/:action') any(): string {
    return 'host';
  }
}
@Controller('_nestvexa/live/collide')
class SafeNeighbours {
  @Get('save') read(): string {
    return 'read-only';
  }
  @Post('other/save') nested(): string {
    return 'deeper';
  }
}

describe.each(platforms)(
  'host route collision diagnostics on %s',
  (platform) => {
    async function init(controller: Type<object>) {
      const env = await renderer({ child: '<i>{{label}}</i>' });
      const module = await Test.createTestingModule({
        imports: [
          LiveModule.registerAsync({
            components: [Collide],
            useFactory: () => policies(env.engine),
          }),
        ],
        controllers: [controller],
      }).compile();
      const app =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      env.resource.app = app;
      return app.init();
    }
    it.each([
      [
        ExactCollision,
        'POST /_nestvexa/live/collide/save (ExactCollision.save)',
      ],
      [ParameterCollision, 'ParameterCollision.any'],
    ] as const)(
      'rejects %o before accepting traffic',
      async (controller, owner) => {
        await expect(init(controller)).rejects.toThrow(owner);
        await expect(init(controller)).rejects.toThrow(
          'register LiveModule with a different endpoint',
        );
      },
    );
    it('accepts other methods and deeper paths', async () => {
      await expect(init(SafeNeighbours)).resolves.toBeDefined();
    });
  },
);
