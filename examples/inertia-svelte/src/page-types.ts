// Page props shared by the Nest controllers (src/main.ts) and the Svelte pages
// (client/pages). Type-only and dependency-free: nothing here reaches either
// runtime bundle.

export interface User {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

/** Shared props every page receives (see `share` in src/main.ts). */
export type SharedProps = {
  readonly appName: string;
  readonly framework: string;
  readonly errors: Readonly<Record<string, string>>;
};

export interface HomeProps {
  readonly greeting: string;
  readonly visits: number;
  readonly renderedBy: string;
  readonly stats?: { readonly users: number };
  readonly extra?: string;
}

export interface UsersIndexProps {
  readonly users: readonly User[];
}

export interface UsersShowProps {
  readonly user: User;
}

export interface Todo {
  readonly id: number;
  readonly title: string;
  /** Set only on the optimistic copy shown before the server answers. */
  readonly pending?: boolean;
}

export interface BrokenProps {
  readonly reason: string;
}

export interface AppPages {
  readonly Home: HomeProps;
  readonly 'Users/Index': UsersIndexProps;
  readonly 'Users/Show': UsersShowProps;
  readonly 'Users/Create': Readonly<Record<string, never>>;
  readonly Broken: BrokenProps;
}

/**
 * Output of the `notes.add` server action (src/actions.ts). Mutable like the
 * generated action types, so the page prop is the binding's initial data as is.
 */
export interface NoteBoard {
  total: number;
  latest: string[];
}

/** Pages of the client-feature smoke and tour (src/features.ts). */
export interface FeaturePages {
  readonly 'Features/Index': { readonly tick: number; readonly below?: string };
  readonly 'Features/Prefetched': { readonly renders: number };
  readonly 'Features/Scroll': {
    readonly items: {
      readonly data: readonly { readonly id: number; readonly label: string }[];
    };
  };
  readonly 'Features/Tour': { readonly title: string };
  readonly 'Features/Target': { readonly from: string };
  readonly 'Features/Slow': { readonly loaded?: string };
  readonly 'Features/Remember': Readonly<Record<string, never>>;
  readonly 'Features/Once': {
    readonly step: 'a' | 'b';
    readonly plans: {
      readonly token: string;
      readonly names: readonly string[];
    };
  };
  readonly 'Features/Todos': { readonly todos: readonly Todo[] };
  readonly 'Features/Long': { readonly page: number; readonly next: number };
  readonly 'Features/Actions': { readonly board: NoteBoard };
}
