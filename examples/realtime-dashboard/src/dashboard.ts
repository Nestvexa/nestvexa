import {
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
import type { RealtimeIdentity } from '@nestvexa/realtime';

/** Opaque, server-chosen channel names. */
export const metricsChannel = 'metrics:global';
export const presenceChannel = 'presence:dashboard';
export const incidentsChannel = 'incidents:ops';

export type Role = 'viewer' | 'operator';
interface DashboardSession {
  csrf?: string;
  role?: Role;
  viewerName?: string;
}
export interface SessionRequest {
  session: DashboardSession;
  sessionID: string;
  body?: unknown;
}

/** The viewer of a request, read only from the server-side session. */
export function viewerOf(request: unknown): {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly binding: string;
} {
  const value = request as Partial<SessionRequest> | undefined;
  const id = value?.sessionID;
  const session = value?.session;
  if (typeof id !== 'string' || !id || !session?.viewerName)
    throw new UnauthorizedException();
  const role: Role = session.role === 'operator' ? 'operator' : 'viewer';
  // The role is part of the binding: switching roles invalidates earlier
  // Live snapshots and realtime tokens.
  return {
    id,
    name: session.viewerName,
    role,
    binding: `guest-session:${id}:role:${role}`,
  };
}
/** Channel policy, evaluated when tokens are signed and again on connect. */
export function authorizeChannel(
  identity: RealtimeIdentity,
  channel: string,
): boolean | Promise<boolean> {
  if (channel === metricsChannel || channel === presenceChannel) return true;
  if (channel === incidentsChannel)
    return identity.binding.endsWith(':role:operator');
  return reportJobs.authorize(identity, channel);
}

/** Late-bound publisher: the runner exists before Nest resolves RealtimeService. */
let publisher: RealtimeService | undefined;
export function connectReportJobs(service: RealtimeService): void {
  publisher = service;
}
/** Owner-bound report jobs; each progress step invalidates the owner's job channel. */
export const reportJobs = new JobRunner({
  concurrency: 2,
  notify: (channel, snapshot) => {
    void publisher?.publish(channel, { status: snapshot.status });
  },
}).register('report', async (context) => {
  for (let step = 1; step <= 4; step++) {
    await delay(200, undefined, { signal: context.signal });
    context.progress(step * 25);
  }
  // The order count captured when the report was requested (public JSON input).
  const orders: unknown =
    context.input !== null && typeof context.input === 'object'
      ? Reflect.get(context.input, 'orders')
      : 0;
  return { orders: typeof orders === 'number' ? orders : 0 };
});
const REPORT_JOBS = Symbol('report-jobs');

/** Public demonstration metrics shared by every viewer (process memory). */
@Injectable()
export class MetricsStore {
  orders = 0;
  revenue = 0;
  lastOrderBy = '';
  record(by: string): number {
    this.orders++;
    // Deterministic sample amounts: 20–49 currency units.
    this.revenue += 20 + ((this.orders * 7) % 30);
    this.lastOrderBy = by;
    return this.orders;
  }
}

/** Operator-only incident log (process memory, newest first, bounded). */
@Injectable()
export class IncidentLog {
  readonly #items: { id: number; title: string; by: string }[] = [];
  #next = 1;
  add(title: string, by: string): void {
    this.#items.unshift({ id: this.#next++, title, by });
    this.#items.length = Math.min(this.#items.length, 10);
  }
  list(): readonly { id: number; title: string; by: string }[] {
    return this.#items;
  }
}

/**
 * Host-side presence. @nestvexa/realtime has no presence primitive, so each
 * open dashboard sends a read-only `heartbeat` action (`nv:poll`) and viewers
 * that miss heartbeats for the TTL are dropped by a sweep. Joins and leaves
 * invalidate the public presence channel; heartbeats alone do not.
 */
@Injectable()
export class PresenceRegistry implements OnModuleInit, OnModuleDestroy {
  static readonly ttlMs = Number(process.env['PRESENCE_TTL_MS'] ?? 20_000);
  readonly #seen = new Map<string, { name: string; at: number }>();
  #sweep: ReturnType<typeof setInterval> | undefined;
  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}
  onModuleInit(): void {
    this.#sweep = setInterval(() => {
      const cutoff = Date.now() - PresenceRegistry.ttlMs;
      let changed = false;
      for (const [id, entry] of this.#seen)
        if (entry.at < cutoff) changed = this.#seen.delete(id) || changed;
      if (changed) void this.realtime.publish(presenceChannel);
    }, 1000);
    this.#sweep.unref();
  }
  onModuleDestroy(): void {
    clearInterval(this.#sweep);
  }
  /** Record a heartbeat; announces a join to everyone else. */
  touch(id: string, name: string): void {
    const joined = !this.#seen.has(id);
    if (joined && this.#seen.size >= 1000) return;
    this.#seen.set(id, { name, at: Date.now() });
    if (joined) void this.realtime.publish(presenceChannel);
  }
  /** Most recently active first, at most 50 names. */
  online(): { count: number; names: string[] } {
    const entries = [...this.#seen.values()].sort((a, b) => b.at - a.at);
    return {
      count: entries.length,
      names: entries.slice(0, 50).map((entry) => entry.name),
    };
  }
}

/**
 * Optional simulated traffic: one order every DASHBOARD_TICK_MS (default
 * 5000, `0` disables it, as the browser tests do).
 */
@Injectable()
export class OrderSimulator implements OnModuleInit, OnModuleDestroy {
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    @Inject(MetricsStore) private readonly metrics: MetricsStore,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}
  onModuleInit(): void {
    const interval = Number(process.env['DASHBOARD_TICK_MS'] ?? 5000);
    if (!Number.isSafeInteger(interval) || interval <= 0) return;
    this.#timer = setInterval(
      () => {
        this.metrics.record('Simulator');
        void this.realtime.publish(metricsChannel);
      },
      Math.max(interval, 1000),
    );
    this.#timer.unref();
  }
  onModuleDestroy(): void {
    clearInterval(this.#timer);
  }
}

@Module({
  providers: [
    MetricsStore,
    IncidentLog,
    PresenceRegistry,
    OrderSimulator,
    { provide: REPORT_JOBS, useValue: reportJobs },
  ],
  exports: [MetricsStore, IncidentLog, PresenceRegistry, REPORT_JOBS],
})
export class DashboardDataModule {}

const incidentTitle = (value: unknown) =>
  typeof value === 'string' && value.length <= 80;

@LiveComponent({ name: 'dashboard', view: 'dashboard' })
export class Dashboard {
  constructor(
    @Inject(MetricsStore) private readonly metrics: MetricsStore,
    @Inject(IncidentLog) private readonly incidents: IncidentLog,
    @Inject(PresenceRegistry) private readonly presence: PresenceRegistry,
    @Inject(REPORT_JOBS) private readonly jobs: JobRunner,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(REQUEST) private readonly request: unknown,
  ) {}
  @State({ writable: true, validate: incidentTitle }) incidentDraft = '';
  @State() incidentError = '';
  @State() jobId = '';
  @State() notice = '';

  /**
   * Every dashboard asks for the incidents channel; the realtime signer keeps
   * only the channels the identity is authorized for, so a viewer's token
   * never contains it and a viewer's dashboard never refreshes from it.
   */
  @RealtimeChannels() channels(): string[] {
    return [
      metricsChannel,
      presenceChannel,
      incidentsChannel,
      ...(this.jobId ? [JobRunner.channel(this.jobId)] : []),
    ];
  }
  mount(): void {
    const viewer = viewerOf(this.request);
    this.presence.touch(viewer.id, viewer.name);
  }
  @Computed() get viewer(): { name: string; role: Role; operator: boolean } {
    const viewer = viewerOf(this.request);
    return {
      name: viewer.name,
      role: viewer.role,
      operator: viewer.role === 'operator',
    };
  }
  @Computed() get tiles(): { orders: number; revenue: number; last: string } {
    return {
      orders: this.metrics.orders,
      revenue: this.metrics.revenue,
      last: this.metrics.lastOrderBy,
    };
  }
  @Computed() get online(): { count: number; names: string[] } {
    return this.presence.online();
  }
  /** Rendered only for operators; viewers receive no incident data at all. */
  @Computed() get incidentList(): { id: number; title: string; by: string }[] {
    if (viewerOf(this.request).role !== 'operator') return [];
    return this.incidents.list().map((item) => ({ ...item }));
  }
  /** Owner-only job view, refreshed before every render. */
  @State() job = { status: '', progress: 0 };
  async dehydrate(): Promise<void> {
    const job = this.jobId
      ? await this.jobs.get(
          { binding: viewerOf(this.request).binding },
          this.jobId,
        )
      : undefined;
    this.job = { status: job?.status ?? '', progress: job?.progress ?? 0 };
  }

  /**
   * Presence heartbeat driven by `nv:poll`. Renderless: no new markup and no
   * re-signed realtime token, so the open event stream is not reconnected.
   */
  @Action({ renderless: true }) heartbeat(): void {
    const viewer = viewerOf(this.request);
    this.presence.touch(viewer.id, viewer.name);
  }
  @Action() async recordOrder(): Promise<void> {
    const viewer = viewerOf(this.request);
    const orders = this.metrics.record(viewer.name);
    this.notice = `Order ${orders} recorded.`;
    // Other dashboards refresh through their own authorized $sync request.
    await this.realtime.publish(metricsChannel);
  }
  @Action() async raiseIncident(): Promise<void> {
    const viewer = viewerOf(this.request);
    // Defense in depth: the Live policy already refuses this for viewers.
    if (viewer.role !== 'operator')
      throw new ForbiddenException('Operators only');
    const title = this.incidentDraft.trim();
    if (title.length < 3) {
      this.incidentError = 'Describe the incident in at least 3 characters.';
      return;
    }
    this.incidents.add(title, viewer.name);
    this.incidentDraft = '';
    this.incidentError = '';
    this.notice = 'Incident raised.';
    await this.realtime.publish(incidentsChannel);
  }
  @Action() async startReport(): Promise<void> {
    const identity = { binding: viewerOf(this.request).binding };
    this.jobId = (
      await this.jobs.enqueue(identity, 'report', {
        input: { orders: this.metrics.orders },
      })
    ).id;
  }
  @Action() async cancelReport(): Promise<void> {
    if (this.jobId)
      await this.jobs.cancel(
        { binding: viewerOf(this.request).binding },
        this.jobId,
      );
  }
}
