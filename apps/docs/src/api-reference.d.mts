export interface ApiEntry {
  readonly packageDir: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly subpath: string;
  readonly specifier: string;
  readonly file: string;
}

export interface ApiSymbol {
  readonly name: string;
  readonly kind: string;
  readonly summary: string;
  readonly deprecated: boolean;
  readonly tags: readonly { readonly name: string; readonly text: string }[];
  readonly reexportedFrom: string | undefined;
  readonly signatures: readonly string[];
}

export interface ApiPackage {
  readonly packageDir: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly subpaths: readonly {
    readonly subpath: string;
    readonly specifier: string;
    readonly symbols: readonly ApiSymbol[];
  }[];
}

export function collectEntries(
  root: string,
): Promise<{ entries: ApiEntry[]; missing: string[] }>;
export function extractApi(
  root: string,
  entries: readonly ApiEntry[],
): ApiPackage[];
