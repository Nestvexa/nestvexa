import { Inject, Injectable } from '@nestjs/common';
import { Cache, MemoryCacheStore } from '@nestvexa/cache';
import { RealtimeService } from '@nestvexa/realtime';
import { projectsChannel } from './context.js';
import { ProjectRepository } from './tenancy.js';

/** Tenant summary, cached per tenant (the tenant is part of the cache key). */
@Injectable()
export class SummaryCache {
  readonly cache = new Cache(new MemoryCacheStore(200));
  constructor(
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
  ) {}
  summary(tenant: string) {
    return this.cache.get(
      {
        namespace: 'data:project-summary',
        // Tenant-wide data: every member of the tenant shares one entry.
        scope: {
          kind: 'private',
          binding: `tenant-scope:${tenant}:projects`,
          tenant,
        },
      },
      { ttlMs: 60_000, tags: [`projects:${tenant}`] },
      () => {
        const rows = this.projects.list(tenant);
        return {
          tenant,
          total: rows.length,
          done: rows.filter((row) => row.status === 'done').length,
          names: rows.map((row) => row.name),
        };
      },
    );
  }
  async invalidate(tenant: string): Promise<void> {
    await this.cache.invalidate([`projects:${tenant}`]);
  }
}

/** After every write: refresh subscribed boards and drop the cached summary. */
@Injectable()
export class ProjectEvents {
  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(SummaryCache) private readonly summaries: SummaryCache,
  ) {}
  async changed(tenant: string): Promise<void> {
    await this.summaries.invalidate(tenant);
    await this.realtime.publish(projectsChannel(tenant));
  }
}
