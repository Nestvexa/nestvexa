import { Component, createElement } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/** Fallback content, or a function of the caught error and a reset callback. */
export type ErrorFallback =
  ReactNode | ((error: unknown, reset: () => void) => ReactNode);

export interface ErrorBoundaryProps {
  readonly children?: ReactNode;
  readonly fallback?: ErrorFallback;
  /** Observes caught render errors. Must not throw. */
  readonly onError?: (error: unknown, info: ErrorInfo) => void;
  /** Changing this value clears a caught error (pass the page URL to reset per visit). */
  readonly resetKey?: unknown;
}

interface ErrorBoundaryState {
  readonly error: unknown;
  readonly failed: boolean;
  readonly resetKey: unknown;
}

/** Accessible default fallback: an alert with a full-reload link. */
export function DefaultErrorFallback(): ReactNode {
  return createElement(
    'div',
    { role: 'alert', 'data-nestvexa-error': 'render' },
    createElement('p', null, 'Something went wrong while rendering this page.'),
    createElement('a', { href: '' }, 'Reload the page'),
  );
}

/**
 * React error boundary for Inertia pages. Client-only by React's design: during
 * SSR an error propagates to the renderer, and `@nestvexa/inertia` then serves
 * the client-rendered document (fallback mode) where this boundary applies.
 * The error itself is never rendered.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = {
    error: undefined,
    failed: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error, failed: true };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey)
      ? null
      : { error: undefined, failed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      this.props.onError?.(error, info);
    } catch {
      // Observers must not break the fallback.
    }
  }

  readonly reset = (): void => {
    this.setState({ error: undefined, failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === 'function')
      return fallback(this.state.error, this.reset);
    return fallback === undefined
      ? createElement(DefaultErrorFallback)
      : fallback;
  }
}
