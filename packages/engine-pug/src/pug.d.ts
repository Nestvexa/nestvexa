/**
 * Minimal declarations for the Pug 3 surface this adapter uses (`compileClient`
 * with plugins and the runtime helpers). `@types/pug` omits the plugin API, so
 * the adapter declares only the verified runtime contract it depends on. This
 * file is compile-time only and is not referenced by the published declarations.
 */
declare module 'pug' {
  export interface PugToken {
    readonly type: string;
    readonly val?: unknown;
  }
  export interface PugPlugin {
    resolve?(filename: string, source: string, options: object): string;
    read?(filename: string, options: object): string;
    postLex?(tokens: PugToken[], options: object): PugToken[];
  }
  export type PugFilter = (
    text: string,
    options: Readonly<Record<string, unknown>>,
  ) => string;
  export interface PugClientOptions {
    readonly filename: string;
    readonly basedir: string;
    readonly compileDebug: boolean;
    readonly inlineRuntimeFunctions: false;
    readonly name: 'template';
    readonly self: false;
    readonly pretty: false;
    readonly doctype?: string;
    readonly filters: Readonly<Record<string, PugFilter>>;
    readonly plugins: readonly PugPlugin[];
  }
  interface Pug {
    compileClient(source: string, options: PugClientOptions): string;
    readonly runtime: Readonly<Record<string, unknown>>;
  }
  const pug: Pug;
  export default pug;
}
