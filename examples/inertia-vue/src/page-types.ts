// Page props shared by the Nest controllers (src/main.ts) and the Vue pages
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

/** Pages of the client-feature smoke tour (src/features.ts). */
export interface FeaturePages {
  readonly 'Features/Index': { readonly tick: number; readonly below?: string };
  readonly 'Features/Prefetched': { readonly renders: number };
  readonly 'Features/Scroll': {
    readonly items: {
      readonly data: readonly { readonly id: number; readonly label: string }[];
    };
  };
}
