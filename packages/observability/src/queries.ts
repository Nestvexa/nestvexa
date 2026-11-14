import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Development-only N+1 query detection. The host's ORM or database driver
 * reports every executed statement through `record()` (a structural hook:
 * TypeORM `Logger#logQuery`, Prisma `$on('query')`, Drizzle `logger`,
 * `pg` query wrappers); statements are counted per request (or per explicit
 * `run()` scope) by their normalized shape, and a warning is raised when one
 * shape repeats more than `maxIdenticalQueries` times. Disabled, with no
 * bookkeeping at all, when the environment is `production`.
 */
export interface QueryBudgetOptions {
  /** Executions of one normalized statement per scope before an `n-plus-one` warning. Default 5. */
  readonly maxIdenticalQueries?: number;
  /** Statements per scope before a `query-count` warning. Default 100. */
  readonly maxQueries?: number;
  /** Default: `process.emitWarning` with code `NESTVEXA_QUERY_BUDGET`. */
  readonly onWarning?: (warning: QueryBudgetWarning) => void;
  /** Defaults to `process.env.NODE_ENV`; `production` disables every check. */
  readonly environment?: string;
  /**
   * Statement shape used for counting. The default collapses whitespace and
   * replaces string and numeric literals, bind placeholders and `IN` lists
   * with `?`, so `WHERE id = 1` and `WHERE id = 2` count as one statement.
   */
  readonly normalize?: (statement: string) => string;
}
export type QueryBudgetWarningKind = 'n-plus-one' | 'query-count';
export interface QueryBudgetWarning {
  readonly kind: QueryBudgetWarningKind;
  /** Scope label: `HTTP GET` for requests, or the label given to `run()`. */
  readonly scope: string;
  /** Normalized statement (literals removed, at most 200 characters); empty for `query-count`. */
  readonly statement: string;
  readonly count: number;
  readonly limit: number;
}
export interface QueryScopeSnapshot {
  readonly scope: string;
  readonly total: number;
  /** Executions per normalized statement. */
  readonly statements: ReadonlyMap<string, number>;
}
export interface QueryBudget {
  /** False in production: `record` is a no-op and scopes are not created. */
  readonly enabled: boolean;
  /**
   * The hook the ORM calls for every executed statement: a SQL string or an
   * object with a string `query`, `sql` or `text` property. Parameters are
   * never read. Outside a scope it does nothing.
   */
  record(statement: unknown): void;
  /** Run work in its own counting scope (jobs, WebSocket messages, tests). */
  run<T>(label: string, work: () => T): T;
  /** Connect-style middleware (Express, or Fastify through Nest middleware): one scope per request. */
  middleware(): (request: object, response: unknown, next: () => void) => void;
  /** Counts of the current scope, or `undefined` outside one (diagnostics and tests). */
  current(): QueryScopeSnapshot | undefined;
}

interface Scope {
  readonly label: string;
  total: number;
  readonly statements: Map<string, number>;
  countReported: boolean;
}

/** Longest statement text normalized; longer text is cut first (bounded regex work). */
const maxStatementLength = 8192;
/** Distinct statement shapes tracked per scope. */
const maxShapes = 1000;
const methods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** Default statement shape: literals, placeholders and `IN` lists become `?`. */
export function normalizeQuery(statement: string): string {
  return statement
    .slice(0, maxStatementLength)
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\$\d+|(?<!:):(?!:)[A-Za-z_]\w*|@p?\d+|\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, '(?)')
    .replace(/\s+/g, ' ')
    .trim();
}
export function describeQueryBudgetWarning(
  warning: QueryBudgetWarning,
): string {
  return warning.kind === 'n-plus-one'
    ? `Nestvexa query budget: possible N+1 in ${warning.scope}: the same statement ran ${warning.count} times (limit ${warning.limit}): ${warning.statement}`
    : `Nestvexa query budget: ${warning.count} statements in ${warning.scope} (limit ${warning.limit})`;
}
function limit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error(`Query budget ${name} must be a positive integer`);
  return result;
}
function statementText(statement: unknown): string | undefined {
  if (typeof statement === 'string') return statement;
  if (statement === null || typeof statement !== 'object') return undefined;
  for (const key of ['query', 'sql', 'text']) {
    const value: unknown = Reflect.get(statement, key);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

const disabled: QueryBudget = Object.freeze({
  enabled: false,
  record: () => undefined,
  run: <T>(_label: string, work: () => T): T => work(),
  middleware: () => (_request: object, _response: unknown, next: () => void) =>
    next(),
  current: () => undefined,
});

/** Create a per-request query counter with development-time N+1 warnings. */
export function queryBudget(options: QueryBudgetOptions = {}): QueryBudget {
  const environment =
    options.environment ?? process.env['NODE_ENV'] ?? 'development';
  if (environment === 'production') return disabled;
  const maxIdentical = limit(
    options.maxIdenticalQueries,
    5,
    'maxIdenticalQueries',
  );
  const maxQueries = limit(options.maxQueries, 100, 'maxQueries');
  const normalize = options.normalize ?? normalizeQuery;
  const report =
    options.onWarning ??
    ((warning: QueryBudgetWarning) =>
      process.emitWarning(describeQueryBudgetWarning(warning), {
        code: 'NESTVEXA_QUERY_BUDGET',
      }));
  const storage = new AsyncLocalStorage<Scope>();
  const warn = (warning: QueryBudgetWarning): void => {
    try {
      report(Object.freeze(warning));
    } catch {
      // A failing warning sink never affects the request.
    }
  };
  const scope = (label: string): Scope => ({
    label: label.slice(0, 200),
    total: 0,
    statements: new Map(),
    countReported: false,
  });
  return Object.freeze({
    enabled: true,
    record(statement: unknown): void {
      const current = storage.getStore();
      if (current === undefined) return;
      const text = statementText(statement);
      if (text === undefined) return;
      current.total++;
      if (current.total > maxQueries && !current.countReported) {
        current.countReported = true;
        warn({
          kind: 'query-count',
          scope: current.label,
          statement: '',
          count: current.total,
          limit: maxQueries,
        });
      }
      let shape: string;
      try {
        shape = normalize(text.slice(0, maxStatementLength));
      } catch {
        return;
      }
      const seen = current.statements.get(shape);
      if (seen === undefined && current.statements.size >= maxShapes) return;
      const count = (seen ?? 0) + 1;
      current.statements.set(shape, count);
      // Reported once per scope and statement, when the limit is crossed.
      if (count === maxIdentical + 1)
        warn({
          kind: 'n-plus-one',
          scope: current.label,
          statement: shape.slice(0, 200),
          count,
          limit: maxIdentical,
        });
    },
    run<T>(label: string, work: () => T): T {
      return storage.run(scope(String(label)), work);
    },
    middleware() {
      return (request: object, _response: unknown, next: () => void) => {
        const method: unknown = Reflect.get(request, 'method');
        storage.run(
          scope(
            `HTTP ${typeof method === 'string' && methods.has(method) ? method : 'OTHER'}`,
          ),
          next,
        );
      };
    },
    current(): QueryScopeSnapshot | undefined {
      const current = storage.getStore();
      return current === undefined
        ? undefined
        : Object.freeze({
            scope: current.label,
            total: current.total,
            statements: new Map(current.statements),
          });
    },
  });
}
