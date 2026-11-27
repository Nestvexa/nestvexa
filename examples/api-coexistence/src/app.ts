import 'reflect-metadata';
import { ApolloDriver } from '@nestjs/apollo';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  Post,
  Render,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Args, GqlExecutionContext, GraphQLModule } from '@nestjs/graphql';
import { Mutation, Query, Resolver } from '@nestjs/graphql';
import { MessagePattern, Payload, Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import {
  RealtimeModule,
  RealtimeService,
  attachRealtimeWebSocket,
} from '@nestvexa/realtime';
import session from 'express-session';
import {
  Action,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  RealtimeChannels,
  State,
  configureNestvexa,
} from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { API_KEY } from './contract.js';
import type { Item } from './contract.js';

// VISION-018: REST, GraphQL (Apollo), a TCP microservice, a Nest WebSocket
// gateway and Nestvexa (pages, Live actions, realtime) in one Nest process.
// Each API keeps its own guard; Nestvexa installs no global guard, pipe,
// filter, interceptor or middleware that could change their behavior.

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}

/** In-memory domain service shared by every transport. */
@Injectable()
export class ItemsService {
  #items: Item[] = [{ id: '1', name: 'Existing item' }];
  list(): readonly Item[] {
    return this.#items;
  }
  add(name: unknown): Item {
    if (typeof name !== 'string' || !/^[\p{L}\p{N} ._-]{1,40}$/u.test(name))
      throw new BadRequestException('Item names are 1-40 plain characters');
    const item = { id: String(this.#items.length + 1), name };
    this.#items = [...this.#items, item];
    return item;
  }
}

function keyOf(headers: IncomingMessage['headers']): boolean {
  return headers['x-api-key'] === API_KEY;
}

/** The host's own REST guard; it applies only where the host puts it. */
@Injectable()
class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    if (!keyOf(request.headers)) throw new ForbiddenException('API key');
    return true;
  }
}

/** The host's own GraphQL guard, reading the Apollo context request. */
@Injectable()
class GqlApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = GqlExecutionContext.create(context).getContext<{
      req: IncomingMessage;
    }>().req;
    if (!keyOf(request.headers)) throw new ForbiddenException('API key');
    return true;
  }
}

/** Public realtime channel invalidated whenever an item is added. */
const itemsChannel = 'items';

@Controller('api')
class ItemsController {
  constructor(
    @Inject(ItemsService) private readonly items: ItemsService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}
  @Get('items') list() {
    return this.items.list();
  }
  @Post('items')
  @UseGuards(ApiKeyGuard)
  async add(@Body() body: unknown) {
    const item = this.items.add(
      body && typeof body === 'object' ? Reflect.get(body, 'name') : undefined,
    );
    // Live components subscribed to the channel refresh themselves.
    await this.realtime.publish(itemsChannel, {
      count: this.items.list().length,
    });
    return item;
  }
  @Get('health') health() {
    return { status: 'ok' };
  }
}

/** Schema-first GraphQL; no code generation or reflection metadata files. */
export const typeDefs = /* GraphQL */ `
  type Item {
    id: ID!
    name: String!
  }
  type Query {
    items: [Item!]!
  }
  type Mutation {
    addItem(name: String!): Item!
  }
`;

@Resolver('Item')
class ItemsResolver {
  constructor(@Inject(ItemsService) private readonly items: ItemsService) {}
  @Query('items') list() {
    return this.items.list();
  }
  @Mutation('addItem')
  @UseGuards(GqlApiKeyGuard)
  add(@Args('name') name: string) {
    return this.items.add(name);
  }
}

/** TCP message handlers of the hybrid application. */
@Controller()
class ItemsMessages {
  constructor(@Inject(ItemsService) private readonly items: ItemsService) {}
  @MessagePattern({ cmd: 'items.count' }) count() {
    return this.items.list().length;
  }
  @MessagePattern({ cmd: 'items.add' }) add(@Payload() name: unknown) {
    return this.items.add(name);
  }
}

@LiveComponent({ name: 'inventory', view: 'inventory' })
class Inventory {
  @State() count = 0;
  constructor(@Inject(ItemsService) private readonly items: ItemsService) {}
  mount(): void {
    this.count = this.items.list().length;
  }
  @Action() refresh(): void {
    this.count = this.items.list().length;
  }
  @RealtimeChannels() channels(): string[] {
    return [itemsChannel];
  }
}

@Controller()
class PageController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('index')
  async index(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'API coexistence',
      widget: await this.live.mount(Inventory, request),
    };
  }
}

@Module({ providers: [ItemsService], exports: [ItemsService] })
class ItemsModule {}

/**
 * The guest binding of an upgrade request. Session middleware does not run
 * for upgrades, so the host runs it here on the raw request; a request
 * without an established session has no identity.
 */
function upgradeGuest(
  sessions: ReturnType<typeof session>,
  request: IncomingMessage,
): Promise<{ binding: string }> {
  return new Promise((resolve, reject) => {
    const response = new ServerResponse(request);
    sessions(request as never, response as never, (error?: unknown) => {
      if (error) {
        reject(error instanceof Error ? error : new Error('session'));
        return;
      }
      try {
        resolve({ binding: guest(request).binding });
      } catch (rejection) {
        reject(rejection instanceof Error ? rejection : new Error('guest'));
      }
    });
  });
}

function guest(request: object): { binding: string; csrfToken: string } {
  const value = request as Partial<SessionRequest>;
  if (!value.session?.csrf || !value.sessionID)
    throw new UnauthorizedException();
  return {
    binding: `guest-session:${value.sessionID}`,
    csrfToken: value.session.csrf,
  };
}

export interface CoexistenceOptions {
  readonly port: number;
  readonly microservicePort: number;
  /**
   * Port of the Nest WebSocket gateway: `'shared'` (default) attaches it to
   * the HTTP server; a number gives it its own server. Nest's `WsAdapter`
   * destroys every upgrade on its server whose path no gateway owns; the
   * Nestvexa realtime WebSocket transport claims its own path first, so it
   * runs beside the gateway in both cases.
   */
  readonly gateway?: 'shared' | number;
}

/** Build, start and return the hybrid application on 127.0.0.1. */
export async function createCoexistenceApp(
  options: CoexistenceOptions,
): Promise<NestExpressApplication> {
  const origin = `http://127.0.0.1:${options.port}`;
  const views = fileURLToPath(new URL('../views', import.meta.url));
  const gateway = options.gateway ?? 'shared';
  const gatewayOptions = { path: '/ws/items' };
  // Local demonstration only: production requires a persistent session store
  // and a deployment secret. Sessions are the host's middleware, not Nestvexa's.
  const sessions = session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: false },
  });
  /** Nest WebSocket gateway (platform-ws). */
  @WebSocketGateway(gateway === 'shared' ? 0 : gateway, gatewayOptions)
  class ItemsGateway {
    constructor(@Inject(ItemsService) private readonly items: ItemsService) {}
    @SubscribeMessage('items') list() {
      return { event: 'items', data: this.items.list() };
    }
  }
  @Module({
    imports: [
      ItemsModule,
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        typeDefs,
        path: '/graphql',
        graphiql: false,
        context: ({ req }: { req: IncomingMessage }) => ({ req }),
      }),
      RealtimeModule.forRoot({
        secrets: [randomBytes(48).toString('base64url')],
        origin,
        resolveIdentity: (request) => ({ binding: guest(request).binding }),
        resolveUpgradeIdentity: (request) => upgradeGuest(sessions, request),
        // Only the public items channel, for guests with a session.
        authorizeChannel: (identity, channel) =>
          channel === itemsChannel &&
          identity.binding.startsWith('guest-session:'),
      }),
      NestvexaModule.forRoot(
        { views: { root: views, layout: 'layout' }, live: { enabled: true } },
        {
          browser: { realtime: { endpoint: '/_nestvexa/realtime' } },
          components: [Inventory],
          imports: [ItemsModule],
          inject: [RealtimeService],
          useFactory: (realtime: RealtimeService) => ({
            origin,
            realtime,
            resolveIdentity: guest,
            authorize: (_identity, component, action) =>
              component === 'inventory' &&
              ['$mount', '$sync', 'refresh'].includes(action),
          }),
        },
      ),
    ],
    controllers: [ItemsController, ItemsMessages, PageController],
    providers: [ItemsResolver, ItemsGateway],
  })
  class AppModule {}

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
  });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: { host: '127.0.0.1', port: options.microservicePort },
  });
  app.use(sessions);
  await configureNestvexa(app);
  app.enableShutdownHooks();
  await app.startAllMicroservices();
  await app.listen(options.port, '127.0.0.1');
  // Beside the gateway on either port: the transport claims only its path.
  await attachRealtimeWebSocket(app);
  return app;
}
