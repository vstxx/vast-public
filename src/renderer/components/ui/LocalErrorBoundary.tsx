import { Component, type ErrorInfo, type ReactNode } from 'react'
import { NotificationCard } from './NotificationCard'

interface LocalErrorBoundaryProps {
  children: ReactNode
  name: string
  overlay?: boolean
  onDismiss?: () => void
}

interface LocalErrorBoundaryState {
  error?: Error
}

export class LocalErrorBoundary extends Component<LocalErrorBoundaryProps, LocalErrorBoundaryState> {
  state: LocalErrorBoundaryState = {}

  static getDerivedStateFromError(error: Error): LocalErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[renderer] ${this.props.name} failed:`, error, info)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        className={this.props.overlay
          ? 'fixed right-5 top-20 z-[2147483646] w-[min(25rem,calc(100vw-2.5rem))]'
          : 'grid h-full min-h-0 w-full place-items-center bg-[#07080b] p-5'}
        role="alert"
      >
        <NotificationCard className="border border-red-300/15 bg-[#101116] text-white shadow-lg">
          <div className="text-sm font-semibold">{this.props.name} encountered an error</div>
          <p className="mt-2 break-words text-[13px] leading-5 text-vast-soft">{error.message || 'An unexpected rendering error occurred.'}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="rounded-xl border border-white/10 bg-white/[0.07] px-3 py-2 text-[13px] font-medium hover:bg-white/[0.11]"
              onClick={() => this.setState({ error: undefined })}
            >
              Try again
            </button>
            {this.props.onDismiss && (
              <button
                className="rounded-xl border border-white/[0.07] px-3 py-2 text-[13px] text-vast-soft hover:bg-white/[0.06] hover:text-white"
                onClick={this.props.onDismiss}
              >
                Dismiss
              </button>
            )}
          </div>
        </NotificationCard>
      </div>
    )
  }
}
