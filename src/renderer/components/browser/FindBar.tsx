import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useBrowserRuntime } from '../../app/browser-runtime'
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

  useEffect(() => {
    if (findOpen) inputRef.current?.focus()
  }, [findOpen])

  if (!findOpen) return null

  const runFind = (nextQuery = query, forward = true, findNext = false): void => {
    setActiveFindQuery(nextQuery)
    if (nextQuery.trim()) runtime.findInPage(nextQuery, { forward, findNext })
  }

  return (
    <div className="no-drag absolute right-4 top-4 z-40 flex items-center gap-2 rounded-2xl border border-white/10 bg-[#0d0e13]/95 p-2 shadow-glass backdrop-blur-xl">
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
        className="h-9 w-64 rounded-xl border border-white/10 bg-white/[0.06] px-3 text-sm text-white outline-none placeholder:text-vast-soft focus:border-vast-cyan/40"
      />
      <div className="min-w-[4.5rem] text-center text-xs text-vast-soft">
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
