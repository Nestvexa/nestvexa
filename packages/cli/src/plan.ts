import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
export interface FileChange {
  /** Project-relative path with forward slashes. */
  readonly path: string;
  readonly kind: 'create' | 'update' | 'delete';
  readonly content?: string;
  /** Recorded in the manifest so `remove` can detect user edits. */
  readonly generated?: boolean;
}
interface Manifest {
  readonly version: 1;
  readonly files: Record<
    string,
    { readonly sha256: string; readonly feature: string }
  >;
}
const manifestPath = '.nestvexa/manifest.json';
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Resolve a project-relative path, refusing anything outside the project root. */
export function projectPath(root: string, path: string): string {
  if (isAbsolute(path) || path.includes('\0'))
    throw new CliError(`Refusing an absolute or invalid path: ${path}`);
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (!local || local.startsWith('..') || isAbsolute(local))
    throw new CliError(`Refusing to write outside the project: ${path}`);
  return absolute;
}

/**
 * Collects file changes, then applies them atomically: every touched file is backed
 * up first and restored if any write fails. Dry runs only describe the plan.
 */
export class ChangePlan {
  readonly #changes = new Map<string, FileChange>();
  constructor(
    readonly root: string,
    readonly feature: string,
  ) {}
  get changes(): readonly FileChange[] {
    return [...this.#changes.values()];
  }
  read(path: string): string | undefined {
    const pending = this.#changes.get(path);
    if (pending) return pending.kind === 'delete' ? undefined : pending.content;
    const absolute = projectPath(this.root, path);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
  }
  exists(path: string): boolean {
    return this.read(path) !== undefined;
  }
  /** Create a generated file; an existing different file is a conflict unless `force`. */
  create(
    path: string,
    content: string,
    options: { force?: boolean } = {},
  ): void {
    const current = this.read(path);
    if (current === content) return;
    if (current !== undefined && !options.force)
      throw new CliError(
        `${path} already exists. Re-run with --force to overwrite, or remove it first.`,
      );
    this.#changes.set(path, {
      path,
      kind: current === undefined ? 'create' : 'update',
      content,
      generated: true,
    });
  }
  /** Update an existing user file (not recorded as generated). */
  update(path: string, content: string): void {
    const current = this.read(path);
    if (current === undefined) throw new CliError(`${path} does not exist`);
    if (current === content) return;
    this.#changes.set(path, { path, kind: 'update', content });
  }
  delete(path: string): void {
    if (this.read(path) === undefined) return;
    this.#changes.set(path, { path, kind: 'delete' });
  }
  describe(): string[] {
    return this.changes.map(
      (change) => `${change.kind.padEnd(6)} ${change.path}`,
    );
  }
  apply(): void {
    if (!this.#changes.size) return;
    const manifest = readManifest(this.root);
    const backups: { absolute: string; backup?: string }[] = [];
    try {
      for (const change of this.#changes.values()) {
        const absolute = projectPath(this.root, change.path);
        const entry: { absolute: string; backup?: string } = { absolute };
        if (existsSync(absolute)) {
          entry.backup = `${absolute}.nestvexa-backup`;
          writeFileSync(entry.backup, readFileSync(absolute));
        }
        backups.push(entry);
        if (change.kind === 'delete') {
          rmSync(absolute, { force: true });
          delete manifest.files[change.path];
          continue;
        }
        mkdirSync(dirname(absolute), { recursive: true });
        const temporary = `${absolute}.nestvexa-tmp`;
        writeFileSync(temporary, change.content ?? '');
        renameSync(temporary, absolute);
        if (change.generated)
          manifest.files[change.path] = {
            sha256: sha256(change.content ?? ''),
            feature: this.feature,
          };
      }
      writeManifest(this.root, manifest);
    } catch (error) {
      // Roll back everything written so far, newest first.
      for (const { absolute, backup } of backups.reverse()) {
        if (backup) writeFileSync(absolute, readFileSync(backup));
        else removeIfPresent(absolute);
      }
      throw new CliError(
        `Changes were rolled back: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      for (const { backup } of backups)
        if (backup) rmSync(backup, { force: true });
    }
  }
}
/**
 * Remove a path that may never have been written. A parent segment that is a
 * file yields ENOTDIR on POSIX (ENOENT on Windows); both mean "not present".
 */
function removeIfPresent(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    const code: unknown =
      error instanceof Error ? Reflect.get(error, 'code') : undefined;
    if (code !== 'ENOTDIR' && code !== 'ENOENT') throw error;
  }
}
function readManifest(root: string): {
  version: 1;
  files: Manifest['files'] & Record<string, Manifest['files'][string]>;
} {
  const absolute = projectPath(root, manifestPath);
  if (!existsSync(absolute)) return { version: 1, files: {} };
  const parsed: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
  const files: unknown =
    parsed && typeof parsed === 'object'
      ? Reflect.get(parsed, 'files')
      : undefined;
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new CliError(`${manifestPath} is invalid`);
  return { version: 1, files: { ...(files as Manifest['files']) } };
}
function writeManifest(root: string, manifest: Manifest): void {
  const absolute = projectPath(root, manifestPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(manifest, null, 2) + '\n');
}
/** Generated files of a feature that are still byte-identical to what was generated. */
export function untouchedGenerated(
  root: string,
  feature: string,
): { readonly unchanged: string[]; readonly modified: string[] } {
  const manifest = readManifest(root);
  const unchanged: string[] = [];
  const modified: string[] = [];
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.feature !== feature) continue;
    const absolute = projectPath(root, path);
    if (!existsSync(absolute)) continue;
    if (sha256(readFileSync(absolute, 'utf8')) === entry.sha256)
      unchanged.push(path);
    else modified.push(path);
  }
  return { unchanged, modified };
}
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}
