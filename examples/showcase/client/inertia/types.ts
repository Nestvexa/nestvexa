/** Props shared by every Inertia page (see `share` in src/main.ts). */
export interface SharedProps {
  readonly appName: string;
  readonly userName: string;
  readonly role: 'member' | 'admin';
  readonly workspace: string;
  [key: string]: unknown;
}

export interface AnalyticsProps {
  readonly heading: string;
  readonly summary: {
    readonly open: number;
    readonly done: number;
    readonly members: number;
  };
  /** Deferred: loaded after the first render. */
  readonly throughput?: {
    readonly labels: string[];
    readonly values: number[];
  };
  /** Optional: only sent on a partial reload that asks for it. */
  readonly breakdown?: readonly {
    readonly name: string;
    readonly open: number;
  }[];
}

export interface Goal {
  readonly id: string;
  readonly title: string;
  readonly target: number;
  readonly progress: number;
}
export interface GoalsProps {
  readonly canCreate: boolean;
  readonly goals: readonly Goal[];
}
