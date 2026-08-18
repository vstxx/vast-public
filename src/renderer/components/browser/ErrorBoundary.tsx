import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryState {
  error?: Error
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {}

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] Unhandled UI error:', error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen items-center justify-center bg-vast-black text-vast-bright">
          <div className="max-w-lg rounded-2xl border border-white/10 bg-white/[0.06] p-7 shadow-glass">
            <div className="text-sm uppercase tracking-[0.2em] text-vast-cyan">Vast recovered</div>
            <h1 className="mt-3 text-2xl font-semibold">The browser chrome hit an error.</h1>
            <p className="mt-3 text-sm leading-6 text-vast-soft">{this.state.error.message}</p>
            <button
              className="mt-5 rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15"
              onClick={() => location.reload()}
            >
              Reload Vast
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
