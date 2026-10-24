import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

type ComponentModule<Props> = { default: ComponentType<Props> }

export interface Preloadable<Props> {
  Component: LazyExoticComponent<ComponentType<Props>>
  /** Starts loading the module; safe to call repeatedly. */
  preload: () => Promise<void>
}

/**
 * A lazy component whose module can be loaded ahead of first use.
 *
 * Once preloaded, the lazy loader hands React a thenable that resolves
 * synchronously, so the first render returns the component directly instead
 * of suspending. A suspended first render shows the Suspense fallback, and
 * React 19 then holds the reveal for up to 300 ms. Opening before the preload
 * finishes behaves exactly like a plain lazy() component.
 */
export function preloadable<Props>(load: () => Promise<ComponentModule<Props>>): Preloadable<Props> {
  let loaded: ComponentModule<Props> | undefined
  let pending: Promise<ComponentModule<Props>> | undefined
  const ensureLoaded = (): Promise<ComponentModule<Props>> => {
    pending ??= load().then(
      (module) => (loaded = module),
      (error: unknown) => {
        // Let a later preload or the first render retry the import.
        pending = undefined
        throw error
      }
    )
    return pending
  }
  const Component = lazy(() => {
    const module = loaded
    if (!module) return ensureLoaded()
    return { then: (resolve: (value: ComponentModule<Props>) => void) => resolve(module) } as Promise<ComponentModule<Props>>
  })
  return { Component, preload: () => ensureLoaded().then(() => undefined) }
}
