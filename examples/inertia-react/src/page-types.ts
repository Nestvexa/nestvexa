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
