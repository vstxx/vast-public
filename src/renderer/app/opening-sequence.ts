import { OPENING_SEQUENCE } from '../../shared/opening-sequence.ts'

export { OPENING_SEQUENCE }

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
  fadeOutStartMs: 3_650,
  filterPeakHz: 1_560,
  filterPeakMs: 1_620,
  filterResolveHz: 940,
  noisePeakMs: 1_180,
  noiseFadeOutStartMs: 3_450,
  voices: [
    { frequency: 73.42, detune: 0, gain: 0.024, type: 'sine', startMs: 130, attackMs: 780, releaseMs: 4_420 },
    { frequency: 146.83, detune: -5, gain: 0.03, type: 'sine', startMs: 90, attackMs: 740, releaseMs: 4_480 },
    { frequency: 220, detune: 4, gain: 0.022, type: 'sine', startMs: 170, attackMs: 700, releaseMs: 4_380 },
    { frequency: 277.18, detune: -3, gain: 0.016, type: 'triangle', startMs: 250, attackMs: 680, releaseMs: 4_280 },
    { frequency: 329.63, detune: 3, gain: 0.014, type: 'sine', startMs: 330, attackMs: 660, releaseMs: 4_180 },
    { frequency: 440, detune: 0, gain: 0.009, type: 'sine', startMs: 380, attackMs: 820, releaseMs: 3_980 }
  ] as const satisfies readonly OpeningVoice[]
} as const

export function toSeconds(ms: number): number {
  return ms / 1_000
}

export function openingVolumeToGain(volume: number): number {
  const normalized = Math.min(100, Math.max(0, volume)) / 100
  return Number((normalized * OPENING_AUDIO.maxGainScale).toFixed(4))
}
