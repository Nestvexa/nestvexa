import { NestvexaError } from './errors.js';

/**
 * The running framework version, compared with an extension's `nestvexa`
 * range at startup. Kept equal to the published package version by a test.
 */
export const NESTVEXA_VERSION = '0.1.0-alpha.0';

const semverPattern =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}
function version(value: string): Version | undefined {
  const match = semverPattern.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}
function compare(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const)
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  // A prerelease sorts before its release (semver 11).
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return b.prerelease.length - a.prerelease.length;
  for (
    let index = 0;
    index < Math.max(a.prerelease.length, b.prerelease.length);
    index++
  ) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const numeric = /^\d+$/.test(left) && /^\d+$/.test(right);
    if (numeric) return Number(left) < Number(right) ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}
type Comparator = (candidate: Version) => boolean;
function comparator(token: string): Comparator[] {
  const operator = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  const base = operator?.[2] ? version(operator[2]) : undefined;
  if (!operator || !base)
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version range');
  const op = operator[1] ?? '=';
  const at = (major: number, minor: number, patch: number): Version => ({
    major,
    minor,
    patch,
    prerelease: ['0'],
  });
  const gte: Comparator = (v) => compare(v, base) >= 0;
  switch (op) {
    case '^': {
      const upper =
        base.major > 0
          ? at(base.major + 1, 0, 0)
          : base.minor > 0
            ? at(0, base.minor + 1, 0)
            : at(0, 0, base.patch + 1);
      return [gte, (v) => compare(v, upper) < 0];
    }
    case '~': {
      const upper = at(base.major, base.minor + 1, 0);
      return [gte, (v) => compare(v, upper) < 0];
    }
    case '>=':
      return [gte];
    case '>':
      return [(v) => compare(v, base) > 0];
    case '<=':
      return [(v) => compare(v, base) <= 0];
    case '<':
      return [(v) => compare(v, base) < 0];
    default:
      return [(v) => compare(v, base) === 0];
  }
}
/**
 * Whether `candidate` satisfies `range` (`||` alternatives of space-separated
 * comparators: `=`, `>`, `>=`, `<`, `<=`, `^`, `~`). Prereleases are compared
 * by semver precedence, so `^0.1.0-alpha.0` accepts `0.1.0-alpha.3`.
 */
export function satisfiesVersion(candidate: string, range: string): boolean {
  const parsed = version(candidate);
  if (!parsed)
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version');
  if (typeof range !== 'string' || range.length === 0 || range.length > 256)
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version range');
  // Parse every alternative first so a malformed tail is never skipped.
  const alternatives = range.split('||').map((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
      throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version range');
    return tokens.flatMap(comparator);
  });
  return alternatives.some((tests) => tests.every((test) => test(parsed)));
}

/** Whether `value` is a semantic version (`1.2.3` or `1.2.3-alpha.0`). */
export function isSemanticVersion(value: unknown): value is string {
  return typeof value === 'string' && version(value) !== undefined;
}
/** Throws `INVALID_CONFIGURATION` unless `range` parses as a version range. */
export function assertVersionRange(range: unknown): asserts range is string {
  if (typeof range !== 'string')
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version range');
  satisfiesVersion('0.0.0', range);
}
