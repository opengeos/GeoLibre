import * as React from "react";

export interface ErrorBoundaryFallbackProps {
  /** The error that was thrown by a descendant during render. */
  error: Error;
  /** Clears the error and re-renders the boundary's children. */
  reset: () => void;
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Rendered in place of the children once a descendant throws. */
  fallback: (props: ErrorBoundaryFallbackProps) => React.ReactNode;
  /** Called when a descendant throws, after the fallback is shown. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /**
   * When any value in this array changes between renders, the boundary clears
   * its captured error and re-renders its children. Use it to recover
   * automatically when the inputs that caused the crash change (for example a
   * different selected layer).
   *
   * Note: adding or removing the prop entirely (undefined ↔ non-empty array)
   * also counts as a change and will trigger a reset. Absent and empty (`[]`)
   * are treated as equivalent, so toggling between those two does not reset.
   */
  resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * A generic React error boundary. It catches render-time errors thrown by its
 * descendants, renders a caller-supplied fallback in their place, and reports
 * the error through `onError`. It is deliberately presentation-agnostic so each
 * call site can supply an appropriate fallback (full-screen recovery, compact
 * inline notice, etc.).
 *
 * Note: error boundaries only catch errors thrown during React rendering,
 * lifecycle methods, and constructors of descendants. They do not catch errors
 * in event handlers, asynchronous code, or imperative (non-React) code.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error === null) return;
    if (!resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) return;
    this.reset();
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error !== null) {
      return this.props.fallback({ error, reset: this.reset });
    }
    return this.props.children;
  }
}

export function resetKeysChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (prev === next) return false;
  // Treat absent and empty the same: no keys means no automatic resets, so a
  // transition between `undefined` and `[]` must not trigger one.
  if ((!prev || prev.length === 0) && (!next || next.length === 0)) return false;
  if (!prev || !next || prev.length !== next.length) return true;
  for (let index = 0; index < prev.length; index += 1) {
    if (!Object.is(prev[index], next[index])) return true;
  }
  return false;
}
