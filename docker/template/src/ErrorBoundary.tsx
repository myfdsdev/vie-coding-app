import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Without this, a render error is a blank white page and window.onerror gives
 * the agent no component stack. componentDidCatch is the only place the
 * component stack exists.
 *
 * Do not remove. The builder injects and relies on this.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      parent.postMessage(
        {
          __preview_event: true,
          ts: Date.now(),
          type: 'REACT_RENDER_ERROR',
          message: error.message,
          stack: error.stack,
          componentStack: info.componentStack,
        },
        '*',
      );
    } catch {
      /* preview not framed */
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#3f3f46' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>This screen hit an error.</p>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: '#71717a' }}>
            The builder has been notified and is fixing it.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
