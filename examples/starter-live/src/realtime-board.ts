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
  ActionInput,
  Computed,
  LiveComponent,
  LiveEvents,
  OnEvent,
  RealtimeChannels,
  State,
} from 'nestvexa';
import type { PipeTransform } from '@nestjs/common';
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
/** Server-side announcements (bounded, in memory); events carry only their id. */
@Injectable()
export class Announcements {
  readonly #items = new Map<number, string>();
  #next = 1;
  add(text: string): number {
    const id = this.#next++;
    this.#items.set(id, text);
    for (const key of this.#items.keys())
      if (this.#items.size > 20) this.#items.delete(key);
    return id;
  }
  get(id: number): string | undefined {
    return this.#items.get(id);
  }
}
/** Event payloads come back from the browser: accept only a positive integer id. */
export class AnnouncementReference implements PipeTransform {
  transform(value: unknown): { id: number } {
    const id: unknown =
      value && typeof value === 'object' ? Reflect.get(value, 'id') : undefined;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
      throw new BadRequestException('Invalid announcement reference');
    return { id };
  }
}
/** Late-bound publisher: the runner exists before Nest resolves RealtimeService. */
let publisher: RealtimeService | undefined;
export function connectReportJobs(service: RealtimeService): void {
  publisher = service;
}
/**
 * Owner-bound demo jobs; progress snapshots invalidate the owner's job channel.
 * As a Nest provider the runner is closed on application shutdown.
 */
export const reportJobs = new JobRunner({
  concurrency: 2,
  notify: (channel, snapshot) => {
    void publisher?.publish(channel, { status: snapshot.status });
  },
}).register('report', async (context) => {
  const failing =
    context.input !== null &&
    typeof context.input === 'object' &&
    Reflect.get(context.input, 'fail') === true;
  for (let step = 1; step <= 4; step++) {
    // Long enough for the browser to subscribe to the new job channel: events
    // published before the subscription exists are not replayed.
    await delay(400, undefined, { signal: context.signal });
    // The failing demo breaks halfway through every attempt.
    if (failing && step === 2) throw new Error('demo report source offline');
    context.progress(step * 25);
  }
  return { rows: 42 };
});
export const REPORT_JOBS = Symbol('report-jobs');

@Module({
  providers: [
    ActivityFeed,
    Announcements,
    { provide: REPORT_JOBS, useValue: reportJobs },
  ],
  exports: [ActivityFeed, Announcements, REPORT_JOBS],
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
    @Inject(Announcements) private readonly announcements: Announcements,
    @Inject(LiveEvents) private readonly events: LiveEvents,
  ) {}
  /** Announcements this browser received through server-pushed events. */
  @State() received: string[] = [];
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  draft = '';
  @State() jobId = '';
  @State() posted = 0;
  /** Owner-only job view, refreshed before every render. */
  @State() job = { status: '', progress: 0, attempts: 0, error: '' };

  @RealtimeChannels() channels(): string[] {
    return this.jobId
      ? [publicChannel, JobRunner.channel(this.jobId)]
      : [publicChannel];
  }
  @Computed() get feedItems(): { id: number; text: string }[] {
    return this.feed.list().map((item) => ({ ...item }));
  }
  async dehydrate(): Promise<void> {
    const job = this.jobId
      ? await this.jobs.get({ binding: guestBinding(this.request) }, this.jobId)
      : undefined;
    this.job = {
      status: job?.status ?? '',
      progress: job?.progress ?? 0,
      attempts: job?.attempts ?? 0,
      error: job?.error ?? '',
    };
  }
  @Computed() get canRetry(): boolean {
    return this.job.status === 'failed' || this.job.status === 'cancelled';
  }

  @Action() async post(): Promise<void> {
    const text = this.draft.trim();
    if (!text) throw new BadRequestException('Write a message first');
    this.feed.add(text);
    this.draft = '';
    this.posted++;
    // Other subscribed browsers refresh through their own authorized $sync route.
    await this.realtime.publish(publicChannel, null, {
      identity: { binding: guestBinding(this.request) },
    });
  }
  /**
   * Store the announcement on the server and push a domain event to every
   * browser subscribed to the public channel.
   */
  @Action() async announce(): Promise<void> {
    const id = this.announcements.add(
      `Announcement from ${this.draft.trim() || 'a guest'}`,
    );
    await this.events.publish(publicChannel, 'announcement.posted', { id });
  }
  /** Runs in each subscribed browser's component when the event arrives. */
  @Action()
  @OnEvent('announcement.posted')
  announcementPosted(
    @ActionInput(new AnnouncementReference()) input: { id: number },
  ): void {
    // Re-read authoritative data; the payload is only a reference.
    const text = this.announcements.get(input.id);
    if (text && !this.received.includes(text))
      this.received = [text, ...this.received].slice(0, 5);
  }
  async #start(fail: boolean): Promise<void> {
    const identity = { binding: guestBinding(this.request) };
    // Two attempts: a transient failure is retried automatically.
    this.jobId = (
      await this.jobs.enqueue(identity, 'report', {
        input: { fail },
        maxAttempts: 2,
      })
    ).id;
  }
  @Action() async startReport(): Promise<void> {
    await this.#start(false);
  }
  @Action() async startFailingReport(): Promise<void> {
    await this.#start(true);
  }
  /** User-initiated retry after a failed or cancelled report. */
  @Action() async retryReport(): Promise<void> {
    if (this.canRetry) await this.#start(false);
  }
  @Action() async cancelReport(): Promise<void> {
    if (this.jobId)
      await this.jobs.cancel(
        { binding: guestBinding(this.request) },
        this.jobId,
      );
  }
}
