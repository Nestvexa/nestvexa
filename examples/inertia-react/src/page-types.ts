// Page props shared by the Nest controllers (src/main.ts) and the React pages
// (client/pages). Type-only and dependency-free: nothing here reaches either
// runtime bundle.

export interface User {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

export interface Upload {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/** Shared props every page receives (see `share` in src/main.ts). */
export type SharedProps = {
  readonly appName: string;
  readonly framework: string;
  readonly errors: Readonly<Record<string, string>>;
};

export interface AppPages {
  readonly Home: {
    readonly greeting: string;
    readonly visits: number;
    readonly renderedBy: string;
    readonly stats?: { readonly users: number };
    readonly extra?: string;
  };
  readonly 'Users/Index': { readonly users: readonly User[] };
  readonly 'Users/Show': { readonly user: User };
  readonly 'Users/Create': Readonly<Record<string, never>>;
  readonly 'Files/Upload': { readonly uploads: readonly Upload[] };
  readonly Broken: { readonly reason: string };
}

export interface Todo {
  readonly id: number;
  readonly title: string;
  /** Set only on the optimistic copy shown before the server answers. */
  readonly pending?: boolean;
}

export interface LargeRow {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly note: string;
}

/** Pages of the client-feature tour (src/features.ts, client/pages/Features). */
export interface FeaturePages {
  readonly 'Features/Index': { readonly title: string };
  readonly 'Features/Prefetched': { readonly renders: number };
  readonly 'Features/Target': { readonly from: string };
  readonly 'Features/Slow': { readonly loaded?: string };
  readonly 'Features/Poll': { readonly tick: number };
  readonly 'Features/Scroll': {
    readonly items: {
      readonly data: readonly { readonly id: number; readonly label: string }[];
    };
    readonly notes: readonly { readonly id: number; readonly text: string }[];
  };
  readonly 'Features/Lazy': { readonly below?: string };
  readonly 'Features/Remember': Readonly<Record<string, never>>;
  readonly 'Features/Once': {
    readonly step: 'a' | 'b';
    readonly plans: {
      readonly token: string;
      readonly names: readonly string[];
    };
  };
  readonly 'Features/Secret': { readonly secret: string };
  readonly 'Features/Todos': { readonly todos: readonly Todo[] };
  readonly 'Features/Signup': Readonly<Record<string, never>>;
  readonly 'Features/Large': { readonly rows: readonly LargeRow[] };
}
