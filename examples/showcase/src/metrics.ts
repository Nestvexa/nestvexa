import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { RealtimeService } from '@nestvexa/realtime';
import { RespConnection } from '@nestvexa/realtime-redis';
import {
  Action,
  Computed,
  LiveComponent,
  RealtimeChannels,
  State,
} from 'nestvexa';
import { instance, redis } from './config.js';
import {
  Directory,
  bindingOf,
  metricsChannel,
  notificationsChannel,
} from './identity.js';

export const metricNames = ['deployments', 'created', 'completed'] as const;
export type MetricName = (typeof metricNames)[number];
export interface Metrics {
  readonly deployments: number;
  readonly created: number;
  readonly completed: number;
  /** Human-readable latest event, or `''`. */
  readonly last: string;
}
export interface InboxItem {
  readonly id: string;
  readonly text: string;
  readonly at: string;
}

/**
 * Workspace metrics and per-user notification inboxes. In a single process
 * they live in memory; with `REDIS_PORT` they live in Redis (hash and capped
 * list per key), so every instance renders the same numbers when a realtime
 * event tells its browsers to refresh.
 */
@Injectable()
export class SharedState implements OnApplicationShutdown {
  readonly #redis = redis
    ? new RespConnection({
        host: redis.host,
        port: redis.port,
        ...(redis.password ? { password: redis.password } : {}),
      })
    : undefined;
  readonly #prefix = redis?.prefix ?? '';
  readonly #metrics = new Map<string, Metrics>();
  readonly #inbox = new Map<string, InboxItem[]>();
  #next = 1;

  get distributed(): boolean {
    return this.#redis !== undefined;
  }

  async metrics(workspace: string): Promise<Metrics> {
    if (!this.#redis)
      return (
        this.#metrics.get(workspace) ?? {
          deployments: 0,
          created: 0,
          completed: 0,
          last: '',
        }
      );
    const reply = await this.#redis.command(
      'HGETALL',
      `${this.#prefix}metrics:${workspace}`,
    );
    const fields = new Map<string, string>();
    if (Array.isArray(reply))
      for (let index = 0; index + 1 < reply.length; index += 2) {
        const key = reply[index];
        const value = reply[index + 1];
        if (typeof key === 'string' && typeof value === 'string')
          fields.set(key, value);
      }
    const count = (name: MetricName) => {
      const value = Number(fields.get(name) ?? 0);
      return Number.isSafeInteger(value) ? value : 0;
    };
    return {
      deployments: count('deployments'),
      created: count('created'),
      completed: count('completed'),
      last: fields.get('last') ?? '',
    };
  }

  async increment(
    workspace: string,
    name: MetricName,
    by: number,
    last: string,
  ): Promise<void> {
    if (!this.#redis) {
      const current = await this.metrics(workspace);
      this.#metrics.set(workspace, {
        ...current,
        [name]: Math.max(0, current[name] + by),
        last,
      });
      return;
    }
    const key = `${this.#prefix}metrics:${workspace}`;
    await this.#redis.command('HINCRBY', key, name, String(by));
    await this.#redis.command('HSET', key, 'last', last);
  }

  async inbox(userId: string): Promise<readonly InboxItem[]> {
    if (!this.#redis) return this.#inbox.get(userId) ?? [];
    const reply = await this.#redis.command(
      'LRANGE',
      `${this.#prefix}inbox:${userId}`,
      '0',
      '9',
    );
    if (!Array.isArray(reply)) return [];
    return reply.flatMap((entry) => {
      if (typeof entry !== 'string') return [];
      try {
        const item: unknown = JSON.parse(entry);
        if (
          item &&
          typeof item === 'object' &&
          typeof Reflect.get(item, 'id') === 'string' &&
          typeof Reflect.get(item, 'text') === 'string' &&
          typeof Reflect.get(item, 'at') === 'string'
        )
          return [item as InboxItem];
      } catch {
        // A malformed entry is skipped, never rendered.
      }
      return [];
    });
  }

  async push(userId: string, text: string): Promise<void> {
    const item: InboxItem = {
      id: `${instance}-${process.pid}-${this.#next++}`,
      text: text.slice(0, 200),
      at: new Date().toISOString(),
    };
    if (!this.#redis) {
      this.#inbox.set(
        userId,
        [item, ...(this.#inbox.get(userId) ?? [])].slice(0, 10),
      );
      return;
    }
    const key = `${this.#prefix}inbox:${userId}`;
    await this.#redis.command('LPUSH', key, JSON.stringify(item));
    await this.#redis.command('LTRIM', key, '0', '9');
  }

  async clearInbox(userId: string): Promise<void> {
    if (!this.#redis) this.#inbox.delete(userId);
    else await this.#redis.command('DEL', `${this.#prefix}inbox:${userId}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#redis?.close();
  }
}

/**
 * Dashboard tiles. Any member action, task change or notification publishes
 * an event on the workspace or user channel; subscribed panels (on any
 * instance, through the Redis broker) refresh through their own authorized
 * `$sync` and re-read the shared numbers. Events carry no data.
 */
@LiveComponent({ name: 'metrics-panel', view: 'metrics-panel' })
export class MetricsPanel {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(SharedState) private readonly shared: SharedState,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State() metrics: Metrics = {
    deployments: 0,
    created: 0,
    completed: 0,
    last: '',
  };
  @State() inbox: readonly InboxItem[] = [];
  @State() online: readonly string[] = [];
  @State() notice = '';

  #access() {
    return this.directory.require(this.request);
  }
  @RealtimeChannels() channels(): string[] {
    const access = this.#access();
    return [
      metricsChannel(access.workspace.slug),
      notificationsChannel(access.user.id),
    ];
  }
  @Computed() get renderedBy(): string {
    return instance;
  }
  @Computed() get onlineCount(): number {
    return this.online.length;
  }
  async dehydrate(): Promise<void> {
    const access = this.#access();
    this.metrics = await this.shared.metrics(access.workspace.slug);
    this.inbox = await this.shared.inbox(access.user.id);
    // Presence is per instance by design (connections of this process only).
    const presence = await this.realtime.presence(
      { binding: bindingOf(this.directory, this.request) },
      metricsChannel(access.workspace.slug),
    );
    this.online = presence.members.map((member) => member.label ?? member.id);
  }
  @Action() async logDeployment(): Promise<void> {
    const access = this.#access();
    await this.shared.increment(
      access.workspace.slug,
      'deployments',
      1,
      `${access.user.name} logged a deployment`,
    );
    this.notice = 'Deployment logged.';
    await this.realtime.publish(metricsChannel(access.workspace.slug), null);
  }
  @Action() async clearNotifications(): Promise<void> {
    const access = this.#access();
    await this.shared.clearInbox(access.user.id);
    this.notice = 'Notifications cleared.';
  }
}
