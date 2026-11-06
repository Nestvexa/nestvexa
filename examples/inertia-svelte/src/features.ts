import { Controller, Get, Query, Req } from '@nestjs/common';
import { InertiaPage, optional, scroll } from '@nestvexa/inertia';
import type { InertiaProp } from '@nestvexa/inertia';
import type { FeaturePages } from './page-types.js';

// Smoke coverage of client-owned Inertia v3 features with the official
// @inertiajs/svelte client: prefetching, polling, WhenVisible and infinite
// scroll (the React example covers the full feature tour).

interface FeatureRequest {
  readonly session: { ticks?: number; prefetchedRenders?: number };
}

type ServerProps<T> = {
  readonly [K in keyof T]-?: T[K] | (() => T[K]) | InertiaProp;
};

const PAGE_SIZE = 15;
const PAGES = 3;

@Controller('features')
export class FeaturesController {
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
}
