export const OPENING_SEQUENCE = {
  totalMs: 5_000,
  backgroundFadeInEndMs: 400,
  logoVisibleByMs: 1_100,
  calmPresenceEndMs: 3_300,
  chromeRevealEndMs: 4_600,
  overlayHideMs: 5_000
} as const

export const OPENING_PRESENTATION = {
  width: 680,
  height: 400,
  minimumWidth: 520,
  minimumHeight: 320,
  cornerRadius: 28,
  revealDelayMs: 72,
  fallbackGraceMs: 2_000
} as const

export const OPENING_COMPLETE_MESSAGE = 'vast:opening-animation-complete'
export const OPENING_COMPLETE_IPC_CHANNEL = 'vast:opening-animation-complete'
