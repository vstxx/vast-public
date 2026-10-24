/**
 * The Settings nav highlight changes many times while the page scrolls. Keeping
 * it outside React state lets only the nav re-render, not the whole modal.
 */
export interface ActiveSectionStore<T extends string> {
  get: () => T
  set: (value: T) => void
  subscribe: (listener: () => void) => () => void
}

export function createActiveSectionStore<T extends string>(initial: T): ActiveSectionStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
