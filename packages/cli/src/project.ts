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
  return insertBeforeStatement(
    text,
    statements,
    marker,
    /^await\w+\.listen\(/,
    '`await app.listen(...)` in main.ts',
  );
}
/** Whether an expression statement matching `pattern` (whitespace removed) exists. */
export function hasStatement(text: string, pattern: RegExp): boolean {
  return findStatement(parse(text), pattern) !== undefined;
}
function findStatement(
  source: ts.SourceFile,
  pattern: RegExp,
): ts.Node | undefined {
  let target: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !target &&
      ts.isExpressionStatement(node) &&
      pattern.test(node.getText(source).replace(/\s+/g, ''))
    )
      target = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return target;
}
/**
 * Insert statements (re-indented) before the first expression statement whose
 * whitespace-free text matches `pattern`, unless `marker` already appears.
 */
export function insertBeforeStatement(
  text: string,
  statements: string,
  marker: string,
  pattern: RegExp,
  description: string,
): string {
  if (text.includes(marker)) return text;
  const source = parse(text);
  const target = findStatement(source, pattern);
  if (!target) throw new CliError(`Could not find ${description}`);
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
        !(pkg['dependencies'] as Record<string, string> | undefined)?.[name] &&
        !(pkg['devDependencies'] as Record<string, string> | undefined)?.[name]
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

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  )
    current = current.expression;
  return current;
}
/** Initializer of a top-level `const name = ...` (exported or not). */
function variableInitializer(
  source: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      )
        return unwrap(declaration.initializer);
  }
  return undefined;
}
/** Insert `line` before a `// nestvexa:<slot>` comment inside [start, end). */
function insertBeforeSlot(
  text: string,
  start: number,
  end: number,
  slot: string,
  line: string,
): string | undefined {
  const index = text.indexOf(`// nestvexa:${slot}`, start);
  if (index < 0 || index >= end) return undefined;
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const indent = text.slice(lineStart, index);
  if (indent.trim()) return undefined;
  return `${text.slice(0, lineStart)}${indent}${line}\n${text.slice(lineStart)}`;
}
/**
 * Append an element to the array of `const name = [...]` (also inside
 * `new X([...])`, `fn([...])`, `as const` or `satisfies`) unless an element
 * already contains `marker`. Inserts above a `// nestvexa:<slot>` comment when
 * present so generated lists stay one entry per line.
 */
export function addArrayElement(
  text: string,
  variable: string,
  element: string,
  marker: string,
  slot?: string,
): string {
  const source = parse(text);
  const initializer = variableInitializer(source, variable);
  let array: ts.ArrayLiteralExpression | undefined;
  if (initializer && ts.isArrayLiteralExpression(initializer))
    array = initializer;
  else if (
    initializer &&
    (ts.isNewExpression(initializer) || ts.isCallExpression(initializer))
  ) {
    const first = initializer.arguments?.[0];
    const inner = first ? unwrap(first) : undefined;
    if (inner && ts.isArrayLiteralExpression(inner)) array = inner;
  }
  if (!array)
    throw new CliError(
      `Could not find the array \`${variable}\`; add ${element} manually`,
    );
  if (array.elements.some((item) => item.getText(source).includes(marker)))
    return text;
  const start = array.getStart(source);
  const end = array.getEnd();
  const slotted = slot
    ? insertBeforeSlot(text, start, end, slot, `${element},`)
    : undefined;
  if (slotted) return slotted;
  const last = array.elements.at(-1);
  if (last)
    return `${text.slice(0, last.getEnd())}, ${element}${text.slice(last.getEnd())}`;
  return `${text.slice(0, start + 1)}${element}${text.slice(start + 1)}`;
}
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}
function objectProperty(
  object: ts.ObjectLiteralExpression,
  key: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find(
    (property) => property.name && propertyName(property.name) === key,
  );
}
/**
 * Add `key: value` to the object literal of `const name = {...}` (or to a
 * nested object reached through `path`, created when missing) unless the key
 * already exists.
 */
export function addObjectProperty(
  text: string,
  variable: string,
  key: string,
  value: string,
  slot?: string,
  path: readonly string[] = [],
): string {
  const source = parse(text);
  const root = variableInitializer(source, variable);
  if (!root || !ts.isObjectLiteralExpression(root))
    throw new CliError(
      `Could not find the object \`${variable}\`; add "${key}" manually`,
    );
  let initializer = root;
  for (const [index, segment] of path.entries()) {
    const property = objectProperty(initializer, segment);
    if (!property)
      return addObjectProperty(
        text,
        variable,
        segment,
        nestedValue(path.slice(index + 1), key, value),
        undefined,
        path.slice(0, index),
      );
    const inner = ts.isPropertyAssignment(property)
      ? unwrap(property.initializer)
      : undefined;
    if (!inner || !ts.isObjectLiteralExpression(inner))
      throw new CliError(
        `\`${variable}.${path.slice(0, index + 1).join('.')}\` is not an object literal; add "${key}" manually`,
      );
    initializer = inner;
  }
  if (objectProperty(initializer, key)) return text;
  const entry = `${identifierOrString(key)}: ${value}`;
  const start = initializer.getStart(source);
  const end = initializer.getEnd();
  const slotted = slot
    ? insertBeforeSlot(text, start, end, slot, `${entry},`)
    : undefined;
  if (slotted) return slotted;
  const last = initializer.properties.at(-1);
  if (last)
    return `${text.slice(0, last.getEnd())}, ${entry}${text.slice(last.getEnd())}`;
  return `${text.slice(0, start + 1)} ${entry} ${text.slice(start + 1)}`;
}
function identifierOrString(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
}
function nestedValue(path: readonly string[], key: string, value: string) {
  let result = `{ ${identifierOrString(key)}: ${value} }`;
  for (const segment of [...path].reverse())
    result = `{ ${identifierOrString(segment)}: ${result} }`;
  return result;
}
/** Add `import name from 'module'` unless that default import exists. */
export function ensureDefaultImport(
  text: string,
  module: string,
  name: string,
): string {
  const source = parse(text);
  const imports = source.statements.filter(ts.isImportDeclaration);
  if (
    imports.some(
      (node) =>
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === module &&
        node.importClause?.name?.text === name,
    )
  )
    return text;
  const line = `import ${name} from '${module}';`;
  const first = imports[0];
  if (!first) return `${line}\n${text}`;
  const position = first.getStart(source);
  return `${text.slice(0, position)}${line}\n${text.slice(position)}`;
}
/**
 * Inject a provider into the `useFactory` of `const variable = { inject?, useFactory }`
 * and pass it on as `property` in the returned object literal:
 * `useFactory: () => ({ ... })` becomes
 * `inject: [Token], useFactory: (param: Token) => ({ ..., property: param })`.
 * Returns `undefined` when the factory does not have that shape.
 */
export function addFactoryInjection(
  text: string,
  variable: string,
  token: string,
  param: string,
  property: string,
): string | undefined {
  const source = parse(text);
  const object = variableInitializer(source, variable);
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const factory = objectProperty(object, 'useFactory');
  const fn =
    factory && ts.isPropertyAssignment(factory)
      ? unwrap(factory.initializer)
      : undefined;
  if (!fn || !ts.isArrowFunction(fn)) return undefined;
  const body = ts.isExpression(fn.body) ? unwrap(fn.body) : undefined;
  if (!body || !ts.isObjectLiteralExpression(body)) return undefined;
  if (objectProperty(body, property)) return text;
  const inject = objectProperty(object, 'inject');
  const injected =
    inject && ts.isPropertyAssignment(inject)
      ? unwrap(inject.initializer)
      : undefined;
  if (inject && (!injected || !ts.isArrayLiteralExpression(injected)))
    return undefined;
  if (
    injected &&
    ts.isArrayLiteralExpression(injected) &&
    injected.elements.length !== fn.parameters.length
  )
    return undefined;
  // Edit from the end of the file backwards so earlier offsets stay valid.
  const edits: { at: number; insert: string }[] = [];
  const lastProperty = body.properties.at(-1);
  edits.push(
    lastProperty
      ? {
          at: lastProperty.getEnd(),
          insert: `,\n    ${param === property ? property : `${property}: ${param}`}`,
        }
      : { at: body.getStart(source) + 1, insert: ` ${property}: ${param} ` },
  );
  const parameter = `${param}: ${token}`;
  const lastParameter = fn.parameters.at(-1);
  edits.push(
    lastParameter
      ? { at: lastParameter.getEnd(), insert: `, ${parameter}` }
      : {
          at: text.indexOf('(', fn.getStart(source)) + 1,
          insert: parameter,
        },
  );
  if (injected && ts.isArrayLiteralExpression(injected)) {
    const last = injected.elements.at(-1);
    edits.push(
      last
        ? { at: last.getEnd(), insert: `, ${token}` }
        : { at: injected.getStart(source) + 1, insert: token },
    );
  } else
    edits.push({
      at: factory ? factory.getStart(source) : object.getStart(source) + 1,
      insert: `inject: [${token}],\n  `,
    });
  let result = text;
  for (const edit of edits.sort((a, b) => b.at - a.at))
    result = `${result.slice(0, edit.at)}${edit.insert}${result.slice(edit.at)}`;
  return result;
}
/**
 * Add `key: value` to the object literal returned by the `useFactory` arrow of
 * `const variable = { useFactory: (...) => ({ ... }) }` unless the key exists.
 * Returns `undefined` when the factory does not have that shape.
 */
export function addFactoryResultProperty(
  text: string,
  variable: string,
  key: string,
  value: string,
): string | undefined {
  const source = parse(text);
  const object = variableInitializer(source, variable);
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const factory = objectProperty(object, 'useFactory');
  const fn =
    factory && ts.isPropertyAssignment(factory)
      ? unwrap(factory.initializer)
      : undefined;
  if (!fn || !ts.isArrowFunction(fn)) return undefined;
  const body = ts.isExpression(fn.body) ? unwrap(fn.body) : undefined;
  if (!body || !ts.isObjectLiteralExpression(body)) return undefined;
  if (objectProperty(body, key)) return text;
  const entry = `${identifierOrString(key)}: ${value}`;
  const last = body.properties.at(-1);
  if (last)
    return `${text.slice(0, last.getEnd())},\n    ${entry}${text.slice(last.getEnd())}`;
  const start = body.getStart(source) + 1;
  return `${text.slice(0, start)} ${entry} ${text.slice(start)}`;
}
function packageJson(plan: ChangePlan): Record<string, unknown> {
  const text = plan.read('package.json');
  if (text === undefined) throw new CliError('package.json is missing');
  return JSON.parse(text) as Record<string, unknown>;
}
/** Add package.json scripts that do not exist yet; existing scripts are never changed. */
export function addScripts(
  plan: ChangePlan,
  scripts: Readonly<Record<string, string>>,
): string[] {
  const pkg = packageJson(plan);
  const current = {
    ...((pkg['scripts'] as Record<string, string> | undefined) ?? {}),
  };
  const added = Object.keys(scripts).filter((name) => !current[name]);
  if (!added.length) return [];
  for (const name of added) current[name] = scripts[name] ?? '';
  pkg['scripts'] = current;
  plan.update('package.json', JSON.stringify(pkg, null, 2) + '\n');
  return added;
}
/** Append `&& <step>` to an aggregate script (creating it when absent). */
export function extendScript(
  plan: ChangePlan,
  name: string,
  step: string,
): void {
  const pkg = packageJson(plan);
  const scripts = {
    ...((pkg['scripts'] as Record<string, string> | undefined) ?? {}),
  };
  const current = scripts[name];
  if (current?.split('&&').some((part) => part.trim() === step)) return;
  scripts[name] = current ? `${current} && ${step}` : step;
  pkg['scripts'] = scripts;
  plan.update('package.json', JSON.stringify(pkg, null, 2) + '\n');
}
/**
 * Keep frontend sources out of the server TypeScript build. Only a tsconfig
 * without `include` compiles them, and only plain-JSON files are rewritten;
 * otherwise a manual instruction is returned (comments would be lost).
 */
export function excludeFromServerBuild(
  plan: ChangePlan,
  file: string,
  entries: readonly string[],
): string | undefined {
  const text = plan.read(file);
  if (text === undefined) return undefined;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(text) as Record<string, unknown>;
  } catch {
    const parsed: unknown = ts.parseConfigFileTextToJson(file, text).config;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Reflect.get(parsed, 'include') !== undefined
    )
      return undefined;
    return `Add ${entries.map((entry) => `"${entry}"`).join(', ')} to "exclude" in ${file} so the server build skips frontend sources.`;
  }
  if (config['include'] !== undefined) return undefined;
  const existing = Array.isArray(config['exclude'])
    ? (config['exclude'] as unknown[]).filter(
        (item): item is string => typeof item === 'string',
      )
    : undefined;
  const base = existing ?? ['node_modules', 'dist'];
  const next = [...new Set([...base, ...entries])];
  if (existing && next.length === existing.length) return undefined;
  config['exclude'] = next;
  plan.update(file, JSON.stringify(config, null, 2) + '\n');
  return undefined;
}
