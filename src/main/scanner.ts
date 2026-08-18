/**
 * Download scanner — runs heuristic and optional OS-level checks on completed
 * downloads and alerts the user if anything suspicious is found.
 *
 * The scan never blocks or cancels a download. It runs asynchronously after
 * the file has been saved, then shows a non-blocking warning dialog.
 */

import type { BrowserWindow } from 'electron/main'
import { createReadStream, existsSync } from 'node:fs'
import { extname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { showRendererNotification } from './ui-bridge'
import {
  benignDecoyExtensions,
  dangerousDownloadExtensions,
  detectDecoyDoubleExtension,
  detectExecutableMimeMismatch
} from '../shared/download-security'

const execFileAsync = promisify(execFile)

// ─── Magic byte signatures ────────────────────────────────────────────────────

/** PE (Windows executable) — MZ header */
const SIG_PE = Buffer.from([0x4d, 0x5a])
/** ELF (Linux/Unix executable) */
const SIG_ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
/** Shell script shebang */
const SIG_SHEBANG = Buffer.from([0x23, 0x21])
/** Mach-O 64-bit little-endian */
const SIG_MACHO_64_LE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
/** Mach-O 32-bit little-endian */
const SIG_MACHO_32_LE = Buffer.from([0xce, 0xfa, 0xed, 0xfe])
/** Mach-O fat binary */
const SIG_MACHO_FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe])

/** File extensions that are always executable / high-risk */
const DANGEROUS_EXTS = dangerousDownloadExtensions

/**
 * Extensions that look benign but whose content should not contain executable
 * code — used to catch masquerading malware (e.g. "invoice.pdf.exe" or a
 * file named ".pdf" that actually has a PE header).
 */
const BENIGN_EXTS = benignDecoyExtensions

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ScanResult {
  status: 'clean' | 'suspicious' | 'dangerous' | 'scan-unavailable' | 'scan-failed'
  /** True when at least one confirmed threat was detected. */
  isThreat: boolean
  /** Confirmed threat descriptions (show as errors). */
  threats: string[]
  /** Heuristic warnings that may be false positives. */
  warnings: string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readMagicBytes(filePath: string, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(filePath, { start: 0, end: count - 1 })
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks).subarray(0, count)))
    stream.on('error', reject)
  })
}

function startsWithSignature(buf: Buffer, sig: Buffer): boolean {
  return buf.length >= sig.length && buf.subarray(0, sig.length).equals(sig)
}

function isExecutableContent(magic: Buffer): boolean {
  return (
    startsWithSignature(magic, SIG_PE) ||
    startsWithSignature(magic, SIG_ELF) ||
    startsWithSignature(magic, SIG_SHEBANG) ||
    startsWithSignature(magic, SIG_MACHO_64_LE) ||
    startsWithSignature(magic, SIG_MACHO_32_LE) ||
    startsWithSignature(magic, SIG_MACHO_FAT)
  )
}

// ─── Heuristic checks ─────────────────────────────────────────────────────────

export function checkDoubleExtension(filename: string, ext: string): string | null {
  void ext
  return detectDecoyDoubleExtension(filename)
}

async function checkMagicBytes(filePath: string, filename: string, ext: string): Promise<string | null> {
  try {
    const magic = await readMagicBytes(filePath, 8)
    if (!isExecutableContent(magic)) return null

    if (BENIGN_EXTS.has(ext)) {
      return `"${filename}" is labelled as a ${ext.slice(1).toUpperCase()} file but contains executable code — the file may be disguised malware.`
    }

    if (!DANGEROUS_EXTS.has(ext)) {
      return `"${filename}" contains executable code (signature match) despite an unusual extension.`
    }
  } catch {
    // Cannot read file yet — skip
  }
  return null
}

export function checkMimeMismatch(filename: string, ext: string, mimeType: string): string | null {
  void ext
  return detectExecutableMimeMismatch(filename, mimeType)
}

// ─── Windows Defender scan ────────────────────────────────────────────────────

const DEFENDER_PATHS = [
  'C:\\Program Files\\Windows Defender\\MpCmdRun.exe',
  'C:\\Program Files (x86)\\Windows Defender\\MpCmdRun.exe'
]

interface OsScanResult {
  status: 'clean' | 'dangerous' | 'unavailable' | 'failed'
  threats: string[]
}

async function runWindowsDefenderScan(filePath: string): Promise<OsScanResult> {
  let attempted = false
  for (const defenderPath of DEFENDER_PATHS) {
    if (!existsSync(defenderPath)) continue
    attempted = true
    try {
      await execFileAsync(defenderPath, ['-Scan', '-ScanType', '3', '-File', filePath], {
        timeout: 45_000,
        windowsHide: true
      })
      // Exit code 0 = no threats found
      return { status: 'clean', threats: [] }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { code?: number }).code
      if (code === 2) {
        // Threat detected
        return { status: 'dangerous', threats: ['Windows Defender detected a threat in this file.'] }
      }
      // Exit code 1 = scan error / defender not available — skip silently
    }
  }
  return { status: attempted ? 'failed' : 'unavailable', threats: [] }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan a completed download file.
 * Never throws — returns an empty clean result on any unexpected error.
 */
export async function scanDownloadedFile(
  filePath: string,
  filename: string,
  mimeType: string
): Promise<ScanResult> {
  const threats: string[] = []
  const warnings: string[] = []
  let osStatus: OsScanResult['status'] = 'unavailable'

  try {
    const ext = extname(filename).toLowerCase()

    // 1. Double extension check (threat)
    const doubleExtWarn = checkDoubleExtension(filename, ext)
    if (doubleExtWarn) threats.push(doubleExtWarn)

    // 2. Magic byte vs extension mismatch check (threat if benign ext, warning otherwise)
    const magicResult = await checkMagicBytes(filePath, filename, ext)
    if (magicResult) {
      if (BENIGN_EXTS.has(ext)) {
        threats.push(magicResult)
      } else {
        warnings.push(magicResult)
      }
    }

    // 3. MIME type mismatch (warning)
    const mimeWarn = checkMimeMismatch(filename, ext, mimeType)
    if (mimeWarn) warnings.push(mimeWarn)

    // 4. Windows Defender scan (threat if detected)
    if (process.platform === 'win32') {
      const defender = await runWindowsDefenderScan(filePath)
      osStatus = defender.status
      threats.push(...defender.threats)
    }
  } catch (scanError) {
    return {
      status: 'scan-failed',
      isThreat: false,
      threats: [],
      warnings: [`Download scan failed: ${scanError instanceof Error ? scanError.message : String(scanError)}`]
    }
  }

  const status: ScanResult['status'] = threats.length > 0
    ? 'dangerous'
    : warnings.length > 0
      ? 'suspicious'
      : osStatus === 'failed'
        ? 'scan-failed'
        : osStatus === 'unavailable'
          ? 'scan-unavailable'
          : 'clean'
  return { status, isThreat: threats.length > 0, threats, warnings }
}

/**
 * Show a warning or error dialog if the scan found anything suspicious.
 * No-ops if the file was clean.
 */
export async function alertScanResult(
  mainWindow: BrowserWindow,
  filename: string,
  result: ScanResult
): Promise<void> {
  if (!result.isThreat && result.warnings.length === 0) return

  const allFindings = [...result.threats, ...result.warnings]
  const findingText = allFindings.map((f, i) => `${i + 1}. ${f}`).join('\n\n')

  showRendererNotification(mainWindow, {
    tone: result.isThreat ? 'error' : 'warning',
    title: result.isThreat ? 'Threat detected in download' : 'Suspicious download',
    message: result.isThreat
      ? `Security threat detected in "${filename}"`
      : `"${filename}" has suspicious characteristics`,
    detail:
      findingText +
      '\n\n' +
      (result.isThreat
        ? 'This file may be dangerous. Do not open it unless you are absolutely certain of its origin. Consider deleting it immediately.'
        : 'This file may be safe, but proceed with caution. Only open it if you fully trust the source.'),
    durationMs: result.isThreat ? 14_000 : 10_000
  })
}
