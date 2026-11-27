// Compiles the TypeScript fences marked for checking (```ts check) against the
// built packages, so documented code that is not quoted from a source file
// still has to type-check. Each block is its own ES module; workspace package
// specifiers resolve to their built `.d.ts` entry points (`collectEntries`),
// everything else resolves from the repository's node_modules.
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

/** Fence languages that can be marked `check`. */
export const checkableLanguages = new Set(['ts', 'typescript']);

/** True when a fence info string asks for type-checking (`ts check`). */
export function isCheckedFence(info) {
  const [language, ...flags] = (info ?? '').trim().split(/\s+/);
  return checkableLanguages.has(language ?? '') && flags.includes('check');
}

const toPosix = (path) => path.replaceAll('\\', '/');

/**
 * Type-checks `blocks` (`{ source, index, code }`) and returns one message per
 * diagnostic. `entries` are the workspace export entry points.
 */
export function checkTypeScriptBlocks(root, blocks, entries) {
  if (blocks.length === 0) return [];
  const paths = {};
  for (const entry of entries) paths[entry.specifier] = [toPosix(entry.file)];
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: existsSync(join(root, 'node_modules/@types/node')) ? ['node'] : [],
    typeRoots: [toPosix(join(root, 'node_modules/@types'))],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    useUnknownInCatchVariables: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
    // Package declarations are checked by their own builds.
    skipLibCheck: true,
    noEmit: true,
    paths,
  };
  const directory = toPosix(join(root, 'apps/docs/.snippets'));
  const virtual = new Map();
  for (const [position, block] of blocks.entries())
    virtual.set(posix.join(directory, `block-${position}.mts`), block);

  const host = ts.createCompilerHost(options, true);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const normalize = (file) => toPosix(file);
  host.fileExists = (file) => virtual.has(normalize(file)) || fileExists(file);
  host.readFile = (file) =>
    virtual.get(normalize(file))?.code ?? readFile(file);
  host.getSourceFile = (file, language, onError, create) => {
    const block = virtual.get(normalize(file));
    return block
      ? ts.createSourceFile(file, block.code, language, true)
      : getSourceFile(file, language, onError, create);
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  const problems = [];
  for (const [file, block] of virtual) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ];
    for (const diagnostic of diagnostics) {
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const line =
        diagnostic.start === undefined
          ? ''
          : `:${sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
      problems.push({
        source: block.source,
        message: `\`ts check\` block ${block.index + 1}${line}: TS${diagnostic.code} ${text}`,
      });
    }
  }
  return problems;
}
