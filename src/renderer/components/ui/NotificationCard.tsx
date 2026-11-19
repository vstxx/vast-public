import type { ComponentPropsWithRef } from 'react'

export function NotificationCard({ className = '', ...props }: ComponentPropsWithRef<'div'>): JSX.Element {
  return <div {...props} className={`vast-notification-card ${className}`.trim()} />
}
