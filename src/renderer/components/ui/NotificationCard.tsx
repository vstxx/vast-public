import type { HTMLAttributes } from 'react'

export function NotificationCard({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div {...props} className={`vast-notification-card ${className}`.trim()} />
}
