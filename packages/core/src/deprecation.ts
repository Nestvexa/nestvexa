import { NestvexaError } from './errors.js';

/**
 * Stable deprecation codes of the Nestvexa packages (MAINT-017). A code is
 * never reused for a different API, and the table only grows; the removed
 * API's row stays with its removal version. Documented in
 * docs/release/versioning-and-deprecation.md.
 */
export const NESTVEXA_DEPRECATIONS = Object.freeze({
  NVDEP001:
    'definePlugin() is deprecated; define an extension with defineExtension(), or convert an existing plugin with pluginExtension(plugin).',
  NVDEP002:
    'PluginRegistry is deprecated; pass pluginExtension(plugin) (or registry.extensions()) to CoreModule.forRoot(options, { extensions }).',
} as const);
export type NestvexaDeprecationCode = keyof typeof NESTVEXA_DEPRECATIONS;

/** `NVDEP001` style for Nestvexa; extensions use their own prefix, for example `ACMEDEP001`. */
const codePattern = /^[A-Z][A-Z0-9]{0,15}DEP\d{3}$/;
const emitted = new Set<string>();

/**
 * Emit a `DeprecationWarning` once per code per process through
 * `process.emitWarning`, so Node's own switches apply: `--no-deprecation`
 * silences it, `--trace-deprecation` adds a stack trace and
 * `--throw-deprecation` turns it into an exception. Call it where detection
 * is cheap and certain (a deprecated function or constructor), never per
 * request. Returns whether a warning was emitted by this call.
 */
export function emitDeprecation(code: string, message: string): boolean {
  if (!codePattern.test(code))
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'Deprecation codes look like NVDEP001: an uppercase prefix, DEP and three digits',
    );
  if (typeof message !== 'string' || !message.trim())
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'A deprecation warning needs a message naming the replacement',
    );
  if (emitted.has(code)) return false;
  emitted.add(code);
  // `--no-deprecation` sets process.noDeprecation; Node then drops the
  // warning itself. Checked here only to report the result truthfully.
  if (process.noDeprecation === true) return false;
  process.emitWarning(message, { type: 'DeprecationWarning', code });
  return true;
}

/** Emit one of the framework's own deprecations ({@link NESTVEXA_DEPRECATIONS}). */
export function deprecated(code: NestvexaDeprecationCode): boolean {
  return emitDeprecation(code, NESTVEXA_DEPRECATIONS[code]);
}
