import type { ApiEntry } from './api-reference.mjs';

export interface CheckedBlock {
  /** Repository-relative Markdown file. */
  readonly source: string;
  /** Zero-based position among the file's checked blocks. */
  readonly index: number;
  readonly code: string;
}

export const checkableLanguages: ReadonlySet<string>;
export function isCheckedFence(info: string | undefined): boolean;
export function checkTypeScriptBlocks(
  root: string,
  blocks: readonly CheckedBlock[],
  entries: readonly ApiEntry[],
): { readonly source: string; readonly message: string }[];
