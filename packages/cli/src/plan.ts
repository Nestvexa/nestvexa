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
  /** Template id and version that produced a generated file. */
  readonly template?: { readonly id: string; readonly version: number };
}
export interface ManifestFile {
  readonly sha256: string;
  readonly feature: string;
  readonly template?: string;
  readonly templateVersion?: number;
}
export interface MigrationRecord {
  readonly id: string;
  readonly appliedAt: string;
  readonly cli: string;
}
/**
 * `.nestvexa/manifest.json`. Version 1 (first alpha CLI) only had `files`;
 * version 2 adds template metadata and the applied migration log. A v1
 * manifest stays v1 on disk until `nestvexa migrate` upgrades it.
 */
export interface Manifest {
  version: 1 | 2;
  cli?: string;
  files: Record<string, ManifestFile>;
  migrations: MigrationRecord[];
}
export const manifestPath = '.nestvexa/manifest.json';
export const manifestVersion = 2;
export function sha256(text: string): string {
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
  readonly #manifestEdits: ((manifest: Manifest) => void)[] = [];
  constructor(
    readonly root: string,
    readonly feature: string,
    readonly cliVersion = '',
  ) {}
  get changes(): readonly FileChange[] {
    return [...this.#changes.values()];
  }
  /** True when applying the plan would write anything (files or manifest edits). */
  get empty(): boolean {
    return !this.#changes.size && !this.#manifestEdits.length;
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
    options: {
      force?: boolean;
      template?: { readonly id: string; readonly version: number };
    } = {},
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
      ...(options.template ? { template: options.template } : {}),
    });
  }
  /** Create a generated file only when it does not exist yet (shared scaffolding). */
  ensure(
    path: string,
    content: string,
    options: {
      template?: { readonly id: string; readonly version: number };
    } = {},
  ): boolean {
    if (this.exists(path)) return false;
    this.create(path, content, options);
    return true;
  }
  /** Update an existing user file (not recorded as generated). */
  update(path: string, content: string): void {
    const current = this.read(path);
    if (current === undefined) throw new CliError(`${path} does not exist`);
    if (current === content) return;
    const pending = this.#changes.get(path);
    // A file created earlier in this plan stays a generated creation.
    if (pending && pending.kind !== 'delete') {
      const { template } = pending;
      this.#changes.set(path, {
        path,
        kind: pending.kind,
        content,
        ...(pending.generated ? { generated: true } : {}),
        ...(template ? { template } : {}),
      });
      return;
    }
    this.#changes.set(path, { path, kind: 'update', content });
  }
  delete(path: string): void {
    if (this.read(path) === undefined) return;
    this.#changes.set(path, { path, kind: 'delete' });
  }
  /** Queue a manifest transformation applied in the same atomic write. */
  editManifest(edit: (manifest: Manifest) => void): void {
    this.#manifestEdits.push(edit);
  }
  describe(): string[] {
    return this.changes.map(
      (change) => `${change.kind.padEnd(6)} ${change.path}`,
    );
  }
  apply(): void {
    if (this.empty) return;
    const manifest = readManifest(this.root);
    const before = existsSync(projectPath(this.root, manifestPath))
      ? readFileSync(projectPath(this.root, manifestPath))
      : undefined;
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
        replaceFile(absolute, change.content ?? '');
        if (change.generated)
          manifest.files[change.path] = {
            sha256: sha256(change.content ?? ''),
            feature: this.feature,
            ...(change.template
              ? {
                  template: change.template.id,
                  templateVersion: change.template.version,
                }
              : {}),
          };
      }
      for (const edit of this.#manifestEdits) edit(manifest);
      if (this.cliVersion && manifest.version === manifestVersion)
        manifest.cli = this.cliVersion;
      writeManifest(this.root, manifest);
    } catch (error) {
      // Roll back everything written so far, newest first.
      for (const { absolute, backup } of backups.reverse()) {
        if (backup) writeFileSync(absolute, readFileSync(backup));
        else removeIfPresent(absolute);
      }
      const manifestFile = projectPath(this.root, manifestPath);
      if (before) writeFileSync(manifestFile, before);
      else removeIfPresent(manifestFile);
      throw new CliError(
        `Changes were rolled back: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      for (const { backup } of backups)
        if (backup) rmSync(backup, { force: true });
    }
  }
}
function errorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}
function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
/**
 * Write through a temporary file and rename it into place. On Windows a rename
 * onto a file another process (indexer, antivirus, editor) briefly holds open
 * fails with EPERM/EACCES/EBUSY: retry with backoff, then fall back to an
 * in-place write. Plan-level rollback still covers every outcome.
 */
function replaceFile(absolute: string, content: string): void {
  const temporary = `${absolute}.nestvexa-tmp`;
  writeFileSync(temporary, content);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temporary, absolute);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
        rmSync(temporary, { force: true });
        throw error;
      }
      if (attempt >= 8) break;
      pause(25 * attempt);
    }
  }
  rmSync(temporary, { force: true });
  writeFileSync(absolute, content);
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
function fileEntry(value: unknown): ManifestFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const hash: unknown = Reflect.get(value, 'sha256');
  const feature: unknown = Reflect.get(value, 'feature');
  if (typeof hash !== 'string' || typeof feature !== 'string') return undefined;
  const template: unknown = Reflect.get(value, 'template');
  const templateVersion: unknown = Reflect.get(value, 'templateVersion');
  return {
    sha256: hash,
    feature,
    ...(typeof template === 'string' ? { template } : {}),
    ...(typeof templateVersion === 'number' ? { templateVersion } : {}),
  };
}
/** Read and validate the manifest; a missing manifest is a fresh current-version one. */
export function readManifest(root: string): Manifest {
  const absolute = projectPath(root, manifestPath);
  if (!existsSync(absolute))
    return { version: manifestVersion, files: {}, migrations: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    throw new CliError(`${manifestPath} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new CliError(`${manifestPath} is invalid`);
  const version: unknown = Reflect.get(parsed, 'version');
  if (version !== 1 && version !== 2)
    throw new CliError(
      `${manifestPath} has unsupported version ${String(version)}; upgrade @nestvexa/cli`,
    );
  const files: unknown = Reflect.get(parsed, 'files');
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new CliError(`${manifestPath} is invalid`);
  const entries: Record<string, ManifestFile> = {};
  for (const [path, value] of Object.entries(files)) {
    const entry = fileEntry(value);
    if (!entry) throw new CliError(`${manifestPath} has an invalid entry`);
    entries[path] = entry;
  }
  const migrations: MigrationRecord[] = [];
  const log: unknown = Reflect.get(parsed, 'migrations');
  if (Array.isArray(log))
    for (const item of log as unknown[]) {
      const id: unknown =
        item && typeof item === 'object' ? Reflect.get(item, 'id') : undefined;
      const appliedAt: unknown =
        item && typeof item === 'object'
          ? Reflect.get(item, 'appliedAt')
          : undefined;
      const cli: unknown =
        item && typeof item === 'object' ? Reflect.get(item, 'cli') : undefined;
      if (typeof id === 'string' && typeof appliedAt === 'string')
        migrations.push({
          id,
          appliedAt,
          cli: typeof cli === 'string' ? cli : '',
        });
    }
  const cli: unknown = Reflect.get(parsed, 'cli');
  return {
    version,
    ...(typeof cli === 'string' ? { cli } : {}),
    files: entries,
    migrations,
  };
}
function writeManifest(root: string, manifest: Manifest): void {
  const absolute = projectPath(root, manifestPath);
  mkdirSync(dirname(absolute), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  // Version 1 keeps its original shape so older CLIs can still read it.
  const body =
    manifest.version === 1
      ? {
          version: 1,
          files: Object.fromEntries(
            Object.entries(sorted).map(([path, entry]) => [
              path,
              { sha256: entry.sha256, feature: entry.feature },
            ]),
          ),
        }
      : {
          version: manifest.version,
          ...(manifest.cli ? { cli: manifest.cli } : {}),
          files: sorted,
          migrations: manifest.migrations,
        };
  writeFileSync(absolute, JSON.stringify(body, null, 2) + '\n');
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
/** True when a generated file is still exactly what the CLI wrote. */
export function isUnmodifiedGenerated(root: string, path: string): boolean {
  const entry = readManifest(root).files[path];
  const absolute = projectPath(root, path);
  return (
    entry !== undefined &&
    existsSync(absolute) &&
    sha256(readFileSync(absolute, 'utf8')) === entry.sha256
  );
}
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}
