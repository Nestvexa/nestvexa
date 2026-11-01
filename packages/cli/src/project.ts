import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { CliError } from './plan.js';
import type { ChangePlan } from './plan.js';

export interface ProjectInfo {
  readonly root: string;
  readonly packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  readonly esm: boolean;
  readonly platform: 'express' | 'fastify';
  readonly sourceRoot: string;
  readonly mainFile: string;
  readonly appModule: string;
  readonly dependencies: Readonly<Record<string, string>>;
}
interface PackageJson {
  readonly type?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}
export function readPackage(root: string): PackageJson {
  const path = join(root, 'package.json');
  if (!existsSync(path))
    throw new CliError('No package.json found. Run inside a NestJS project.');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new CliError('package.json must contain an object');
  return parsed as PackageJson;
}
/** Detect a Nest project without assuming more than package.json and the Nest CLI layout. */
export function detectProject(root: string): ProjectInfo {
  const pkg = readPackage(root);
  const dependencies = { ...pkg.devDependencies, ...pkg.dependencies };
  if (!dependencies['@nestjs/core'])
    throw new CliError(
      'This does not look like a NestJS project (@nestjs/core is not a dependency).',
    );
  let sourceRoot = 'src';
  const cliConfig = join(root, 'nest-cli.json');
  if (existsSync(cliConfig)) {
    const parsed: unknown = JSON.parse(readFileSync(cliConfig, 'utf8'));
    const value: unknown =
      parsed && typeof parsed === 'object'
        ? Reflect.get(parsed, 'sourceRoot')
        : undefined;
    if (
      typeof value === 'string' &&
      /^[\w./-]{1,64}$/.test(value) &&
      !value.includes('..')
    )
      sourceRoot = value.replace(/\/$/, '');
  }
  const packageManager = existsSync(join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(root, 'bun.lockb'))
        ? 'bun'
        : 'npm';
  return Object.freeze({
    root,
    packageManager,
    esm: pkg.type === 'module',
    platform: dependencies['@nestjs/platform-fastify'] ? 'fastify' : 'express',
    sourceRoot,
    mainFile: `${sourceRoot}/main.ts`,
    appModule: `${sourceRoot}/app.module.ts`,
    dependencies,
  });
}

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile(
    'file.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}
/** Add named imports, merging into an existing import of the same module. */
export function ensureImport(
  text: string,
  module: string,
  names: readonly string[],
): string {
  const source = parse(text);
  const imports = source.statements.filter(ts.isImportDeclaration);
  const existing = imports.find(
    (node) =>
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === module &&
      !node.importClause?.isTypeOnly &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings),
  );
  if (
    existing?.importClause?.namedBindings &&
    ts.isNamedImports(existing.importClause.namedBindings)
  ) {
    const bindings = existing.importClause.namedBindings;
    const present = new Set(
      bindings.elements.map((element) => element.name.text),
    );
    const missing = names.filter((name) => !present.has(name));
    if (!missing.length) return text;
    const last = bindings.elements.at(-1);
    const position = last ? last.getEnd() : bindings.getStart() + 1;
    return `${text.slice(0, position)}${last ? ', ' : ' '}${missing.join(', ')}${text.slice(position)}`;
  }
  const line = `import { ${names.join(', ')} } from '${module}';\n`;
  const after = imports.at(-1);
  if (!after) return line + text;
  const position = after.getEnd();
  return `${text.slice(0, position)}\n${line.trimEnd()}${text.slice(position)}`;
}
function moduleObject(source: ts.SourceFile): ts.ObjectLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    for (const decorator of ts.getDecorators(statement) ?? []) {
      const call = decorator.expression;
      if (
        ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === 'Module' &&
        call.arguments[0] &&
        ts.isObjectLiteralExpression(call.arguments[0])
      )
        return call.arguments[0];
    }
  }
  throw new CliError(
    'Could not find an @Module({...}) class in the application module',
  );
}
/** Append an element to `@Module({ imports: [...] })` unless `marker` already appears. */
export function addModuleArrayEntry(
  text: string,
  property: 'imports' | 'controllers' | 'providers',
  element: string,
  marker: string,
): string {
  const source = parse(text);
  const object = moduleObject(source);
  const existing = object.properties.find(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) &&
      ts.isIdentifier(item.name) &&
      item.name.text === property,
  );
  if (existing) {
    if (!ts.isArrayLiteralExpression(existing.initializer))
      throw new CliError(
        `@Module ${property} is not an array literal; add ${element} manually`,
      );
    const array = existing.initializer;
    if (array.elements.some((item) => item.getText(source).includes(marker)))
      return text;
    const last = array.elements.at(-1);
    if (last) {
      const position = last.getEnd();
      return `${text.slice(0, position)}, ${element}${text.slice(position)}`;
    }
    const position = array.getStart(source) + 1;
    return `${text.slice(0, position)}${element}${text.slice(position)}`;
  }
  const position = object.getStart(source) + 1;
  return `${text.slice(0, position)}\n  ${property}: [${element}],${text.slice(position)}`;
}
/** Insert statements before `await <app>.listen(...)` unless `marker` already appears. */
export function insertBeforeListen(
  text: string,
  statements: string,
  marker: string,
): string {
  if (text.includes(marker)) return text;
  const source = parse(text);
  let target: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !target &&
      ts.isExpressionStatement(node) &&
      node
        .getText(source)
        .replace(/\s+/g, '')
        .match(/^await\w+\.listen\(/)
    )
      target = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!target)
    throw new CliError('Could not find `await app.listen(...)` in main.ts');
  const start = target.getStart(source);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const indent = text.slice(lineStart, start);
  const block = statements
    .split('\n')
    .map((line) => (line ? indent + line : line))
    .join('\n');
  return `${text.slice(0, lineStart)}${block}\n${text.slice(lineStart)}`;
}
/** Add dependencies to package.json without changing existing ranges. */
export function addDependencies(
  plan: ChangePlan,
  dependencies: Readonly<Record<string, string>>,
  dev: Readonly<Record<string, string>> = {},
): string[] {
  const text = plan.read('package.json');
  if (text === undefined) throw new CliError('package.json is missing');
  const pkg = JSON.parse(text) as Record<string, unknown>;
  const added: string[] = [];
  for (const [field, wanted] of [
    ['dependencies', dependencies],
    ['devDependencies', dev],
  ] as const) {
    const current = {
      ...((pkg[field] as Record<string, string> | undefined) ?? {}),
    };
    for (const [name, range] of Object.entries(wanted))
      if (
        !current[name] &&
        !(pkg['dependencies'] as Record<string, string> | undefined)?.[name]
      ) {
        current[name] = range;
        added.push(name);
      }
    if (Object.keys(current).length)
      pkg[field] = Object.fromEntries(
        Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
      );
  }
  if (added.length)
    plan.update('package.json', JSON.stringify(pkg, null, 2) + '\n');
  return added;
}
export function names(raw: string): {
  pascal: string;
  kebab: string;
  camel: string;
} {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(raw))
    throw new CliError(
      'Names use letters, digits and hyphens, starting with a letter',
    );
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const pascal = words
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join('');
  return {
    pascal,
    kebab: words.join('-'),
    camel: pascal[0]?.toLowerCase() + pascal.slice(1),
  };
}
