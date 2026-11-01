import {
  BadRequestException,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Action,
  Computed,
  LiveComponent,
  RealtimeChannels,
  State,
} from 'nestvexa';
import { JobRunner, RealtimeService } from '@nestvexa/realtime';

export const publicChannel = 'activity:public';

/** Public demonstration feed shared by all sessions (bounded, in memory). */
@Injectable()
export class ActivityFeed {
  readonly #items: { id: number; text: string }[] = [];
  #next = 1;
  add(text: string): void {
    this.#items.unshift({ id: this.#next++, text });
    this.#items.length = Math.min(this.#items.length, 10);
  }
  list(): readonly { id: number; text: string }[] {
    return this.#items;
  }
}
/** Late-bound publisher: the runner exists before Nest resolves RealtimeService. */
let publisher: RealtimeService | undefined;
export function connectReportJobs(service: RealtimeService): void {
  publisher = service;
}
/** Owner-bound demo jobs; progress snapshots invalidate the owner's job channel. */
export const reportJobs = new JobRunner({
  concurrency: 2,
  notify: (channel, snapshot) => {
    void publisher?.publish(channel, { status: snapshot.status });
  },
});
export const REPORT_JOBS = Symbol('report-jobs');

@Module({
  providers: [ActivityFeed, { provide: REPORT_JOBS, useValue: reportJobs }],
  exports: [ActivityFeed, REPORT_JOBS],
})
export class RealtimeDemoModule {}

export function guestBinding(request: unknown): string {
  const id: unknown =
    request && typeof request === 'object'
      ? Reflect.get(request, 'sessionID')
      : undefined;
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return `guest-session:${id}`;
}

@LiveComponent({ name: 'realtime-board', view: 'realtime-board' })
export class RealtimeBoard {
  constructor(
    @Inject(ActivityFeed) private readonly feed: ActivityFeed,
    @Inject(REPORT_JOBS) private readonly jobs: JobRunner,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(REQUEST) private readonly request: unknown,
  ) {}
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  draft = '';
  @State() jobId = '';
  @State() posted = 0;

  @RealtimeChannels() channels(): string[] {
    return this.jobId
      ? [publicChannel, JobRunner.channel(this.jobId)]
      : [publicChannel];
  }
  @Computed() get feedItems(): { id: number; text: string }[] {
    return this.feed.list().map((item) => ({ ...item }));
  }
  @Computed() get job(): { status: string; progress: number } {
    const job = this.jobId
      ? this.jobs.get({ binding: guestBinding(this.request) }, this.jobId)
      : undefined;
    return { status: job?.status ?? '', progress: job?.progress ?? 0 };
  }

  @Action() async post(): Promise<void> {
    const text = this.draft.trim();
    if (!text) throw new BadRequestException('Write a message first');
    this.feed.add(text);
    this.draft = '';
    this.posted++;
    // Other subscribed browsers refresh through their own authorized $sync route.
    await this.realtime.publish(publicChannel, null);
  }
  @Action() startReport(): void {
    const identity = { binding: guestBinding(this.request) };
    this.jobId = this.jobs.enqueue(identity, 'report', async (context) => {
      for (let step = 1; step <= 4; step++) {
        await delay(150, undefined, { signal: context.signal });
        context.progress(step * 25);
      }
      return { rows: 42 };
    }).id;
  }
  @Action() cancelReport(): void {
    if (this.jobId)
      this.jobs.cancel({ binding: guestBinding(this.request) }, this.jobId);
  }
}
