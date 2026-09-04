const { closeSync, openSync, readSync, statSync } = require('node:fs')
const { spawnSync } = require('node:child_process')

function readExactly(fileDescriptor, length, position, description) {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = readSync(fileDescriptor, bytes, offset, length - offset, position + offset)
    if (count === 0) throw new Error(`Truncated PE while reading ${description}.`)
    offset += count
  }
  return bytes
}

function inspectOptionalHeader(optionalHeader, fileSize) {
  if (optionalHeader.length < 2) throw new Error('PE optional header is truncated.')
  const magic = optionalHeader.readUInt16LE(0)
  const numberOfDirectoriesOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : -1
  const directoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1
  if (numberOfDirectoriesOffset < 0) throw new Error('PE optional header has an unsupported magic value.')
  if (numberOfDirectoriesOffset + 4 > optionalHeader.length) throw new Error('PE data-directory count is truncated.')
  const numberOfDirectories = optionalHeader.readUInt32LE(numberOfDirectoriesOffset)
  if (numberOfDirectories < 5) return { certificateTablePresent: false, certificateOffset: 0, certificateSize: 0 }
  const securityDirectoryOffset = directoriesOffset + (4 * 8)
  if (securityDirectoryOffset + 8 > optionalHeader.length) throw new Error('PE security directory is truncated.')
  const certificateOffset = optionalHeader.readUInt32LE(securityDirectoryOffset)
  const certificateSize = optionalHeader.readUInt32LE(securityDirectoryOffset + 4)
  if (certificateOffset === 0 && certificateSize === 0) {
    return { certificateTablePresent: false, certificateOffset, certificateSize }
  }
  if (certificateOffset === 0 || certificateSize < 8 || certificateOffset % 8 !== 0 || certificateOffset + certificateSize > fileSize) {
    throw new Error('PE certificate table is malformed.')
  }
  return { certificateTablePresent: true, certificateOffset, certificateSize }
}

function inspectPeCertificateTableBuffer(bytes, fileSize = bytes.length) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error('File is not a valid MZ executable.')
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset > bytes.length - 24 || bytes.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('File has no valid PE header.')
  }
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20)
  const optionalHeaderOffset = peOffset + 24
  if (optionalHeaderOffset + optionalHeaderSize > bytes.length) throw new Error('PE optional header is truncated.')
  return inspectOptionalHeader(bytes.subarray(optionalHeaderOffset, optionalHeaderOffset + optionalHeaderSize), fileSize)
}

function inspectPeCertificateTable(file) {
  const size = statSync(file).size
  const fileDescriptor = openSync(file, 'r')
  try {
    const dosHeader = readExactly(fileDescriptor, 64, 0, 'DOS header')
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) throw new Error('File is not a valid MZ executable.')
    const peOffset = dosHeader.readUInt32LE(0x3c)
    if (peOffset > size - 24) throw new Error('File has no complete PE header.')
    const peHeader = readExactly(fileDescriptor, 24, peOffset, 'PE header')
    if (peHeader.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error('File has no valid PE header.')
    const optionalHeaderSize = peHeader.readUInt16LE(20)
    const optionalHeader = readExactly(fileDescriptor, optionalHeaderSize, peOffset + 24, 'optional header')
    return inspectOptionalHeader(optionalHeader, size)
  } finally {
    closeSync(fileDescriptor)
  }
}

function inspectUnsignedPe(file) {
  const table = inspectPeCertificateTable(file)
  return {
    status: table.certificateTablePresent ? 'SignaturePresent' : 'NotSigned',
    statusMessage: table.certificateTablePresent ? 'PE contains an Authenticode certificate table.' : 'PE contains no Authenticode certificate table.',
    signerSubject: '',
    signerNotAfter: '',
    timestampSubject: '',
    timestampNotAfter: ''
  }
}

function windowsPowerShellEnvironment(extra) {
  const environment = { ...process.env, ...extra }
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === 'psmodulepath') delete environment[name]
  }
  return environment
}

function inspectTrustedAuthenticode(file) {
  if (process.platform !== 'win32') throw new Error('Authenticode trust verification requires Windows.')
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:VAST_SIGNATURE_PATH -ErrorAction Stop',
    'if ($null -eq $signature -or [string]::IsNullOrWhiteSpace([string]$signature.Status)) { throw "Authenticode inspection returned no status." }',
    '$result = [ordered]@{',
    '  Status = [string]$signature.Status',
    '  StatusMessage = [string]$signature.StatusMessage',
    '  SignerSubject = [string]$signature.SignerCertificate.Subject',
    '  SignerNotAfter = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString("o") } else { "" })',
    '  TimestampSubject = [string]$signature.TimeStamperCertificate.Subject',
    '  TimestampNotAfter = $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.NotAfter.ToUniversalTime().ToString("o") } else { "" })',
    '}',
    '$result | ConvertTo-Json -Compress'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: windowsPowerShellEnvironment({ VAST_SIGNATURE_PATH: file }),
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error || result.status !== 0 || String(result.stderr || '').trim()) {
    throw new Error(`Authenticode trust inspection failed: ${result.error?.message || String(result.stderr || result.stdout || '').trim()}`)
  }
  const signature = JSON.parse(String(result.stdout || '').trim())
  if (!signature || typeof signature.Status !== 'string' || !signature.Status.trim()) {
    throw new Error('Authenticode trust inspection returned an invalid result.')
  }
  return {
    status: signature.Status,
    statusMessage: signature.StatusMessage,
    signerSubject: signature.SignerSubject,
    signerNotAfter: signature.SignerNotAfter,
    timestampSubject: signature.TimestampSubject,
    timestampNotAfter: signature.TimestampNotAfter
  }
}

module.exports = {
  inspectPeCertificateTable,
  inspectPeCertificateTableBuffer,
  inspectTrustedAuthenticode,
  inspectUnsignedPe
}
