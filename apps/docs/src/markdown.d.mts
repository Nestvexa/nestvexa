export interface Heading {
  readonly depth: number;
  readonly text: string;
  readonly id: string;
}

export interface Snippet {
  readonly source: string;
  readonly code: string | undefined;
}

export interface Analysis {
  readonly headings: readonly Heading[];
  readonly links: readonly { readonly href: string; readonly text: string }[];
  readonly anchors: ReadonlySet<string>;
  readonly snippets: readonly Snippet[];
}

export function slug(text: string): string;
export function createSlugger(): (text: string) => string;
export function analyse(markdown: string): Analysis;
export function escapeHtml(value: string): string;
export function render(
  markdown: string,
  resolveHref: (href: string) => string,
): string;
