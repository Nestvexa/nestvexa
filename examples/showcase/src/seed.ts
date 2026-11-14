/*
 * Seeded, non-sensitive sample data for the showcase domain: two fictional
 * product teams ("workspaces") managing tasks, goals and member profiles.
 * Shared by the application (first start), `pnpm seed` and `pnpm reset`.
 */

export type Role = 'member' | 'admin';
export const priorities = ['low', 'medium', 'high'] as const;
export type Priority = (typeof priorities)[number];

export interface Workspace {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
}
export interface Account {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly workspace: string;
  readonly role: Role;
}
/** A stored file: enough to stream it again through `UploadsService.download`. */
export interface StoredFile {
  readonly key: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
}
export interface Task {
  readonly id: string;
  readonly workspace: string;
  readonly title: string;
  /** An account id in the same workspace, or `''`. */
  readonly assignee: string;
  readonly priority: Priority;
  /** `YYYY-MM-DD` or `''`. */
  readonly due: string;
  readonly done: boolean;
  readonly attachment?: StoredFile;
}
export interface Goal {
  readonly id: string;
  readonly workspace: string;
  readonly title: string;
  /** Target percentage, 1–100. */
  readonly target: number;
  readonly progress: number;
}
export interface Profile {
  readonly displayName: string;
  readonly jobTitle: string;
  readonly timezone: string;
  readonly digest: 'never' | 'daily' | 'weekly';
  readonly avatar?: StoredFile;
  readonly completedAt: string;
}
export interface ShowcaseState {
  readonly version: 1;
  tasks: Task[];
  goals: Goal[];
  profiles: Record<string, Profile>;
  /** Completed tasks per ISO week, oldest first, per workspace (the chart data). */
  throughput: Record<string, number[]>;
  /**
   * Dashboard counters per workspace when no Redis is configured, so they
   * survive a restart of the single process (absent in older data files).
   */
  metrics?: Record<
    string,
    { deployments: number; created: number; completed: number; last: string }
  >;
  nextId: number;
}

/** Public demonstration password for every seeded account. Never reuse it. */
export const DEMO_PASSWORD = 'showcase-demo-2026';

export const workspaces: readonly Workspace[] = [
  {
    slug: 'harbor',
    name: 'Harbor Studio',
    tagline: 'A design studio shipping a booking app.',
  },
  {
    slug: 'summit',
    name: 'Summit Labs',
    tagline: 'A research team running hardware trials.',
  },
];

export const accounts: readonly Account[] = [
  {
    id: 'u-ada',
    email: 'ada@harbor.test',
    name: 'Ada Park',
    workspace: 'harbor',
    role: 'admin',
  },
  {
    id: 'u-ben',
    email: 'ben@harbor.test',
    name: 'Ben Ortiz',
    workspace: 'harbor',
    role: 'member',
  },
  {
    id: 'u-cleo',
    email: 'cleo@summit.test',
    name: 'Cleo Nakamura',
    workspace: 'summit',
    role: 'admin',
  },
  {
    id: 'u-dev',
    email: 'dev@summit.test',
    name: 'Dev Patel',
    workspace: 'summit',
    role: 'member',
  },
];

export const timezones = [
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Asia/Tokyo',
] as const;

const taskSeed: Readonly<
  Record<
    string,
    readonly (readonly [string, string, Priority, string, boolean])[]
  >
> = {
  harbor: [
    ['Design the booking calendar', 'u-ada', 'high', '2026-11-12', false],
    ['Write onboarding emails', 'u-ben', 'medium', '2026-11-14', false],
    ['Audit colour contrast', 'u-ben', 'high', '2026-11-10', true],
    ['Prepare the client demo', 'u-ada', 'high', '2026-11-20', false],
    ['Export icon set', '', 'low', '', false],
    ['Review payment copy', 'u-ben', 'medium', '2026-11-18', false],
    ['Plan usability sessions', 'u-ada', 'medium', '2026-11-25', false],
  ],
  summit: [
    ['Calibrate the test rig', 'u-dev', 'high', '2026-11-11', false],
    ['Summarise trial results', 'u-cleo', 'medium', '2026-11-16', false],
    ['Order spare sensors', 'u-dev', 'low', '', true],
    ['Draft the safety report', 'u-cleo', 'high', '2026-11-19', false],
  ],
};

const goalSeed: Readonly<
  Record<string, readonly (readonly [string, number, number])[]>
> = {
  harbor: [
    ['Launch the booking beta', 100, 60],
    ['Reach AA contrast on every screen', 100, 85],
  ],
  summit: [['Complete three hardware trials', 100, 33]],
};

/** A fresh copy of the seed state (deterministic: no clock, no randomness). */
export function seedState(): ShowcaseState {
  let next = 1;
  const id = (prefix: string) => `${prefix}${(next++).toString(36)}`;
  const tasks: Task[] = Object.entries(taskSeed).flatMap(([workspace, rows]) =>
    rows.map(([title, assignee, priority, due, done]) => ({
      id: id('t'),
      workspace,
      title,
      assignee,
      priority,
      due,
      done,
    })),
  );
  const goals: Goal[] = Object.entries(goalSeed).flatMap(([workspace, rows]) =>
    rows.map(([title, target, progress]) => ({
      id: id('g'),
      workspace,
      title,
      target,
      progress,
    })),
  );
  return {
    version: 1,
    tasks,
    goals,
    profiles: {},
    throughput: {
      harbor: [3, 5, 4, 7, 6, 8, 5, 9],
      summit: [1, 2, 2, 3, 1, 4, 3, 2],
    },
    nextId: next,
  };
}
