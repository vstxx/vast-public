/**
 * Opening splash timeline. The splash is a standalone lightweight window: the
 * entrance/calm phases run as pure CSS inside it, and the exit is a window-level
 * opacity fade performed by the main process once the real browser is revealed.
 *
 *   0-250ms      opening surface settles in
 *   250-1000ms   logo/wordmark reveal
 *   1000-2100ms  calm presence (held until reveal if the browser is not ready yet)
 *   2100-2700ms  reveal window: main browser appears under the fading splash
 */
export const OPENING_SEQUENCE = {
  totalMs: 2_700,
  backgroundFadeInEndMs: 250,
  logoVisibleByMs: 1_000,
  calmPresenceEndMs: 2_100,
  exitBeginMs: 2_100
} as const

export const OPENING_PRESENTATION = {
  width: 680,
  height: 400,
  minimumWidth: 520,
  minimumHeight: 320,
  exitFadeMs: 180,
  exitFadeSteps: 6,
  /** Emergency protection only; normal reveal is driven by explicit readiness signals. */
  fallbackTimeoutMs: 15_000
} as const

type OpeningVoice = {
  frequency: number
  detune: number
  gain: number
  type?: OscillatorType
  startMs: number
  attackMs: number
  releaseMs: number
}

export const OPENING_AUDIO = {
  durationMs: OPENING_SEQUENCE.totalMs,
  closeBufferMs: 420,
  defaultVolume: 0,
  maxGainScale: 5.5,
  masterPeakMs: 1_260,
  fadeOutStartMs: 2_100,
  filterPeakHz: 1_560,
  filterPeakMs: 1_620,
  filterResolveHz: 940,
  noisePeakMs: 1_180,
  noiseFadeOutStartMs: 2_050,
  voices: [
    { frequency: 73.42, detune: 0, gain: 0.024, type: 'sine', startMs: 130, attackMs: 780, releaseMs: 2_660 },
    { frequency: 146.83, detune: -5, gain: 0.03, type: 'sine', startMs: 90, attackMs: 740, releaseMs: 2_680 },
    { frequency: 220, detune: 4, gain: 0.022, type: 'sine', startMs: 170, attackMs: 700, releaseMs: 2_640 },
    { frequency: 277.18, detune: -3, gain: 0.016, type: 'triangle', startMs: 250, attackMs: 680, releaseMs: 2_600 },
    { frequency: 329.63, detune: 3, gain: 0.014, type: 'sine', startMs: 330, attackMs: 660, releaseMs: 2_560 },
    { frequency: 440, detune: 0, gain: 0.009, type: 'sine', startMs: 380, attackMs: 820, releaseMs: 2_520 }
  ] as const satisfies readonly OpeningVoice[]
} as const

export function toSeconds(ms: number): number {
  return ms / 1_000
}

export function openingVolumeToGain(volume: number): number {
  const normalized = Math.min(100, Math.max(0, volume)) / 100
  return Number((normalized * OPENING_AUDIO.maxGainScale).toFixed(4))
}
