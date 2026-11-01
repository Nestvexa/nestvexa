import { LiveClientError } from './grammar.js';

/** `nv:navigate` or `nv:navigate.hover` (prefetch on hover/focus). */
export interface NavigateDirective {
  readonly kind: 'navigate';
  readonly prefetch: boolean;
  readonly value: '';
}
export function parseNavigateDirective(
  name: string,
  value: string,
): NavigateDirective {
  if ((name !== 'nv:navigate' && name !== 'nv:navigate.hover') || value !== '')
    throw new LiveClientError(
      'DIRECTIVE',
      'Use an empty nv:navigate or nv:navigate.hover on a same-origin link',
    );
  return { kind: 'navigate', prefetch: name === 'nv:navigate.hover', value };
}

export interface NavigationOptions {
  readonly window: Window & typeof globalThis;
  readonly fetch: typeof fetch;
  /** True when Live components hold unsaved local edits. */
  readonly hasUnsavedChanges: () => boolean;
  readonly confirmLeave: (message: string) => boolean;
  readonly onError: (error: unknown) => void;
  /** Called after a successful document swap. */
  readonly onNavigated?: (url: string) => void;
  readonly maxBytes?: number;
}
export interface NavigationController {
  /** Visit a same-origin path through a document swap, or fall back to a full load. */
  visit(url: string, options?: { readonly replace?: boolean }): Promise<void>;
  dispose(): void;
}

const historyMarker = 'nestvexaNavigate';
const prefetchLifetime = 10_000;
const maxPrefetch = 8;

interface Prefetched {
  readonly at: number;
  readonly response: Promise<{ url: string; html: string } | null>;
}

/** Scripts and stylesheets that make up a document's executable/asset identity. */
function assetSignature(doc: Document): string {
  const parts: string[] = [];
  for (const element of doc.querySelectorAll(
    'script, link[rel~="stylesheet"], link[rel="modulepreload"]',
  )) {
    if (element.tagName === 'SCRIPT') {
      const source = element.getAttribute('src');
      // Inline scripts never run after a swap; their presence forces a full load.
      parts.push(
        source === null ? 'inline:' + element.textContent : 'script:' + source,
      );
    } else parts.push('link:' + (element.getAttribute('href') ?? ''));
  }
  return parts.sort().join('\n');
}

export function createNavigationController(
  options: NavigationOptions,
): NavigationController {
  const { window } = options;
  const doc = window.document;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const prefetched = new Map<string, Prefetched>();
  let active: AbortController | undefined;
  let disposed = false;

  function sameOrigin(url: URL): boolean {
    return (
      url.origin === window.location.origin &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    );
  }
  function full(url: string): void {
    window.location.assign(url);
  }
  async function load(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; html: string } | null> {
    const response = await options.fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { accept: 'text/html', 'x-nestvexa-navigate': '1' },
      ...(signal ? { signal } : {}),
    });
    const final = new URL(response.url || url, window.location.href);
    const type = response.headers.get('content-type') ?? '';
    if (
      !response.ok ||
      !sameOrigin(final) ||
      !/^text\/html(?:\s*;|$)/i.test(type)
    )
      return null;
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > maxBytes) return null;
    const html = await response.text();
    if (html.length > maxBytes) return null;
    return { url: final.href, html };
  }
  function remember(): void {
    const state: unknown = window.history.state;
    const base =
      state && typeof state === 'object' && !Array.isArray(state)
        ? (state as Record<string, unknown>)
        : {};
    window.history.replaceState(
      {
        ...base,
        [historyMarker]: true,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      '',
    );
  }
  function swap(
    incoming: Document,
    url: string,
    mode: 'push' | 'replace' | 'pop',
    scroll?: { x: number; y: number },
  ): boolean {
    if (assetSignature(incoming) !== assetSignature(doc)) return false;
    if (
      incoming.documentElement.getAttribute('lang') !==
        doc.documentElement.getAttribute('lang') ||
      incoming.documentElement.getAttribute('dir') !==
        doc.documentElement.getAttribute('dir')
    )
      return false;
    const body = incoming.body;
    // Parsed documents never execute scripts; strip them before adoption.
    for (const script of body.querySelectorAll('script')) script.remove();
    window.dispatchEvent(
      new window.CustomEvent('nestvexa:navigate', { detail: { url } }),
    );
    if (mode === 'push')
      window.history.pushState({ [historyMarker]: true }, '', url);
    else if (mode === 'replace')
      window.history.replaceState({ [historyMarker]: true }, '', url);
    doc.title = incoming.title;
    const description = incoming.querySelector('meta[name="description"]');
    const current = doc.querySelector('meta[name="description"]');
    if (description && current)
      current.setAttribute(
        'content',
        description.getAttribute('content') ?? '',
      );
    for (const attribute of [...doc.body.attributes])
      doc.body.removeAttribute(attribute.name);
    for (const attribute of body.attributes)
      doc.body.setAttribute(attribute.name, attribute.value);
    doc.body.replaceChildren(
      ...[...body.childNodes].map((node) => doc.adoptNode(node)),
    );
    const target = new URL(url).hash
      ? doc.getElementById(decodeURIComponent(new URL(url).hash.slice(1)))
      : null;
    if (scroll) window.scrollTo(scroll.x, scroll.y);
    else if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
    const focusTarget =
      doc.querySelector('main') ?? doc.querySelector('h1') ?? doc.body;
    if (focusTarget instanceof window.HTMLElement) {
      if (!focusTarget.hasAttribute('tabindex'))
        focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
    }
    options.onNavigated?.(url);
    window.dispatchEvent(
      new window.CustomEvent('nestvexa:navigated', { detail: { url } }),
    );
    return true;
  }
  async function visit(
    url: string,
    mode: 'push' | 'replace' | 'pop',
    scroll?: { x: number; y: number },
  ): Promise<void> {
    const target = new URL(url, window.location.href);
    if (!sameOrigin(target)) {
      full(target.href);
      return;
    }
    if (
      mode !== 'pop' &&
      options.hasUnsavedChanges() &&
      !options.confirmLeave('Leave this page? Unsaved changes will be lost.')
    )
      return;
    active?.abort();
    const abort = new AbortController();
    active = abort;
    doc.documentElement.setAttribute('aria-busy', 'true');
    try {
      const cached = prefetched.get(target.href);
      prefetched.delete(target.href);
      const loaded =
        cached && Date.now() - cached.at < prefetchLifetime
          ? await cached.response
          : await load(target.href, abort.signal);
      if (abort.signal.aborted || disposed) return;
      if (!loaded) {
        full(target.href);
        return;
      }
      const incoming = new window.DOMParser().parseFromString(
        loaded.html,
        'text/html',
      );
      if (mode !== 'pop') remember();
      if (!swap(incoming, loaded.url, mode, scroll)) full(loaded.url);
    } catch (error) {
      if (abort.signal.aborted) return;
      options.onError(error);
      full(target.href);
    } finally {
      if (active === abort) {
        active = undefined;
        doc.documentElement.removeAttribute('aria-busy');
      }
    }
  }
  function link(event: Event): HTMLAnchorElement | null {
    const target = event.target;
    if (!(target instanceof window.Element)) return null;
    const anchor = target.closest('a');
    if (
      !(anchor instanceof window.HTMLAnchorElement) ||
      (!anchor.hasAttribute('nv:navigate') &&
        !anchor.hasAttribute('nv:navigate.hover'))
    )
      return null;
    for (const attribute of anchor.attributes)
      if (attribute.name.startsWith('nv:navigate'))
        parseNavigateDirective(attribute.name, attribute.value);
    return anchor;
  }
  function click(event: MouseEvent): void {
    try {
      const anchor = link(event);
      if (
        !anchor ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (anchor.target && anchor.target !== '_self') ||
        anchor.hasAttribute('download')
      )
        return;
      const url = new URL(anchor.href, window.location.href);
      if (!sameOrigin(url)) return;
      // In-page fragment links keep native behavior.
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search &&
        url.hash
      )
        return;
      event.preventDefault();
      void visit(url.href, 'push');
    } catch (error) {
      options.onError(error);
    }
  }
  function prefetch(event: Event): void {
    try {
      const anchor = link(event);
      if (!anchor?.hasAttribute('nv:navigate.hover')) return;
      const url = new URL(anchor.href, window.location.href);
      if (!sameOrigin(url) || prefetched.has(url.href)) return;
      for (const [key, entry] of prefetched)
        if (Date.now() - entry.at >= prefetchLifetime) prefetched.delete(key);
      if (prefetched.size >= maxPrefetch) return;
      prefetched.set(url.href, {
        at: Date.now(),
        response: load(url.href).catch(() => null),
      });
    } catch (error) {
      options.onError(error);
    }
  }
  function popstate(event: PopStateEvent): void {
    const state: unknown = event.state;
    if (
      !state ||
      typeof state !== 'object' ||
      Reflect.get(state, historyMarker) !== true
    )
      return;
    const x = Number(Reflect.get(state, 'scrollX') ?? 0);
    const y = Number(Reflect.get(state, 'scrollY') ?? 0);
    void visit(window.location.href, 'pop', {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    });
  }
  doc.addEventListener('click', click);
  doc.addEventListener('pointerenter', prefetch, true);
  doc.addEventListener('focusin', prefetch);
  window.addEventListener('popstate', popstate);
  return {
    visit: (url, visitOptions = {}) =>
      visit(url, visitOptions.replace ? 'replace' : 'push'),
    dispose(): void {
      disposed = true;
      active?.abort();
      prefetched.clear();
      doc.removeEventListener('click', click);
      doc.removeEventListener('pointerenter', prefetch, true);
      doc.removeEventListener('focusin', prefetch);
      window.removeEventListener('popstate', popstate);
    },
  };
}
