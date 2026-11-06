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
import { customAdapter, validateForm } from '@nestvexa/forms';
import {
  InertiaPage,
  InertiaService,
  InertiaValidationException,
  Precognitive,
  merge,
  once,
  optional,
  redirect,
  scroll,
} from '@nestvexa/inertia';
import type { InertiaProp } from '@nestvexa/inertia';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FeaturePages, LargeRow, Todo } from './page-types.js';

// Pages that exercise client-owned Inertia v3 features with the official
// @inertiajs/react client: prefetching, polling, manual/instant visits,
// non-GET links, view transitions, infinite scroll and merge props,
// WhenVisible, remembered state, once props, history encryption with
// clearHistory, optimistic updates, Precognition and a large page payload.

interface FeatureSession {
  ticks?: number;
  prefetchedRenders?: number;
  todos?: Todo[];
}

interface FeatureRequest {
  readonly session: FeatureSession;
}

type ServerProps<T> = {
  readonly [K in keyof T]-?: T[K] | (() => T[K]) | InertiaProp;
};

const PAGE_SIZE = 15;
const SCROLL_PAGES = 3;
const LARGE_ROWS = 20000;

function pageNumber(value: unknown, pages: number): number {
  const parsed = typeof value === 'string' ? Number(value) : 1;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= pages
    ? parsed
    : 1;
}

/** Signup rules shared by Precognition and the real submission. */
export const signupSchema = customAdapter<{ name: string; email: string }>(
  (input, issues) => {
    const name = typeof input['name'] === 'string' ? input['name'].trim() : '';
    const email =
      typeof input['email'] === 'string' ? input['email'].trim() : '';
    if (!name) issues.issue('name', 'required', 'The name field is required.');
    else if (name.toLowerCase() === 'taken')
      issues.issue('name', 'unique', 'The name has already been taken.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      issues.issue(
        'email',
        'email',
        'The email must be a valid email address.',
      );
    return { name, email };
  },
);

@Controller('features')
export class FeaturesController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get()
  @InertiaPage('Features/Index')
  index(): ServerProps<FeaturePages['Features/Index']> {
    return { title: 'Client features' };
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
    return redirect('/features');
  }

  /** An instant visit shows this page's component before the reply arrives. */
  @Get('slow')
  @InertiaPage('Features/Slow')
  async slow(): Promise<ServerProps<FeaturePages['Features/Slow']>> {
    await delay(200);
    return { loaded: 'Loaded from the server' };
  }

  @Get('poll')
  @InertiaPage('Features/Poll')
  poll(
    @Req() request: FeatureRequest,
  ): ServerProps<FeaturePages['Features/Poll']> {
    return {
      tick: () => {
        request.session.ticks = (request.session.ticks ?? 0) + 1;
        return request.session.ticks;
      },
    };
  }

  @Get('scroll')
  @InertiaPage('Features/Scroll')
  scrollPage(
    @Query('page') rawPage: unknown,
    @Query('notes') rawNotes: unknown,
  ): ServerProps<FeaturePages['Features/Scroll']> {
    const page = pageNumber(rawPage, SCROLL_PAGES);
    const notesPage = pageNumber(rawNotes, 3);
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
            nextPage: page < SCROLL_PAGES ? page + 1 : null,
            currentPage: page,
          },
        },
      ),
      notes: merge(() => [
        { id: notesPage, text: `Note batch ${notesPage}` },
      ]).matchOn('id'),
    };
  }

  @Get('lazy')
  @InertiaPage('Features/Lazy')
  lazy(): ServerProps<FeaturePages['Features/Lazy']> {
    return {
      below: optional(() => 'Loaded when visible'),
    };
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

  @Get('secret')
  @InertiaPage('Features/Secret', { encryptHistory: true })
  secret(): ServerProps<FeaturePages['Features/Secret']> {
    return { secret: `classified-${randomBytes(6).toString('hex')}` };
  }

  /** Clears the client's history encryption keys on the next page. */
  @Post('forget')
  forget(@Req() request: object) {
    this.inertia.clearHistory(request);
    return redirect('/features');
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

  @Get('signup')
  @InertiaPage('Features/Signup')
  signup(): ServerProps<FeaturePages['Features/Signup']> {
    return {};
  }

  /** Precognition answers validation-only requests; submissions run below. */
  @Post('signup')
  @Precognitive(signupSchema)
  async register(@Req() request: object, @Body() body: unknown) {
    const result = await validateForm(signupSchema, body);
    if (!result.ok) throw new InertiaValidationException(result.errors);
    this.inertia.flash(request, 'success', `Welcome, ${result.value.name}`);
    return redirect('/features');
  }

  @Get('large')
  @InertiaPage('Features/Large')
  large(): ServerProps<FeaturePages['Features/Large']> {
    return {
      rows: (): LargeRow[] =>
        Array.from({ length: LARGE_ROWS }, (_, index) => ({
          id: index + 1,
          name: `Row ${index + 1}`,
          email: `row${index + 1}@example.test`,
          note: 'Large payload <script>not markup</script> & text',
        })),
    };
  }
}
