import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export interface DataRootValidationContext {
  currentDataRoot: string
  defaultDataRoot: string
  installRoot: string
  windowsRoot?: string
  programFilesRoots?: string[]
}

export type DataRootValidationResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

export interface DataRootCopyReport {
  copiedFiles: string[]
  skippedFiles: string[]
}

const configFileName = 'data-root.json'
const volatileDirectoryNames = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'shadercache',
  'crashpad',
  'crash reports',
  'updaterdownloads',
  'updaterlogs',
  'temp',
  'tmp'
])

export function stableConfigRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'Vast')
}

export function dataPathConfigFile(configRoot: string): string {
  return join(configRoot, configFileName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function readConfiguredDataRoot(configRoot: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(dataPathConfigFile(configRoot), 'utf8')) as unknown
    if (!isRecord(parsed) || typeof parsed.customDataRoot !== 'string') return undefined
    const trimmed = parsed.customDataRoot.trim()
    return trimmed ? resolve(trimmed) : undefined
  } catch {
    return undefined
  }
}

export async function writeConfiguredDataRoot(configRoot: string, customDataRoot: string): Promise<void> {
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    dataPathConfigFile(configRoot),
    `${JSON.stringify({ customDataRoot: resolve(customDataRoot), updatedAt: Date.now() }, null, 2)}\n`,
    'utf8'
  )
}

export async function clearConfiguredDataRoot(configRoot: string): Promise<void> {
  await rm(dataPathConfigFile(configRoot), { force: true })
}

function sameOrInside(childPath: string, parentPath: string): boolean {
  const child = resolve(childPath)
  const parent = resolve(parentPath)
  if (child === parent) return true
  const rel = relative(parent, child)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function defaultProgramFilesRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramW6432
  ].filter((value): value is string => Boolean(value))
}

async function resolveExistingOrCreatableDirectory(candidate: string): Promise<string> {
  await mkdir(candidate, { recursive: true })
  return realpath(candidate)
}

export async function validateDataRootCandidate(
  candidate: string,
  context: DataRootValidationContext
): Promise<DataRootValidationResult> {
  const trimmed = typeof candidate === 'string' ? candidate.trim() : ''
  if (!trimmed) return { ok: false, error: 'Choose a Vast data directory.' }
  const resolved = resolve(trimmed)
  const root = parse(resolved).root
  if (resolved === root) return { ok: false, error: 'Vast data cannot be stored at a drive or filesystem root.' }

  const windowsRoot = resolve(context.windowsRoot || process.env.SystemRoot || join(root, 'Windows'))
  if (sameOrInside(resolved, windowsRoot)) return { ok: false, error: 'Vast data cannot be stored inside the Windows system directory.' }

  for (const programFilesRoot of context.programFilesRoots ?? defaultProgramFilesRoots()) {
    if (sameOrInside(resolved, programFilesRoot)) {
      return { ok: false, error: 'Vast data cannot be stored inside Program Files.' }
    }
  }

  if (sameOrInside(resolved, context.installRoot)) {
    return { ok: false, error: 'Vast data cannot be stored inside the application install directory.' }
  }
  if (sameOrInside(resolved, context.currentDataRoot)) {
    return { ok: false, error: 'The new data directory cannot be inside the active Vast data directory.' }
  }

  try {
    const real = await resolveExistingOrCreatableDirectory(resolved)
    const probe = join(real, `.vast-write-test-${process.pid}-${Date.now()}`)
    await writeFile(probe, 'ok', 'utf8')
    await rm(probe, { force: true })
    return { ok: true, path: real }
  } catch (error) {
    return {
      ok: false,
      error: `Vast could not create or write to that directory: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export function normalizeArchivePath(pathname: string): string {
  return pathname.split(sep).join('/')
}

export function shouldSkipDataFile(relativePath: string): boolean {
  const normalized = normalizeArchivePath(relativePath)
  const parts = normalized.split('/').filter(Boolean)
  return parts.some((part) => volatileDirectoryNames.has(part.toLowerCase()))
}

async function copyDirectoryContents(sourceRoot: string, targetRoot: string, report: DataRootCopyReport, relativeRoot = ''): Promise<void> {
  const sourceDirectory = relativeRoot ? join(sourceRoot, relativeRoot) : sourceRoot
  const entries = await readdir(sourceDirectory)
  for (const entry of entries) {
    const relativePath = relativeRoot ? join(relativeRoot, entry) : entry
    const normalized = normalizeArchivePath(relativePath)
    if (shouldSkipDataFile(relativePath)) {
      const sourcePath = join(sourceRoot, relativePath)
      const info = await lstat(sourcePath).catch(() => undefined)
      if (info?.isDirectory()) await collectSkippedFiles(sourceRoot, relativePath, report)
      else report.skippedFiles.push(normalized)
      continue
    }
    const sourcePath = join(sourceRoot, relativePath)
    const info = await lstat(sourcePath)
    if (info.isSymbolicLink()) {
      report.skippedFiles.push(normalized)
      continue
    }
    const targetPath = join(targetRoot, relativePath)
    if (info.isDirectory()) {
      await mkdir(targetPath, { recursive: true })
      await copyDirectoryContents(sourceRoot, targetRoot, report, relativePath)
    } else if (info.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true })
      await copyFile(sourcePath, targetPath)
      report.copiedFiles.push(normalized)
    }
  }
}

async function collectSkippedFiles(sourceRoot: string, relativeRoot: string, report: DataRootCopyReport): Promise<void> {
  const sourcePath = join(sourceRoot, relativeRoot)
  const info = await lstat(sourcePath).catch(() => undefined)
  const normalized = normalizeArchivePath(relativeRoot)
  if (!info) return
  if (info.isDirectory()) {
    const entries = await readdir(sourcePath).catch(() => [])
    if (entries.length === 0) report.skippedFiles.push(normalized)
    for (const entry of entries) await collectSkippedFiles(sourceRoot, join(relativeRoot, entry), report)
    return
  }
  report.skippedFiles.push(normalized)
}

export async function copyDataRootForMigration(sourceRoot: string, targetRoot: string): Promise<DataRootCopyReport> {
  const source = await realpath(sourceRoot)
  const target = resolve(targetRoot)
  if (sameOrInside(target, source) || sameOrInside(source, target)) {
    throw new Error('Data directory migration source and target must not contain each other.')
  }
  await mkdir(target, { recursive: true })
  const report: DataRootCopyReport = { copiedFiles: [], skippedFiles: [] }
  await copyDirectoryContents(source, target, report)
  report.copiedFiles.sort()
  report.skippedFiles.sort()
  return report
}
