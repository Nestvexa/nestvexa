/**
 * Minimal declarations for the EJS 7 surface this adapter uses. EJS 7 ships no
 * TypeScript declarations and DefinitelyTyped currently describes EJS 3, so the
 * adapter declares only the verified runtime contract it depends on. This file
 * is compile-time only and is not referenced by the published declarations.
 */
declare module 'ejs' {
  export interface EjsIncluderResult {
    readonly filename?: string;
    readonly template?: string;
  }
  export interface EjsCompileOptions {
    readonly filename: string;
    readonly root: string;
    readonly escape: (markup: unknown) => string;
    readonly includer: (
      originalPath: string,
      parsedPath: string | undefined,
    ) => EjsIncluderResult;
    readonly compileDebug: boolean;
    readonly strict: false;
    readonly _with: true;
    readonly localsName: 'locals';
    readonly cache: false;
    readonly async: false;
    readonly rmWhitespace: boolean;
  }
  export type EjsTemplateFunction = (data: object) => string;
  interface Ejs {
    compile(source: string, options: EjsCompileOptions): EjsTemplateFunction;
    escapeXML(markup: unknown): string;
  }
  const ejs: Ejs;
  export default ejs;
}
