const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, isAbsolute, join, resolve, sep } = require('node:path')

const root = join(__dirname, '..')
const args = process.argv.slice(2)

function argument(name, fallback = '') {
  const direct = args.find((value) => value.startsWith(`${name}=`))
  if (direct) return direct.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function executable(name, configured, fallback) {
  const value = String(configured || fallback || name).trim()
  const path = isAbsolute(value) ? value : resolve(root, value)
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${name} executable is missing: ${path}`)
  return path
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    encoding: options.encoding === null ? null : 'utf8',
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout || 60_000,
    windowsHide: true
  })
  if (result.error) throw result.error
  const stdout = options.encoding === null ? result.stdout : String(result.stdout || '')
  const stderr = options.encoding === null ? result.stderr : String(result.stderr || '')
  if (result.status !== 0) {
    const detail = options.encoding === null ? '' : String(stderr || stdout).trim().slice(-4000)
    throw new Error(`${basename(command)} ${commandArgs.join(' ')} failed (${result.status}): ${detail}`)
  }
  return options.encoding === null ? stdout : `${stdout}${stderr}`
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function requirePattern(output, pattern, label) {
  if (!pattern.test(output)) throw new Error(`FFmpeg capability is missing: ${label}`)
}

function assertFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size < 32) throw new Error(`FFmpeg functional test did not create ${label}.`)
}

const ffmpeg = executable('ffmpeg', argument('--ffmpeg', process.env.VAST_AVIDAE_FFMPEG), join('resources', 'avidae-runtime', 'media', 'ffmpeg.exe'))
const ffprobe = executable('ffprobe', argument('--ffprobe', process.env.VAST_AVIDAE_FFPROBE), join('resources', 'avidae-runtime', 'media', 'ffprobe.exe'))
const inventoryCommands = {
  buildconf: ['-buildconf'],
  formats: ['-formats'],
  demuxers: ['-demuxers'],
  muxers: ['-muxers'],
  encoders: ['-encoders'],
  decoders: ['-decoders'],
  filters: ['-filters'],
  devices: ['-devices'],
  protocols: ['-protocols']
}
const inventory = Object.fromEntries(Object.entries(inventoryCommands).map(([name, commandArgs]) => [name, run(ffmpeg, ['-hide_banner', ...commandArgs])]))
inventory.ffmpegVersion = run(ffmpeg, ['-version'])
inventory.ffprobeVersion = run(ffprobe, ['-version'])

const required = {
  demuxers: ['mov', 'matroska,webm', 'avi', 'mpegts', 'mp3', 'wav', 'ogg', 'flac', 'aac', 'asf', 'concat', 'rawvideo'],
  muxers: ['mp4', 'matroska', 'webm', 'avi', 'mp3', 'wav', 'ogg', 'flac', 'adts', 'ipod'],
  encoders: ['libx264', 'aac', 'libmp3lame', 'libvorbis', 'libopus', 'flac', 'pcm_s16le', 'mjpeg', 'libvpx-vp9'],
  decoders: ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'aac', 'mp3', 'vorbis', 'opus', 'flac', 'pcm_s16le'],
  filters: ['scale', 'crop', 'fps', 'overlay', 'pad', 'setsar', 'aformat', 'aresample', 'afade', 'metadata', 'concat'],
  devices: process.platform === 'win32' ? ['gdigrab', 'dshow'] : ['x11grab', 'pulse'],
  protocols: ['file', 'pipe', 'http', 'https']
}
for (const [group, names] of Object.entries(required)) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    requirePattern(inventory[group], new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'im'), `${group}: ${name}`)
  }
}

const testRoot = mkdtempSync(join(tmpdir(), 'vast-ffmpeg-capabilities-'))
const functionalTests = []
function test(name, operation) {
  operation()
  functionalTests.push({ name, ok: true })
}

try {
  const source = join(testRoot, 'source.mp4')
  test('H.264 + AAC MP4 encode and faststart', () => {
    run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1.5', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source], { timeout: 120_000 })
    assertFile(source, 'MP4 source')
    const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', source]))
    if (!Array.isArray(probe.streams) || probe.streams.length < 2) throw new Error('FFprobe did not report video and audio streams.')
  })

  test('thumbnail extraction and scale filter', () => {
    const output = join(testRoot, 'thumbnail.jpg')
    run(ffmpeg, ['-y', '-i', source, '-ss', '0.2', '-frames:v', '1', '-vf', 'scale=160:-1', output])
    assertFile(output, 'JPEG thumbnail')
  })

  test('crop, fps and overlay filters', () => {
    const output = join(testRoot, 'filtered.mp4')
    const filter = '[0:v]fps=12,crop=300:160:10:10[base];[1:v]scale=64:36[pip];[base][pip]overlay=W-w-4:H-h-4[outv]'
    run(ffmpeg, ['-y', '-i', source, '-i', source, '-filter_complex', filter, '-map', '[outv]', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', output], { timeout: 120_000 })
    assertFile(output, 'cropped/fps/overlay video')
  })

  const audioCases = [
    ['mp3', 'libmp3lame'], ['wav', 'pcm_s16le'], ['ogg', 'libvorbis'], ['flac', 'flac'],
    ['opus', 'libopus'], ['aac', 'aac'], ['m4a', 'aac']
  ]
  for (const [extension, codec] of audioCases) {
    test(`audio conversion: ${extension}/${codec}`, () => {
      const output = join(testRoot, `audio.${extension}`)
      run(ffmpeg, ['-y', '-i', source, '-vn', '-c:a', codec, '-b:a', codec === 'pcm_s16le' || codec === 'flac' ? '1411k' : '128k', output])
      assertFile(output, `${extension} audio`)
    })
  }

  test('audio resampling and metadata', () => {
    const output = join(testRoot, 'resampled.m4a')
    run(ffmpeg, ['-y', '-i', source, '-vn', '-af', 'aresample=44100,afade=t=in:st=0:d=0.1', '-c:a', 'aac', '-metadata', 'title=Vast capability test', output])
    assertFile(output, 'resampled audio')
    const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', output]))
    if (probe?.format?.tags?.title !== 'Vast capability test') throw new Error('FFprobe did not preserve the metadata operation.')
  })

  test('WebM VP9 + Opus conversion', () => {
    const output = join(testRoot, 'converted.webm')
    run(ffmpeg, ['-y', '-i', source, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', output], { timeout: 120_000 })
    assertFile(output, 'WebM video')
  })

  for (const extension of ['mkv', 'avi']) {
    test(`${extension.toUpperCase()} video conversion`, () => {
      const output = join(testRoot, `converted.${extension}`)
      const codecs = extension === 'avi' ? ['-c:v', 'libx264', '-c:a', 'libmp3lame'] : ['-c', 'copy']
      run(ffmpeg, ['-y', '-i', source, ...codecs, output], { timeout: 120_000 })
      assertFile(output, `${extension} video`)
    })
  }

  test('stream-copy trim', () => {
    const output = join(testRoot, 'trimmed.mp4')
    run(ffmpeg, ['-y', '-ss', '0.1', '-i', source, '-t', '0.8', '-c', 'copy', '-movflags', '+faststart', output])
    assertFile(output, 'trimmed video')
  })

  test('concat demuxer merge', () => {
    const list = join(testRoot, 'concat.txt')
    writeFileSync(list, `file '${source.replace(/\\/g, '/')}'\nfile '${source.replace(/\\/g, '/')}'\n`, 'utf8')
    const output = join(testRoot, 'concatenated.mp4')
    run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output])
    assertFile(output, 'concatenated video')
  })

  test('filter-complex re-encode merge', () => {
    const output = join(testRoot, 'filter-merged.mp4')
    const filter = '[0:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1[v0];[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];[1:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1[v1];[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]'
    run(ffmpeg, ['-y', '-i', source, '-i', source, '-filter_complex', filter, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', output], { timeout: 120_000 })
    assertFile(output, 'filter-merged video')
  })

  test('raw BGRA page-recording input', () => {
    const output = join(testRoot, 'raw-page-recording.mp4')
    const frames = Buffer.alloc(64 * 64 * 4 * 2, 127)
    run(ffmpeg, ['-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', '64x64', '-r', '2', '-i', 'pipe:0', '-frames:v', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '28', '-pix_fmt', 'yuv420p', output], { input: frames, encoding: null })
    assertFile(output, 'raw page recording')
  })
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  binaries: {
    ffmpeg: { path: basename(ffmpeg), size: statSync(ffmpeg).size, sha256: sha256(ffmpeg), version: inventory.ffmpegVersion.split(/\r?\n/)[0] || '' },
    ffprobe: { path: basename(ffprobe), size: statSync(ffprobe).size, sha256: sha256(ffprobe), version: inventory.ffprobeVersion.split(/\r?\n/)[0] || '' }
  },
  required,
  functionalTests,
  inventory
}
const output = resolve(root, argument('--output', join('performance-results', 'avidae-ffmpeg-capabilities.json')))
if (!output.startsWith(`${resolve(root)}${sep}`)) throw new Error('FFmpeg capability output must remain inside the repository.')
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ok: true, ffmpeg: report.binaries.ffmpeg, ffprobe: report.binaries.ffprobe, functionalTests }, null, 2))
