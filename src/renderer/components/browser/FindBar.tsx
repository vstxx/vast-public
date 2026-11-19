import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { focusWhenReady, usePresence } from '../../lib/motion'
import { useBrowserStore } from '../../store/browser-store'
import { IconButton } from '../ui/IconButton'

export function FindBar(): JSX.Element | null {
  const runtime = useBrowserRuntime()
  const findOpen = useBrowserStore((state) => state.findOpen)
  const setFindOpen = useBrowserStore((state) => state.setFindOpen)
  const setActiveFindQuery = useBrowserStore((state) => state.setActiveFindQuery)
  const findResult = useBrowserStore((state) => state.findResult)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const presence = usePresence(findOpen)

  // Focus before the first paint so typing never waits for the reveal.
  useLayoutEffect(() => {
    if (findOpen) focusWhenReady(inputRef.current)
  }, [findOpen, presence.mounted])

  if (!presence.mounted) return null

  const runFind = (nextQuery = query, forward = true, findNext = false): void => {
    setActiveFindQuery(nextQuery)
    if (nextQuery.trim()) runtime.findInPage(nextQuery, { forward, findNext })
  }

  return (
    <div ref={presence.ref('find')} className="no-drag absolute right-4 top-4 z-40 flex origin-top-right items-center gap-2 vast-float rounded-card border border-white/10 p-2 shadow-glass">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          runFind(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            runtime.stopFindInPage()
            setFindOpen(false)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            runFind(query, !event.shiftKey, true)
          }
        }}
        placeholder="Find in page"
        className="h-9 w-64 rounded-control border border-white/10 bg-white/6 px-3 text-sm text-white outline-hidden placeholder:text-vast-soft focus:border-vast-cyan/40"
      />
      <div className="min-w-18 text-center text-xs text-vast-soft">
        {findResult.matches > 0 ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : '0/0'}
      </div>
      <IconButton tooltip="Previous match" disabled={!query.trim()} onClick={() => runFind(query, false, true)}>
        <ChevronUp className="h-4 w-4" />
      </IconButton>
      <IconButton tooltip="Next match" disabled={!query.trim()} onClick={() => runFind(query, true, true)}>
        <ChevronDown className="h-4 w-4" />
      </IconButton>
      <IconButton
        tooltip="Close find"
        onClick={() => {
          runtime.stopFindInPage()
          setFindOpen(false)
        }}
      >
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  )
}
