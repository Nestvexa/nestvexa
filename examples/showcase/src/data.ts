import { BadRequestException, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from './config.js';
import { seedState } from './seed.js';
import type { Goal, Profile, ShowcaseState, Task } from './seed.js';

export const dataFile = join(dataDirectory, 'showcase.json');

/** Reads the data file written by `pnpm seed` or a previous run; seeds when missing. */
export function loadState(file = dataFile): ShowcaseState {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return seedState();
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Reflect.get(parsed, 'version') !== 1 ||
    !Array.isArray(Reflect.get(parsed, 'tasks')) ||
    !Array.isArray(Reflect.get(parsed, 'goals'))
  )
    throw new Error(`${file} is not a showcase data file; run pnpm reset`);
  return parsed as ShowcaseState;
}

/** Atomic write: a crash mid-write never leaves a truncated data file. */
export function writeState(state: ShowcaseState, file = dataFile): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * The application's repository: tasks, goals and profiles, always filtered
 * by the workspace (or user) the caller resolved from the server session.
 * Persisted to one JSON file per data directory; this is a demonstration
 * store, not a database (one writer process per data directory).
 */
@Injectable()
export class ShowcaseData implements OnApplicationShutdown {
  readonly #state = loadState();
  #timer: ReturnType<typeof setTimeout> | undefined;

  tasks(workspace: string): readonly Task[] {
    return this.#state.tasks.filter((task) => task.workspace === workspace);
  }
  task(workspace: string, id: string): Task | undefined {
    return this.#state.tasks.find(
      (task) => task.workspace === workspace && task.id === id,
    );
  }
  addTask(
    workspace: string,
    input: Omit<Task, 'id' | 'workspace' | 'done'>,
  ): Task {
    if (this.tasks(workspace).length >= 200)
      throw new BadRequestException('Task limit reached');
    const task: Task = { ...input, id: this.#id('t'), workspace, done: false };
    this.#state.tasks.push(task);
    this.#changed();
    return task;
  }
  updateTask(
    workspace: string,
    id: string,
    change: Partial<Omit<Task, 'id' | 'workspace'>>,
  ): Task {
    const index = this.#state.tasks.findIndex(
      (task) => task.workspace === workspace && task.id === id,
    );
    const current = this.#state.tasks[index];
    if (!current) throw new BadRequestException('Unknown task');
    const next: Task = { ...current, ...change };
    this.#state.tasks[index] = next;
    this.#changed();
    return next;
  }
  removeTask(workspace: string, id: string): Task | undefined {
    const current = this.task(workspace, id);
    if (!current) return undefined;
    this.#state.tasks = this.#state.tasks.filter((task) => task !== current);
    this.#changed();
    return current;
  }

  goals(workspace: string): readonly Goal[] {
    return this.#state.goals.filter((goal) => goal.workspace === workspace);
  }
  addGoal(workspace: string, title: string, target: number): Goal {
    if (this.goals(workspace).length >= 20)
      throw new BadRequestException('Goal limit reached');
    const goal: Goal = {
      id: this.#id('g'),
      workspace,
      title,
      target,
      progress: 0,
    };
    this.#state.goals.push(goal);
    this.#changed();
    return goal;
  }

  profile(userId: string): Profile | undefined {
    return Object.hasOwn(this.#state.profiles, userId)
      ? this.#state.profiles[userId]
      : undefined;
  }
  saveProfile(userId: string, profile: Profile): void {
    this.#state.profiles[userId] = profile;
    this.#changed();
  }

  /** Weekly completed-task counts, oldest first (the chart series). */
  throughput(workspace: string): readonly number[] {
    return this.#state.throughput[workspace] ?? [];
  }
  /** Completing a task counts towards the current (last) week. */
  recordCompletion(workspace: string, delta: 1 | -1): void {
    const series = [...(this.#state.throughput[workspace] ?? [0])];
    const last = series.length - 1;
    series[last] = Math.max(0, (series[last] ?? 0) + delta);
    this.#state.throughput[workspace] = series;
    this.#changed();
  }

  #id(prefix: string): string {
    return `${prefix}${(this.#state.nextId++).toString(36)}`;
  }
  /** Coalesces writes; the file is rewritten at most every 100 ms. */
  #changed(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      writeState(this.#state);
    }, 100);
  }
  onApplicationShutdown(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    writeState(this.#state);
  }
}
