/**
 * Optional browser glue for a Live assistant panel. It starts the authorized
 * read-only text stream once per server-declared turn, exposes a stop button and
 * asks the component to collect the stored result afterwards. It never retries,
 * never evaluates markup and never chooses endpoints: the Live client does.
 */

/** Structural subset of the Nestvexa Live client used by this module. */
export interface AssistantClient {
  startStream(target: Element): Promise<unknown>;
  cancelStream(target: Element): void;
  call(element: Element, action: string, input?: unknown): Promise<void>;
}

export interface ConnectAssistantOptions {
  /** Live action that reads the finished turn; default `collect`. */
  readonly collectAction?: string;
}

export interface AssistantConnection {
  dispose(): void;
}

type Outcome = 'done' | 'cancelled' | 'failed';
interface Active {
  readonly target: Element;
  cancelled: boolean;
}

const actionPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const turnPattern = /^[A-Za-z0-9_:.-]{1,128}$/;

function setStatus(panel: Element, key: 'streaming' | Outcome): void {
  const status = panel.querySelector('[data-nv-ai-status]');
  const label = panel.getAttribute(`data-nv-ai-label-${key}`);
  if (status && label !== null) status.textContent = label;
}
function setCancel(panel: Element, enabled: boolean): void {
  for (const button of panel.querySelectorAll('[data-nv-ai-cancel]')) {
    if (enabled) button.removeAttribute('disabled');
    else button.setAttribute('disabled', '');
  }
}

/**
 * Connect every `[data-nv-ai]` panel at or below `root`. Returns a handle whose
 * `dispose()` removes listeners; in-flight streams are cancelled on dispose.
 */
export function connectAssistant(
  root: Element,
  client: AssistantClient,
  options: ConnectAssistantOptions = {},
): AssistantConnection {
  const collect = options.collectAction ?? 'collect';
  if (!actionPattern.test(collect))
    throw new Error('Invalid assistant collect action');
  if (
    !client ||
    typeof client.startStream !== 'function' ||
    typeof client.cancelStream !== 'function' ||
    typeof client.call !== 'function'
  )
    throw new Error('connectAssistant requires a Live client');
  const document = root.ownerDocument;
  const started = new Set<string>();
  const active = new Map<Element, Active>();
  let disposed = false;

  function panels(): Element[] {
    const found = [...root.querySelectorAll('[data-nv-ai]')];
    return root.matches('[data-nv-ai]') ? [root, ...found] : found;
  }

  async function run(panel: Element): Promise<void> {
    const component = panel.closest('[data-nv-component]');
    const target = panel.querySelector('[data-nv-ai-stream]');
    if (!component || !target) return;
    const state: Active = { target, cancelled: false };
    active.set(panel, state);
    panel.setAttribute('aria-busy', 'true');
    setCancel(panel, true);
    setStatus(panel, 'streaming');
    let outcome: Outcome = 'done';
    try {
      await client.startStream(target);
    } catch {
      outcome = state.cancelled ? 'cancelled' : 'failed';
    }
    if (active.get(panel) === state) active.delete(panel);
    panel.removeAttribute('aria-busy');
    setCancel(panel, false);
    setStatus(panel, outcome);
    if (disposed || !component.isConnected) return;
    // Exactly one collect per turn; failures surface through the Live client.
    try {
      await client.call(component, collect);
    } catch {
      if (panel.isConnected) setStatus(panel, 'failed');
    }
  }

  function check(): void {
    if (disposed) return;
    for (const panel of panels()) {
      if (panel.getAttribute('data-nv-ai-turn') !== 'ready') continue;
      const turn = panel.getAttribute('data-nv-ai-turn-id');
      if (!turn || !turnPattern.test(turn) || started.has(turn)) continue;
      if (active.has(panel)) continue;
      started.add(turn);
      void run(panel);
    }
  }

  function onClick(event: Event): void {
    const source = event.target;
    if (!(source instanceof Element)) return;
    const button = source.closest('[data-nv-ai-cancel]');
    if (!button || !root.contains(button)) return;
    const panel = button.closest('[data-nv-ai]');
    const state = panel ? active.get(panel) : undefined;
    if (!state) return;
    event.preventDefault();
    state.cancelled = true;
    client.cancelStream(state.target);
  }
  function onUpdated(): void {
    check();
  }

  root.addEventListener('click', onClick);
  document.addEventListener('nestvexa:updated', onUpdated);
  check();
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('click', onClick);
      document.removeEventListener('nestvexa:updated', onUpdated);
      for (const state of active.values()) {
        state.cancelled = true;
        client.cancelStream(state.target);
      }
      active.clear();
    },
  };
}
