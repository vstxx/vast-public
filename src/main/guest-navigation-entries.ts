/** A tab's committed main-frame navigation, as the main process last reported it. */
export interface CommittedEntry {
  /** URL of the last cross-document commit: the page the user actually opened. */
  documentUrl: string
  url: string
  length: number
  index: number
}

/**
 * Map viewers and similar apps call history.replaceState many times a second
 * (Google Earth rewrites its camera into the URL while the globe moves). Each
 * one used to become its own history entry and, with history capped, pushed
 * real history out. A same-document navigation that left the session history
 * the same length at the same index replaced the current entry; when that entry
 * itself came from such a replacement, the history entry for it is replaced
 * too. The URL the page was opened at is never replaced, so a page leaves at
 * most two entries: where it was opened and where it ended up.
 */
export function replacedEntryUrl(previous: CommittedEntry | undefined, next: Omit<CommittedEntry, 'documentUrl'>): string | undefined {
  if (!previous || previous.url === next.url || previous.url === previous.documentUrl) return undefined
  return previous.length === next.length && previous.index === next.index ? previous.url : undefined
}
