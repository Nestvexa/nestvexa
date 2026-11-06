import type {
  LiveInstrumentation,
  LiveSpan,
  SpanAttributes,
} from './instrumentation.js';

/**
 * Development-only render budget: watches the spans the runtime already emits
 * and warns when a render or action exceeds a limit. It never changes request
 * behavior and is disabled when the environment is `production`.
 */
export interface RenderBudget {
  /** `nestvexa.live.render` duration in ms. Default 50. */
  readonly slowRenderMs?: number;
  /** `nestvexa.live.action` / `nestvexa.action` duration in ms. Default 250. */
  readonly slowActionMs?: number;
  /** Rendered HTML per component (`nestvexa.html_bytes`). Default 102400. */
  readonly maxHtmlBytes?: number;
  /** Public state sent to the browser (`nestvexa.state_bytes`). Default 32768. */
  readonly maxStateBytes?: number;
  /** Inertia page object bytes (`nestvexa.page_bytes`). Default 262144. */
  readonly maxPageBytes?: number;
  /** Root (depth 0) renders of one component within `loopWindowMs` before a loop warning. Default 25. */
  readonly maxRendersPerWindow?: number;
  /** Render loop window in ms. Default 1000. */
  readonly loopWindowMs?: number;
}
export type BudgetWarningKind =
  | 'slow-render'
  | 'slow-action'
  | 'large-html'
  | 'large-state'
  | 'large-page'
  | 'render-loop';
export interface BudgetWarning {
  readonly kind: BudgetWarningKind;
  readonly span: string;
  /** Component, action or page name from span attributes (never state or HTML). */
  readonly subject: string;
  readonly value: number;
  readonly limit: number;
}
export interface RenderBudgetOptions extends RenderBudget {
  /** Spans are forwarded here unchanged (for example OpenTelemetry or devtools). */
  readonly inner?: LiveInstrumentation;
  /** Default: `process.emitWarning` with code `NESTVEXA_RENDER_BUDGET`. */
  readonly onWarning?: (warning: BudgetWarning) => void;
  /** Defaults to `process.env.NODE_ENV`; `production` disables every check. */
  readonly environment?: string;
  /** Repeated identical warnings are suppressed for this many ms. Default 10000. */
  readonly repeatAfterMs?: number;
  readonly now?: () => number;
}

const noop: LiveInstrumentation = Object.freeze({
  start: (): LiveSpan => ({ end: () => undefined }),
});

function limit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0)
    throw new Error(`Render budget ${name} must be a positive number`);
  return result;
}
function numeric(attributes: SpanAttributes, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
function subjectOf(attributes: SpanAttributes): string {
  const parts = ['nestvexa.component', 'nestvexa.action', 'nestvexa.page']
    .map((key) => attributes[key])
    .filter((value): value is string => typeof value === 'string');
  return parts.join('#').slice(0, 200) || 'unknown';
}
export function describeBudgetWarning(warning: BudgetWarning): string {
  const unit = warning.kind.startsWith('slow')
    ? 'ms'
    : warning.kind === 'render-loop'
      ? 'renders'
      : 'bytes';
  return `Nestvexa render budget: ${warning.kind} in ${warning.subject} (${warning.span}): ${Math.round(warning.value)} ${unit} exceeds ${warning.limit} ${unit}`;
}

/** Wrap instrumentation with development-time render budget warnings. */
export function renderBudgetInstrumentation(
  options: RenderBudgetOptions = {},
): LiveInstrumentation {
  const inner = options.inner ?? noop;
  const environment =
    options.environment ?? process.env['NODE_ENV'] ?? 'development';
  if (environment === 'production') return inner;
  const budget = {
    slowRenderMs: limit(options.slowRenderMs, 50, 'slowRenderMs'),
    slowActionMs: limit(options.slowActionMs, 250, 'slowActionMs'),
    maxHtmlBytes: limit(options.maxHtmlBytes, 102_400, 'maxHtmlBytes'),
    maxStateBytes: limit(options.maxStateBytes, 32_768, 'maxStateBytes'),
    maxPageBytes: limit(options.maxPageBytes, 262_144, 'maxPageBytes'),
    maxRenders: limit(options.maxRendersPerWindow, 25, 'maxRendersPerWindow'),
    loopWindowMs: limit(options.loopWindowMs, 1000, 'loopWindowMs'),
  };
  const repeatAfter = options.repeatAfterMs ?? 10_000;
  const now = options.now ?? (() => performance.now());
  const report =
    options.onWarning ??
    ((warning: BudgetWarning) =>
      process.emitWarning(describeBudgetWarning(warning), {
        code: 'NESTVEXA_RENDER_BUDGET',
      }));
  const lastReported = new Map<string, number>();
  const renders = new Map<string, number[]>();
  const warn = (warning: BudgetWarning): void => {
    const key = `${warning.kind}\u0000${warning.subject}`;
    const at = now();
    const previous = lastReported.get(key);
    if (previous !== undefined && at - previous < repeatAfter) return;
    lastReported.set(key, at);
    // Bounded bookkeeping: forget the oldest entries.
    if (lastReported.size > 1000) {
      const oldest = lastReported.keys().next().value;
      if (oldest !== undefined) lastReported.delete(oldest);
    }
    try {
      report(Object.freeze(warning));
    } catch {
      // A failing warning sink never affects the request.
    }
  };
  const check = (
    name: string,
    attributes: SpanAttributes,
    milliseconds: number,
  ): void => {
    const subject = subjectOf(attributes);
    const over = (
      kind: BudgetWarningKind,
      value: number | undefined,
      max: number,
    ) => {
      if (value !== undefined && value > max)
        warn({ kind, span: name, subject, value, limit: max });
    };
    if (name === 'nestvexa.live.render') {
      over('slow-render', milliseconds, budget.slowRenderMs);
      over(
        'large-html',
        numeric(attributes, 'nestvexa.html_bytes'),
        budget.maxHtmlBytes,
      );
      over(
        'large-state',
        numeric(attributes, 'nestvexa.state_bytes'),
        budget.maxStateBytes,
      );
      // Loop detection counts root renders only: a page may legitimately
      // render many instances of one child component.
      if ((numeric(attributes, 'nestvexa.depth') ?? 0) !== 0) return;
      const at = now();
      const window = (renders.get(subject) ?? []).filter(
        (time) => at - time < budget.loopWindowMs,
      );
      window.push(at);
      renders.set(subject, window);
      if (renders.size > 1000) {
        const oldest = renders.keys().next().value;
        if (oldest !== undefined) renders.delete(oldest);
      }
      over('render-loop', window.length, budget.maxRenders);
    } else if (name === 'nestvexa.live.action' || name === 'nestvexa.action')
      over('slow-action', milliseconds, budget.slowActionMs);
    else if (name === 'nestvexa.inertia.render') {
      over('slow-render', milliseconds, budget.slowRenderMs);
      over(
        'large-page',
        numeric(attributes, 'nestvexa.page_bytes'),
        budget.maxPageBytes,
      );
    }
  };
  return Object.freeze({
    start(name: string, attributes: SpanAttributes): LiveSpan {
      const span = inner.start(name, attributes);
      const started = now();
      let ended = false;
      return {
        end(outcome, extra = {}) {
          if (ended) return;
          ended = true;
          span.end(outcome, extra);
          if (outcome === 'ok')
            check(
              name,
              { ...attributes, ...extra },
              Math.max(0, now() - started),
            );
        },
      };
    },
  });
}
