import { BrowserWindow, screen } from 'electron/main'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDev } from './electron-runtime'
import { markPerformance } from './performance-probe'
import { OPENING_AUDIO, OPENING_PRESENTATION, OPENING_SEQUENCE, openingVolumeToGain } from '../shared/opening-sequence'

const SPLASH_LOGO_PATH = isDev
  ? join(process.cwd(), 'assets', 'logos', 'vast.png')
  : join(process.resourcesPath, process.platform === 'win32' ? 'app-icon-windows.png' : 'app-icon.png')

export function roundedWindowShape(width: number, height: number, radius: number): Electron.Rectangle[] {
  const safeRadius = Math.max(0, Math.min(Math.floor(radius), Math.floor(width / 2), Math.floor(height / 2)))
  if (safeRadius === 0) return [{ x: 0, y: 0, width, height }]
  const rows: Electron.Rectangle[] = []
  for (let y = 0; y < safeRadius; y += 1) {
    const distance = safeRadius - y - 0.5
    const inset = Math.max(0, Math.ceil(safeRadius - Math.sqrt(safeRadius * safeRadius - distance * distance)))
    rows.push({ x: inset, y, width: width - inset * 2, height: 1 })
    rows.push({ x: inset, y: height - y - 1, width: width - inset * 2, height: 1 })
  }
  rows.push({ x: 0, y: safeRadius, width, height: height - safeRadius * 2 })
  return rows
}

function splashLogoDataUrl(): string {
  try {
    return `data:image/png;base64,${readFileSync(SPLASH_LOGO_PATH).toString('base64')}`
  } catch {
    return ''
  }
}

// Percentages of OPENING_SEQUENCE.totalMs: settle 0-9.3%, reveal 9.3-37%,
// calm 37-77.8%, then the splash holds its calm final state until the main
// browser is revealed; the exit itself is the window-level opacity fade.
function splashDocument(platform: string, cornerRadius: number, volume: number): string {
  const logo = splashLogoDataUrl()
  const durationMs = OPENING_SEQUENCE.totalMs
  const csp = volume > 0
    ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'"
    : "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'"
  const audioScript = volume > 0 ? `<script>(${openingAudioScriptSource()})(${openingVolumeToGain(volume)},${JSON.stringify(OPENING_AUDIO)});</script>` : ''
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Vast</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #030406; }
  .vast-opening-overlay {
    width: 100vw; height: 100vh; contain: layout paint style; isolation: isolate;
    border: 0; border-radius: 0; background-color: #030406;
    background:
      radial-gradient(circle at 50% 45%, rgba(91, 64, 168, 0.032) 0%, transparent 26%),
      linear-gradient(180deg, #030406 0%, #06070a 54%, #08090b 100%);
  }
  .vast-opening-overlay.platform-darwin { border-radius: ${Math.round(cornerRadius)}px; }
  .vast-opening-backdrop {
    position: absolute; inset: 0; z-index: 0;
    background:
      radial-gradient(ellipse at 50% 48%, rgba(91, 64, 168, 0.17) 0%, rgba(42, 25, 82, 0.095) 31%, transparent 66%),
      linear-gradient(180deg, #030406 0%, #06070a 54%, #08090b 100%);
    opacity: 0;
    animation: vast-opening-backdrop ${durationMs}ms cubic-bezier(0.42, 0, 0.16, 1) both;
  }
  .vast-opening-core {
    position: absolute; inset: 0; z-index: 1; display: grid; place-items: center;
    animation: vast-opening-core ${durationMs}ms cubic-bezier(0.33, 0, 0.16, 1) both;
  }
  .vast-opening-logo-halo {
    position: absolute;
    width: min(64vw, 56rem); height: min(22vw, 19rem); border-radius: 50%;
    background:
      radial-gradient(ellipse at 50% 50%, rgba(91, 64, 168, 0.23) 0%, rgba(38, 24, 74, 0.15) 34%, transparent 72%);
    opacity: 0; transform: scale(0.94);
    animation: vast-opening-logo-halo ${durationMs}ms cubic-bezier(0.33, 0, 0.16, 1) both;
  }
  .vast-opening-logo-frame {
    display: block; position: relative;
    width: min(64vw, 15rem); aspect-ratio: 493 / 176; overflow: hidden;
    filter: drop-shadow(0 0 14px rgba(91, 64, 168, 0.2)) drop-shadow(0 18px 40px rgba(0, 0, 0, 0.26));
    opacity: 0; transform: translateY(8px) scale(0.965);
    animation: vast-opening-logo ${durationMs}ms cubic-bezier(0.33, 0, 0.16, 1) both;
  }
  .vast-opening-logo {
    position: absolute;
    left: calc(50% - 2.07%); top: calc(50% - 5.4%);
    display: block; width: 321.3%; height: auto; max-width: none;
    aspect-ratio: 4 / 1; object-fit: contain; transform: translate(-50%, -50%);
    filter: brightness(0) invert(1);
  }
  @keyframes vast-opening-backdrop {
    0% { opacity: 0; }
    9.3%, 100% { opacity: 1; }
  }
  @keyframes vast-opening-core {
    0% { transform: translateY(4px) scale(0.992); }
    37%, 100% { transform: translateY(0) scale(1); }
  }
  @keyframes vast-opening-logo-halo {
    0% { opacity: 0; transform: scale(0.92); }
    37% { opacity: 1; transform: scale(1); }
    77.8%, 100% { opacity: 0.94; transform: scale(1.04); }
  }
  @keyframes vast-opening-logo {
    0%, 9.3% { opacity: 0; transform: translateY(8px) scale(0.965); }
    37%, 77.8% { opacity: 1; transform: translateY(0) scale(1); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .vast-opening-backdrop, .vast-opening-core, .vast-opening-logo-halo, .vast-opening-logo-frame {
      animation-duration: 1ms !important; animation-delay: 0ms !important;
    }
  }
</style></head>
<body><div class="vast-opening-overlay platform-${platform}">
  <div class="vast-opening-backdrop"></div>
  <div class="vast-opening-core">
    <div class="vast-opening-logo-halo" aria-hidden="true"></div>
    <span class="vast-opening-logo-frame" role="img" aria-label="Vast">
      <img class="vast-opening-logo" src="${logo}" alt="" aria-hidden="true" draggable="false" decoding="async">
    </span>
  </div>
</div>${audioScript}</body></html>`)};`
}

// Plays the same serenity chime the main renderer used to play, driven by the
// shared OPENING_AUDIO timeline. Injected only when the configured volume > 0.
function openingAudioScriptSource(): string {
  return `
function (volumeGain, AUDIO) {
  if (!(volumeGain > 0)) return;
  var Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  function sec(ms) { return ms / 1000; }
  var context = new Ctor();
  var now = context.currentTime;
  var duration = sec(AUDIO.durationMs);
  var master = context.createGain();
  var compressor = context.createDynamicsCompressor();
  var toneBus = context.createGain();
  var filter = context.createBiquadFilter();
  var highpass = context.createBiquadFilter();
  var chorusDelay = context.createDelay();
  var chorusGain = context.createGain();
  var chorusLfo = context.createOscillator();
  var chorusDepth = context.createGain();
  var reverb = context.createConvolver();
  var dry = context.createGain();
  var wet = context.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.052 * volumeGain, now + 0.68);
  master.gain.setTargetAtTime(0.068 * volumeGain, now + sec(AUDIO.masterPeakMs), 0.52);
  master.gain.setTargetAtTime(0.031 * volumeGain, now + sec(AUDIO.fadeOutStartMs), 0.42);
  master.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  toneBus.gain.value = 0.96;
  compressor.threshold.value = -24; compressor.knee.value = 18;
  compressor.ratio.value = 2.2; compressor.attack.value = 0.16; compressor.release.value = 0.78;
  highpass.type = 'highpass'; highpass.frequency.value = 76; highpass.Q.value = 0.28;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(820, now);
  filter.frequency.exponentialRampToValueAtTime(AUDIO.filterPeakHz, now + sec(AUDIO.filterPeakMs));
  filter.frequency.exponentialRampToValueAtTime(AUDIO.filterResolveHz, now + duration);
  filter.Q.value = 0.14;
  chorusDelay.delayTime.value = 0.015; chorusGain.gain.value = 0.17;
  chorusLfo.type = 'sine'; chorusLfo.frequency.value = 0.09; chorusDepth.gain.value = 0.0038;
  dry.gain.value = 0.8; wet.gain.value = 0.18;
  var impulseLength = Math.floor(context.sampleRate * 2.6);
  var impulse = context.createBuffer(2, impulseLength, context.sampleRate);
  for (var channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    var data = impulse.getChannelData(channel);
    for (var index = 0; index < impulseLength; index += 1) {
      var decay = Math.pow(1 - index / impulseLength, 3.2);
      data[index] = (Math.random() * 2 - 1) * decay * 0.045;
    }
  }
  reverb.buffer = impulse;
  toneBus.connect(highpass); highpass.connect(filter);
  filter.connect(dry); filter.connect(chorusDelay); chorusDelay.connect(chorusGain); chorusGain.connect(dry);
  filter.connect(reverb); reverb.connect(wet);
  dry.connect(compressor); wet.connect(compressor); compressor.connect(master); master.connect(context.destination);
  chorusLfo.connect(chorusDepth); chorusDepth.connect(chorusDelay.delayTime);
  chorusLfo.start(now); chorusLfo.stop(now + duration);
  for (var v = 0; v < AUDIO.voices.length; v += 1) {
    var voice = AUDIO.voices[v];
    var oscillator = context.createOscillator();
    var gain = context.createGain();
    var startAt = now + sec(voice.startMs);
    var peakAt = startAt + sec(voice.attackMs);
    var releaseAt = now + sec(voice.releaseMs);
    oscillator.type = voice.type || 'sine';
    oscillator.frequency.setValueAtTime(voice.frequency * 0.998, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(voice.frequency, Math.min(peakAt + 0.22, releaseAt));
    oscillator.detune.value = voice.detune;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(voice.gain, peakAt);
    gain.gain.setTargetAtTime(voice.gain * 0.84, peakAt, 0.72);
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt);
    oscillator.connect(gain); gain.connect(toneBus);
    oscillator.start(startAt); oscillator.stop(now + duration);
  }
  var noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
  var noiseData = noiseBuffer.getChannelData(0);
  for (var n = 0; n < noiseData.length; n += 1) noiseData[n] = (Math.random() * 2 - 1) * 0.011;
  var source = context.createBufferSource();
  var breathGain = context.createGain();
  var airFilter = context.createBiquadFilter();
  source.buffer = noiseBuffer; source.loop = true;
  airFilter.type = 'lowpass'; airFilter.frequency.value = 480; airFilter.Q.value = 0.12;
  breathGain.gain.setValueAtTime(0.0001, now);
  breathGain.gain.exponentialRampToValueAtTime(0.012, now + sec(AUDIO.noisePeakMs));
  breathGain.gain.setTargetAtTime(0.008, now + sec(AUDIO.noiseFadeOutStartMs), 0.58);
  breathGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(airFilter); airFilter.connect(breathGain); breathGain.connect(filter);
  source.start(now); source.stop(now + duration);
  void context.resume().catch(function () {});
  window.setTimeout(function () { context.close().catch(function () {}); }, AUDIO.durationMs + AUDIO.closeBufferMs);
}`
}

export interface OpeningSplashController {
  window: BrowserWindow
  /** Fade the splash out over OPENING_PRESENTATION.exitFadeMs, then destroy it. */
  beginExit(onDestroyed: () => void): void
  /** Destroy immediately without the exit fade. */
  dispose(): void
}

export function createOpeningSplashWindow(options: {
  platform: NodeJS.Platform
  cornerRadius: number
  soundVolume: number
  onAnimationComplete: () => void
  onClosed: () => void
}): OpeningSplashController {
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const width = Math.min(OPENING_PRESENTATION.width, Math.max(360, workArea.width - 48))
  const height = Math.min(OPENING_PRESENTATION.height, Math.max(240, workArea.height - 48))
  const bounds = {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2)
  }

  const splash = new BrowserWindow({
    ...bounds,
    frame: false,
    // Windows keeps WS_THICKFRAME on frameless windows by default; its DWM-drawn
    // frame band renders as a grey border around the dark splash. Remove it.
    thickFrame: false,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#030406',
    title: 'Vast',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  })
  splash.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'win32' || process.platform === 'linux') {
    splash.setShape(roundedWindowShape(width, height, options.cornerRadius))
  }

  let animationFinished = false
  let exitStarted = false
  let animationTimer: NodeJS.Timeout | undefined
  const finishAnimation = (): void => {
    if (animationFinished) return
    animationFinished = true
    clearTimeout(animationTimer)
    options.onAnimationComplete()
  }

  splash.webContents.once('did-finish-load', () => markPerformance('opening-splash-loaded', { windowId: splash.id }))
  splash.webContents.on('render-process-gone', finishAnimation)
  splash.once('ready-to-show', () => {
    if (splash.isDestroyed()) return
    splash.show()
    markPerformance('opening-splash-visible', { windowId: splash.id })
    animationTimer = setTimeout(finishAnimation, OPENING_SEQUENCE.totalMs)
  })
  splash.once('closed', () => {
    clearTimeout(animationTimer)
    if (!animationFinished) {
      animationFinished = true
      options.onAnimationComplete()
    }
    options.onClosed()
  })
  markPerformance('opening-splash-constructed')
  void splash.loadURL(splashDocument(process.platform, options.cornerRadius, options.soundVolume))

  return {
    window: splash,
    beginExit(onDestroyed): void {
      if (exitStarted) return
      exitStarted = true
      if (splash.isDestroyed()) {
        onDestroyed()
        return
      }
      splash.once('closed', onDestroyed)
      const steps = OPENING_PRESENTATION.exitFadeSteps
      const stepMs = Math.max(1, Math.round(OPENING_PRESENTATION.exitFadeMs / steps))
      let step = 0
      const fade = (): void => {
        if (splash.isDestroyed()) return
        step += 1
        splash.setOpacity(Math.max(0, 1 - step / steps))
        if (step < steps) setTimeout(fade, stepMs)
        else splash.destroy()
      }
      setTimeout(fade, stepMs)
    },
    dispose(): void {
      if (!splash.isDestroyed()) splash.destroy()
    }
  }
}
