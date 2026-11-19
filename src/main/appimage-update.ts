import { accessSync, chmodSync, closeSync, constants, copyFileSync, fsyncSync, openSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

// Linux self-update for the AppImage build. The update replaces the file Vast
// was started from, at the same path and name, so desktop entries written by
// Gear Lever, AppImageLauncher or by hand keep working, and an external
// manager that compares the file with the release asset sees it as current.

/** Why the running AppImage cannot update itself, or null when it can. */
export function appImageUpdateBlocker(appImage: string | undefined): string | null {
  if (!appImage) return 'Vast was not started from its AppImage. Update it the same way it was installed.'
  if (!isAbsolute(appImage) || appImage.includes('\0')) return 'The AppImage location reported at startup is invalid.'
  try {
    const target = realpathSync(appImage)
    if (!statSync(target).isFile()) return 'The AppImage location reported at startup is not a file.'
    accessSync(target, constants.W_OK)
    accessSync(dirname(target), constants.W_OK)
  } catch {
    return 'The AppImage or its folder is not writable. Move Vast to a folder you own, such as ~/Applications, or update it with your AppImage manager.'
  }
  return null
}

/**
 * Atomically replaces the AppImage at `appImage` with the verified download.
 * The new file is staged next to the target and renamed over it, so the
 * original stays intact until the rename and is never missing. The running
 * instance keeps its open (unlinked) image until it exits.
 */
export function replaceAppImageInPlace(appImage: string, downloaded: string): string {
  if (!isAbsolute(appImage) || appImage.includes('\0')) throw new Error('The AppImage path is not absolute.')
  const target = realpathSync(appImage)
  const current = statSync(target)
  if (!current.isFile()) throw new Error('The AppImage path is not a file.')
  if (!statSync(downloaded).isFile()) throw new Error('The downloaded update is missing.')
  const staged = join(dirname(target), `.${basename(target)}.update-${process.pid}`)
  try {
    copyFileSync(downloaded, staged)
    // Keep the user's permission bits; the owner must still be able to run it.
    chmodSync(staged, (current.mode & 0o777) | 0o500)
    const fd = openSync(staged, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(staged, target)
  } catch (error) {
    rmSync(staged, { force: true })
    throw error
  }
  rmSync(downloaded, { force: true })
  return target
}
