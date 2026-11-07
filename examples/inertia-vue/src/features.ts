import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  InertiaPage,
  InertiaService,
  InertiaValidationException,
  once,
  optional,
  redirect,
  scroll,
} from '@nestvexa/inertia';
import type { InertiaProp } from '@nestvexa/inertia';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FeaturePages, Todo } from './page-types.js';

// Client-owned Inertia v3 features with the official @inertiajs/vue3 client:
// prefetching, polling, WhenVisible and infinite scroll on /features, and the
// tour on /features/tour: manual/instant visits, non-GET links, view
// transitions, remembered state, once props, optimistic updates, scroll
// management and the progress indicator.

interface FeatureRequest {
  readonly session: {
    ticks?: number;
    prefetchedRenders?: number;
    todos?: Todo[];
  };
}

type ServerProps<T> = {
  readonly [K in keyof T]-?: T[K] | (() => T[K]) | InertiaProp;
};

const PAGE_SIZE = 15;
const PAGES = 3;
const LONG_PAGES = 3;
const TOUR = '/features/tour';

@Controller('features')
export class FeaturesController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get()
  @InertiaPage('Features/Index')
  index(
    @Req() request: FeatureRequest,
  ): ServerProps<FeaturePages['Features/Index']> {
    return {
      tick: () => {
        request.session.ticks = (request.session.ticks ?? 0) + 1;
        return request.session.ticks;
      },
      below: optional(() => 'Loaded when visible'),
    };
  }

  /** Counts renders so the browser test can prove a prefetch was reused. */
  @Get('prefetched')
  @InertiaPage('Features/Prefetched')
  prefetched(
    @Req() request: FeatureRequest,
  ): ServerProps<FeaturePages['Features/Prefetched']> {
    request.session.prefetchedRenders =
      (request.session.prefetchedRenders ?? 0) + 1;
    return { renders: request.session.prefetchedRenders };
  }

  @Get('scroll')
  @InertiaPage('Features/Scroll')
  scrollPage(
    @Query('page') raw: unknown,
  ): ServerProps<FeaturePages['Features/Scroll']> {
    const parsed = typeof raw === 'string' ? Number(raw) : 1;
    const page =
      Number.isInteger(parsed) && parsed >= 1 && parsed <= PAGES ? parsed : 1;
    return {
      items: scroll(
        () => ({
          data: Array.from({ length: PAGE_SIZE }, (_, index) => {
            const id = (page - 1) * PAGE_SIZE + index + 1;
            return { id, label: `Item ${id}` };
          }),
        }),
        {
          metadata: {
            pageName: 'page',
            previousPage: page > 1 ? page - 1 : null,
            nextPage: page < PAGES ? page + 1 : null,
            currentPage: page,
          },
        },
      ),
    };
  }

  @Get('tour')
  @InertiaPage('Features/Tour')
  tour(): ServerProps<FeaturePages['Features/Tour']> {
    return { title: 'Client features tour' };
  }

  @Get('target')
  @InertiaPage('Features/Target')
  target(
    @Query('from') from: unknown,
  ): ServerProps<FeaturePages['Features/Target']> {
    return {
      from:
        typeof from === 'string' && /^[a-z.-]{1,32}$/.test(from)
          ? from
          : 'unknown',
    };
  }

  /** Non-GET endpoint for `<Link method="post">` and `router.post`. */
  @Post('ping')
  ping(@Req() request: object, @Body() body: unknown) {
    const source = (body as Record<string, unknown> | undefined)?.['source'];
    this.inertia.flash(
      request,
      'success',
      `Ping via ${typeof source === 'string' ? source.slice(0, 32) : 'unknown'}`,
    );
    return redirect(TOUR);
  }

  /** An instant visit shows this page's component before the reply arrives. */
  @Get('slow')
  @InertiaPage('Features/Slow')
  async slow(): Promise<ServerProps<FeaturePages['Features/Slow']>> {
    await delay(200);
    return { loaded: 'Loaded from the server' };
  }

  @Get('remember')
  @InertiaPage('Features/Remember')
  remember(): ServerProps<FeaturePages['Features/Remember']> {
    return {};
  }

  @Get('once/:step')
  @InertiaPage('Features/Once')
  oncePage(
    @Param('step') step: string,
  ): ServerProps<FeaturePages['Features/Once']> {
    return {
      step: step === 'b' ? 'b' : 'a',
      plans: once(() => ({
        token: randomBytes(6).toString('hex'),
        names: ['Basic', 'Pro'],
      })),
    };
  }

  @Get('todos')
  @InertiaPage('Features/Todos')
  todos(
    @Req() request: FeatureRequest,
  ): ServerProps<FeaturePages['Features/Todos']> {
    return { todos: () => [...(request.session.todos ?? [])] };
  }

  /** Slightly slow, like a real write; the optimistic item shows meanwhile. */
  @Post('todos')
  async addTodo(@Req() request: FeatureRequest, @Body() body: unknown) {
    await delay(200);
    const raw = (body as Record<string, unknown> | undefined)?.['title'];
    const title = typeof raw === 'string' ? raw.trim().slice(0, 60) : '';
    if (!title)
      throw new InertiaValidationException({ title: 'Enter a title.' });
    if (title === 'fail')
      throw new InertiaValidationException({
        title: 'The server rejected this todo.',
      });
    const todos = request.session.todos ?? [];
    request.session.todos = [...todos, { id: todos.length + 1, title }];
    return redirect('/features/todos');
  }

  /** Tall pages with a scroll region, for scroll reset/preserve/restore. */
  @Get('long/:page')
  @InertiaPage('Features/Long')
  long(@Param('page') raw: string): ServerProps<FeaturePages['Features/Long']> {
    const parsed = Number(raw);
    const page =
      Number.isInteger(parsed) && parsed >= 1 && parsed <= LONG_PAGES
        ? parsed
        : 1;
    return { page, next: page < LONG_PAGES ? page + 1 : 1 };
  }
}
