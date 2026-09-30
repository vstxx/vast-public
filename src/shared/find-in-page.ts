/**
 * Electron 44.3.0 copies the `findNext` option into Chromium's `new_session`
 * field. Those meanings are opposite. Keep this adapter local to the pinned
 * runtime so the first query starts a session and Enter advances that session.
 */
export function electronFindOptions(options: { forward?: boolean; findNext?: boolean } = {}): {
  forward: boolean
  findNext: boolean
} {
  return {
    forward: options.forward !== false,
    findNext: options.findNext !== true
  }
}
