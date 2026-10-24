import { nativeImage } from 'electron'
import { app, dialog } from 'electron/main'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../atomic-file'
import { dataFilePath } from '../data-path'
import { clearNewTabBackground, inspectNewTabBackground, readNewTabBackground, writeNewTabBackground } from '../new-tab-background'
import type { VisualProfileImageTools, VisualProfileLibrary } from '../visual-profile-library'
import { fail, type IpcHandle, type SenderWindowFor } from './registration'

// Long edge of the New Tab image copy kept with a profile: sharp on 4K screens,
// small enough that a profile stays portable.
const PROFILE_IMAGE_MAX_EDGE = 3840

// The profile code loads on first use; startup never needs it.
const profileModules = () => Promise.all([import('../visual-profile-library'), import('../../shared/visual-profile')])
type ProfileFormat = Awaited<ReturnType<typeof profileModules>>[1]

const imageTools = ({ VISUAL_PROFILE_MAX_IMAGE_BYTES }: ProfileFormat): VisualProfileImageTools => ({
  inspect: (bytes) => inspectNewTabBackground(bytes),
  prepare(bytes) {
    const type = inspectNewTabBackground(bytes)
    const image = nativeImage.createFromBuffer(bytes)
    const { width, height } = image.getSize()
    const scale = Math.min(1, PROFILE_IMAGE_MAX_EDGE / Math.max(width, height))
    if (scale === 1 && bytes.length <= VISUAL_PROFILE_MAX_IMAGE_BYTES) return { bytes, type }
    const resized = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : image
    for (const quality of [88, 76, 64]) {
      const encoded = resized.toJPEG(quality)
      if (encoded.length <= VISUAL_PROFILE_MAX_IMAGE_BYTES) return { bytes: encoded, type: 'image/jpeg' }
    }
    throw new Error('The New Tab image is too large to save in a profile.')
  }
})

let library: Promise<VisualProfileLibrary> | undefined
let libraryDirectory = ''

// Created on first use and recreated if the Vast data directory moved.
// Concurrent first calls share one library.
function profiles(): Promise<VisualProfileLibrary> {
  const directory = dataFilePath('visual-profiles')
  if (!library || directory !== libraryDirectory) {
    libraryDirectory = directory
    const created = profileModules().then(([{ createVisualProfileLibrary }, format]) => createVisualProfileLibrary({
      directory,
      images: imageTools(format),
      background: { read: readNewTabBackground, write: writeNewTabBackground, clear: clearNewTabBackground }
    }))
    created.catch(() => { if (library === created) library = undefined })
    library = created
  }
  return library
}

function exportFileName(name: string, extension: string): string {
  const base = name.replace(/[<>:"/\\|?*]/g, '').replace(/[. ]+$/, '').trim() || 'Visual profile'
  return `${base}.${extension}`
}

const fileFilters = (extension: string) => [{ name: 'Vast visual profile', extensions: [extension] }]

export function registerVisualProfilesIpc(handle: IpcHandle, senderWindowFor: SenderWindowFor): void {
  const respond = <T extends object>(operation: () => Promise<T>) => operation().then((result) => ({ ok: true as const, ...result }), fail)

  handle('vast:visual-profiles:list', () => respond(async () => (await profiles()).list()))
  handle('vast:visual-profiles:save', (_event, name: unknown, values: unknown) => respond(async () => (await profiles()).save(name, values)))
  handle('vast:visual-profiles:update', (_event, id: unknown, values: unknown) => respond(async () => (await profiles()).update(id, values)))
  handle('vast:visual-profiles:rename', (_event, id: unknown, name: unknown) => respond(async () => (await profiles()).rename(id, name)))
  handle('vast:visual-profiles:remove', (_event, id: unknown) => respond(async () => (await profiles()).remove(id)))
  handle('vast:visual-profiles:set-applied', (_event, id: unknown) => respond(async () => (await profiles()).setApplied(id)))
  handle('vast:visual-profiles:apply-image', (_event, id: unknown) => respond(async () => (await profiles()).applyImage(id)))
  handle('vast:visual-profiles:restore-image', () => respond(async () => (await profiles()).restoreImage()))

  handle('vast:visual-profiles:export', (event, id: unknown) => respond(async () => {
    const [, { VISUAL_PROFILE_EXTENSION }] = await profileModules()
    const { name, text } = await (await profiles()).exportDocument(id)
    const result = await dialog.showSaveDialog(senderWindowFor(event), {
      title: 'Export visual profile',
      defaultPath: join(app.getPath('documents'), exportFileName(name, VISUAL_PROFILE_EXTENSION)),
      filters: fileFilters(VISUAL_PROFILE_EXTENSION)
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const target = result.filePath.toLowerCase().endsWith(`.${VISUAL_PROFILE_EXTENSION}`) ? result.filePath : `${result.filePath}.${VISUAL_PROFILE_EXTENSION}`
    await atomicWriteFile(target, text)
    return { canceled: false }
  }))

  handle('vast:visual-profiles:import', (event) => respond(async () => {
    const [, { VISUAL_PROFILE_EXTENSION, VISUAL_PROFILE_MAX_FILE_BYTES }] = await profileModules()
    const result = await dialog.showOpenDialog(senderWindowFor(event), {
      title: 'Import visual profile',
      properties: ['openFile'],
      filters: fileFilters(VISUAL_PROFILE_EXTENSION)
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return { canceled: true }
    // Size is checked before anything is read or parsed.
    const info = await stat(path)
    if (!info.isFile()) throw new Error('Choose a visual profile file.')
    if (info.size > VISUAL_PROFILE_MAX_FILE_BYTES) throw new Error('This file is too large to be a visual profile.')
    return { canceled: false, ...await (await profiles()).importDocument(await readFile(path, 'utf8')) }
  }))
}
