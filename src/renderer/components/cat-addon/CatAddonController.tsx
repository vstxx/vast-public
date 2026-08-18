import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { CatAddonRuntimeBundle } from '../../../shared/cat-addon-runtime'
import type { CatAddonState, CatAddonWindowState, ID, LayoutMode } from '../../../shared/types'
import {
  CatAnimationScheduler,
  catAmbientSceneOrder,
  type ActiveCatAnimation,
  type CatAnimationId
} from '../../../shared/cat-addon-scheduler'
import { CAT_ADDON_EVENT } from '../../lib/cat-addon-events'
import { selectActiveTab, selectActiveWorkspace, useBrowserStore } from '../../store/browser-store'
import { CatActor, CatSceneDirector, CatSpriteAtlas, type CatActorSnapshot, type CatSceneAction } from './cat-engine'
import {
  CAT_SCENE_SCALE,
  catBottomY,
  catChromeY,
  catClimbStartY,
  catRailY,
  clampCatY,
  type CatAnchor
} from './cat-layout'
import { CatSprite } from './CatSprite'
import './cat-addon.css'

const disabledState: CatAddonState = { enabled: false, installed: false, phase: 'disabled' }
const defaultWindowState: CatAddonWindowState = { visible: true, minimized: false, fullscreen: false }

function eventDetail<T>(event: Event): T | undefined {
  return (event as CustomEvent<T>).detail
}

function elementAnchor(selector: string, fallback: CatAnchor): CatAnchor {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) return fallback
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function anchorFor(id: CatAnimationId): CatAnchor {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  if (id === 'omnibox-peek' || id === 'paw-swat' || id === 'toolbar-patrol' || id.startsWith('secret-')) {
    return elementAnchor('.vast-top-address', { left: viewport.width * 0.25, top: 46, width: viewport.width * 0.55, height: 40 })
  }
  if (id === 'bookmark-paw') {
    return elementAnchor('.horizontal-bookmarks-bar', { left: 12, top: 84, width: Math.max(180, viewport.width - 24), height: 36 })
  }
  if (id === 'new-tab-reaction') {
    return elementAnchor('[data-testid="vertical-new-tab"], .horizontal-tab-strip + button, button[title="New tab"]', {
      left: viewport.width - 80, top: 12, width: 40, height: 40
    })
  }
  if (id === 'tab-run' || id === 'tab-tail' || id === 'tab-climb' || id === 'tab-nap' || id === 'sidebar-sneak' || id === 'closing-tab-paw') {
    return elementAnchor('.horizontal-tab-strip, [data-cat-tab-list="true"]', {
      left: 8, top: 64, width: Math.min(360, viewport.width * 0.28), height: Math.max(90, viewport.height - 140)
    })
  }
  return { left: 16, top: viewport.height - 80, width: viewport.width - 32, height: 64 }
}

function secretAnimation(value: string): Extract<CatAnimationId, `secret-${string}`> | undefined {
  switch (value.trim().toLowerCase()) {
    case 'meow': return 'secret-meow'
    case 'pspsps': return 'secret-pspsps'
    case ':3': return 'secret-smile'
    case 'vast cat': return 'secret-vast-cat'
    default: return undefined
  }
}

function sceneActions(id: CatAnimationId, anchor: CatAnchor): readonly CatSceneAction[] {
  const right = anchor.left + anchor.width
  const viewportHeight = window.innerHeight
  const chromeY = catChromeY(anchor, viewportHeight)
  const railY = catRailY(anchor, viewportHeight)
  const bottomY = catBottomY(viewportHeight)
  switch (id) {
    case 'omnibox-peek':
      return [
        { type: 'show', x: right - 84, y: chromeY },
        { type: 'play', animation: 'spawn_1' },
        { type: 'play', animation: 'sit_lift' },
        { type: 'play', animation: 'sit_tilt' },
        { type: 'play', animation: 'sit_lift', reverse: true },
        { type: 'hide' }
      ]
    case 'paw-swat':
      return [
        { type: 'show', x: right - 88, y: chromeY },
        { type: 'play', animation: 'idle_lift' },
        { type: 'play', animation: 'attack_1', cycles: 2 },
        { type: 'play', animation: 'pull_back' },
        { type: 'play', animation: 'yes' },
        { type: 'hide' }
      ]
    case 'tab-run':
      return [
        { type: 'show', x: anchor.left - 82, y: railY, facing: 'right' },
        { type: 'play', animation: 'spawn_1' },
        { type: 'travel', animation: 'run_1', cycles: 4, x: right - 98, y: railY, durationMs: 2_400 },
        { type: 'play', animation: 'stop' },
        { type: 'play', animation: 'idle_tilt' },
        { type: 'travel', animation: 'walk', cycles: 2, x: right + 82, y: railY, durationMs: 1_600 },
        { type: 'hide' }
      ]
    case 'tab-tail':
      return [
        { type: 'show', x: right - 86, y: railY },
        { type: 'play', animation: 'idle_tilt' },
        { type: 'play', animation: 'yes' },
        { type: 'hide' }
      ]
    case 'tab-climb': {
      const perchY = railY
      return [
        { type: 'show', x: anchor.left + 8, y: catClimbStartY(perchY, viewportHeight) },
        { type: 'play', animation: 'climb_1' },
        { type: 'travel', animation: 'climb_2', cycles: 3, x: anchor.left + 8, y: perchY, durationMs: 2_400 },
        { type: 'play', animation: 'climb_3' },
        { type: 'play', animation: 'climb_jump_1' },
        { type: 'move', x: anchor.left + 72, y: perchY, durationMs: 360 },
        { type: 'play', animation: 'sit_tilt' },
        { type: 'play', animation: 'climb_jump_2' },
        { type: 'hide' }
      ]
    }
    case 'closing-tab-paw':
      return [
        { type: 'show', x: right - 84, y: railY },
        { type: 'play', animation: 'scratch_start' },
        { type: 'play', animation: 'scratch_1', cycles: 3 },
        { type: 'play', animation: 'scratch_end' },
        { type: 'play', animation: 'sit_no' },
        { type: 'hide' }
      ]
    case 'new-tab-reaction':
      return [
        { type: 'show', x: anchor.left - 34, y: chromeY },
        { type: 'play', animation: 'spawn_2' },
        { type: 'play', animation: 'attack_2' },
        { type: 'play', animation: 'yes' },
        { type: 'hide' }
      ]
    case 'toolbar-patrol':
      return [
        { type: 'show', x: right + 22, y: chromeY, facing: 'left' },
        { type: 'play', animation: 'spawn_2' },
        { type: 'travel', animation: 'sneak_move', cycles: 3, x: anchor.left + Math.min(150, anchor.width * 0.28), y: chromeY, durationMs: 1_700 },
        { type: 'play', animation: 'sneak_idle' },
        { type: 'play', animation: 'idle_tilt' },
        { type: 'play', animation: 'push' },
        { type: 'turn', facing: 'right' },
        { type: 'travel', animation: 'run_2', cycles: 3, x: right + 88, y: chromeY, durationMs: 1_150 },
        { type: 'hide' }
      ]
    case 'edge-zoomies':
      return [
        { type: 'show', x: -86, y: bottomY, facing: 'right' },
        { type: 'play', animation: 'spawn_1' },
        { type: 'travel', animation: 'run_2', cycles: 5, x: window.innerWidth - 106, y: bottomY, durationMs: 2_300 },
        { type: 'play', animation: 'jump_brake' },
        { type: 'turn', facing: 'left' },
        { type: 'play', animation: 'idle_tilt' },
        { type: 'travel', animation: 'run_1', cycles: 4, x: -88, y: bottomY, durationMs: 1_850 },
        { type: 'hide' }
      ]
    case 'tab-nap': {
      const perchX = Math.max(anchor.left + 18, Math.min(right - 104, anchor.left + anchor.width * 0.62))
      const perchY = railY
      return [
        { type: 'show', x: perchX, y: catClimbStartY(perchY, viewportHeight) },
        { type: 'play', animation: 'climb_1' },
        { type: 'travel', animation: 'climb_2', cycles: 2, x: perchX, y: perchY, durationMs: 1_500 },
        { type: 'play', animation: 'climb_3' },
        { type: 'play', animation: 'sit_down' },
        { type: 'play', animation: 'rest_1' },
        { type: 'play', animation: 'dream', cycles: 3 },
        { type: 'play', animation: 'stand_up' },
        { type: 'play', animation: 'climb_jump_2' },
        { type: 'hide' }
      ]
    }
    case 'sidebar-sneak': {
      return [
        { type: 'show', x: -84, y: railY, facing: 'right' },
        { type: 'travel', animation: 'sneak_move', cycles: 3, x: Math.max(38, Math.min(right - 88, 154)), y: railY, durationMs: 1_800 },
        { type: 'play', animation: 'sneak_idle', cycles: 2 },
        { type: 'play', animation: 'idle_tilt' },
        { type: 'travel', animation: 'walk_back', cycles: 3, x: -86, y: railY, durationMs: 1_450 },
        { type: 'hide' }
      ]
    }
    case 'bookmark-paw':
      return [
        { type: 'show', x: Math.max(anchor.left + 12, right - 98), y: catChromeY(anchor, viewportHeight, 34), facing: 'left' },
        { type: 'play', animation: 'idle_lift' },
        { type: 'play', animation: 'push' },
        { type: 'play', animation: 'pull_back' },
        { type: 'play', animation: 'yes' },
        { type: 'hide' }
      ]
    case 'idle-cat':
      return [
        { type: 'show', x: 14, y: bottomY, facing: 'right' },
        { type: 'travel', animation: 'walk', cycles: 3, x: Math.min(230, window.innerWidth * 0.2), y: bottomY, durationMs: 2_400 },
        { type: 'play', animation: 'sit_down' },
        { type: 'play', animation: 'rest_1' },
        { type: 'play', animation: 'rest_2', cycles: 2 },
        { type: 'play', animation: 'dream', cycles: 4 },
        { type: 'play', animation: 'rest_4' },
        { type: 'play', animation: 'stand_up' },
        { type: 'turn', facing: 'left' },
        { type: 'travel', animation: 'walk', cycles: 3, x: -86, y: bottomY, durationMs: 2_400 },
        { type: 'hide' }
      ]
    case 'secret-meow':
      return [
        { type: 'show', x: right - 92, y: chromeY },
        { type: 'play', animation: 'spawn_2' },
        { type: 'play', animation: 'dance', cycles: 2 },
        { type: 'play', animation: 'yes' },
        { type: 'hide' }
      ]
    case 'secret-pspsps':
      return [
        { type: 'show', x: anchor.left - 74, y: chromeY, facing: 'right' },
        { type: 'play', animation: 'spawn_1' },
        { type: 'hide' },
        { type: 'show', x: right - 88, y: chromeY, facing: 'left' },
        { type: 'play', animation: 'spawn_1' },
        { type: 'play', animation: 'idle_tilt', cycles: 2 },
        { type: 'play', animation: 'jump_1' },
        { type: 'hide' }
      ]
    case 'secret-smile':
      return [
        { type: 'show', x: right - 90, y: chromeY },
        { type: 'play', animation: 'spawn_1' },
        { type: 'play', animation: 'sit_yes', cycles: 2 },
        { type: 'hide' }
      ]
    case 'secret-vast-cat':
      return [
        { type: 'show', x: anchor.left - 72, y: catClimbStartY(chromeY, viewportHeight) },
        { type: 'play', animation: 'climb_3' },
        { type: 'play', animation: 'climb_jump_1' },
        { type: 'travel', animation: 'run_2', cycles: 3, x: right - 90, y: chromeY, durationMs: 1_800 },
        { type: 'play', animation: 'attack_1' },
        { type: 'play', animation: 'dance' },
        { type: 'play', animation: 'jump_prepare' },
        { type: 'play', animation: 'jump_air' },
        { type: 'hide' }
      ]
  }
}

function reducedSceneActions(id: CatAnimationId, anchor: CatAnchor): readonly CatSceneAction[] {
  const animation = id === 'closing-tab-paw' || id === 'idle-cat'
    ? 'sit_no'
    : id === 'tab-climb'
      ? 'climb_3'
      : id.startsWith('secret-')
        ? 'sit_yes'
        : 'idle_tilt'
  return [
    {
      type: 'show',
      x: Math.max(8, Math.min(window.innerWidth - 88, anchor.left + anchor.width - 88)),
      y: clampCatY(id.includes('tab') ? catRailY(anchor, window.innerHeight) : catChromeY(anchor, window.innerHeight), window.innerHeight)
    },
    { type: 'play', animation },
    { type: 'wait', durationMs: 650 },
    { type: 'hide' }
  ]
}

function useCatActor(
  atlas: CatSpriteAtlas,
  initial: { animation: string; x: number; y: number; visible?: boolean }
): { actor: CatActor; snapshot: CatActorSnapshot } {
  const [, render] = useState(0)
  const actor = useMemo(() => new CatActor(atlas, initial, () => render((value) => value + 1)), [atlas])
  useEffect(() => () => actor.destroy(), [actor])
  return { actor, snapshot: actor.getSnapshot() }
}

export function CatAddonController({ htmlFullscreen }: { htmlFullscreen: boolean }): JSX.Element | null {
  const [state, setState] = useState<CatAddonState>(disabledState)
  const [windowState, setWindowState] = useState<CatAddonWindowState>(defaultWindowState)
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden')
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const workspace = useBrowserStore(selectActiveWorkspace)
  const activeTab = useBrowserStore(selectActiveTab)
  const layoutMode = useBrowserStore((store) => store.settings.layoutMode)

  useEffect(() => {
    let alive = true
    const applyState = (next: CatAddonState): void => {
      if (!alive) return
      setState(next)
      const store = useBrowserStore.getState()
      if (store.settings.catAddon.enabled !== next.enabled) store.updateSettings({ catAddon: { enabled: next.enabled } })
    }
    void window.vast.catAddon.status().then(applyState).catch(() => applyState(disabledState))
    void window.vast.catAddon.windowState().then((next) => { if (alive) setWindowState(next) }).catch(() => undefined)
    const unsubscribeState = window.vast.catAddon.onStateChanged(applyState)
    const unsubscribeWindow = window.vast.catAddon.onWindowStateChanged((next) => { if (alive) setWindowState(next) })
    return () => { alive = false; unsubscribeState(); unsubscribeWindow() }
  }, [])

  useEffect(() => {
    const visibilityChanged = (): void => setDocumentVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => document.removeEventListener('visibilitychange', visibilityChanged)
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const changed = (): void => setReducedMotion(query.matches)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])

  const eligible = Boolean(
    state.enabled && state.installed && !workspace?.isPrivate && !htmlFullscreen && !windowState.fullscreen &&
    windowState.visible && !windowState.minimized && documentVisible
  )
  if (!eligible) return null
  return (
    <CatRuntimeLayer
      key={`${workspace?.id ?? 'none'}:${layoutMode}`}
      workspaceId={workspace?.id}
      layoutMode={layoutMode}
      reducedMotion={reducedMotion}
      errorVisible={activeTab?.status === 'error' || activeTab?.lifecycle === 'crashed'}
    />
  )
}

function CatRuntimeLayer(props: { workspaceId?: ID; layoutMode: LayoutMode; reducedMotion: boolean; errorVisible: boolean }): JSX.Element | null {
  const [runtime, setRuntime] = useState<CatAddonRuntimeBundle>()
  useEffect(() => {
    let alive = true
    void window.vast.catAddon.runtime().then((bundle) => { if (alive) setRuntime(bundle) }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  if (!runtime) return null
  return <CatAddonActiveLayer runtime={runtime} {...props} />
}

function CatAddonActiveLayer({
  runtime,
  workspaceId,
  layoutMode,
  reducedMotion,
  errorVisible
}: {
  runtime: CatAddonRuntimeBundle
  workspaceId?: ID
  layoutMode: LayoutMode
  reducedMotion: boolean
  errorVisible: boolean
}): JSX.Element {
  const atlas = useMemo(() => new CatSpriteAtlas(runtime.metadata), [runtime.metadata])
  const resident = useCatActor(atlas, { animation: 'idle_1', x: window.innerWidth - 76, y: window.innerHeight - 66 })
  const scene = useCatActor(atlas, { animation: 'idle_1', x: 0, y: 0, visible: false })
  const director = useMemo(() => new CatSceneDirector(scene.actor), [scene.actor])
  const residentDirector = useMemo(() => new CatSceneDirector(resident.actor), [resident.actor])
  const [active, setActive] = useState<ActiveCatAnimation | null>(null)
  const [sceneStartCount, setSceneStartCount] = useState(0)
  const schedulerRef = useRef<CatAnimationScheduler | null>(null)
  const activeRef = useRef<ActiveCatAnimation | null>(null)
  activeRef.current = active
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion
  const sceneAnchor = active ? anchorFor(active.id) : anchorFor('idle-cat')
  const sceneClipStyle = {
    '--cat-clip-top': `${Math.max(0, sceneAnchor.top - 72)}px`,
    '--cat-clip-right': `${Math.max(0, window.innerWidth - sceneAnchor.left - sceneAnchor.width - 88)}px`,
    '--cat-clip-bottom': `${Math.max(0, window.innerHeight - sceneAnchor.top - sceneAnchor.height - 112)}px`,
    '--cat-clip-left': `${Math.max(0, sceneAnchor.left - 112)}px`
  } as CSSProperties
  const sceneUsesClip = active && [
    'omnibox-peek', 'paw-swat', 'bookmark-paw', 'closing-tab-paw', 'new-tab-reaction'
  ].includes(active.id)

  useEffect(() => () => director.destroy(), [director])
  useEffect(() => () => residentDirector.destroy(), [residentDirector])
  useEffect(() => {
    if (!active) { director.cancel(); scene.actor.hide(); return }
    const anchor = anchorFor(active.id)
    const actions = active.reducedMotion ? reducedSceneActions(active.id, anchor) : sceneActions(active.id, anchor)
    void director.run(actions, active.reducedMotion).then((result) => { if (result === 'completed') scene.actor.hide() })
    return () => director.cancel()
  }, [active, director, scene.actor])

  useEffect(() => {
    document.documentElement.dataset.catAddonEnabled = 'true'
    let alive = true
    const scheduler = new CatAnimationScheduler({
      eligible: () => document.visibilityState !== 'hidden',
      startupQuietMs: 3_000,
      globalCooldownMs: 9_000,
      interactionCooldownMs: 2_800,
      onAnimationChanged: (animation) => {
        if (!alive) return
        if (animation) setSceneStartCount((count) => count + 1)
        setActive(animation)
      }
    })
    schedulerRef.current = scheduler
    let idleTimer: number | undefined
    let ambientTimer: number | undefined
    let ambientIndex = 0
    const armIdle = (): void => {
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => scheduler.request('idle-cat', { probability: 1, reducedMotion: reducedMotionRef.current }), 62_000)
    }
    const armAmbient = (delayMs = 3_000): void => {
      window.clearTimeout(ambientTimer)
      ambientTimer = window.setTimeout(() => {
        if (document.querySelector('.settings-modal-shell')) {
          armAmbient(1_200)
          return
        }
        const candidates = catAmbientSceneOrder(layoutMode, Boolean(document.querySelector('.horizontal-bookmarks-bar')))
        const id = candidates[ambientIndex++ % candidates.length]
        scheduler.request(id, { probability: 1, reducedMotion: reducedMotionRef.current })
        armAmbient(11_000 + ambientIndex % 4 * 1_500)
      }, delayMs)
    }
    const activity = (): void => { scheduler.cancel((animation) => animation.id === 'idle-cat'); armIdle() }
    const omniboxFocus = (): void => {
      scheduler.request('omnibox-peek', { interaction: true, probability: 0.9, reducedMotion: reducedMotionRef.current })
    }
    const omniboxInput = (event: Event): void => {
      const value = eventDetail<{ value?: unknown }>(event)?.value
      if (typeof value !== 'string') return
      const secret = secretAnimation(value)
      if (secret) { scheduler.requestSecret(value, secret, reducedMotionRef.current); return }
      scheduler.clearSecret()
      if (value.trim().length < 3) return
      const animation: CatAnimationId = value.length % 7 === 0 ? 'paw-swat' : 'omnibox-peek'
      scheduler.request(animation, {
        interaction: true,
        probability: animation === 'paw-swat' ? 0.52 : 0.68,
        reducedMotion: reducedMotionRef.current
      })
    }
    const omniboxBlur = (): void => {
      scheduler.clearSecret()
    }
    const newTabButton = (): void => {
      scheduler.request('new-tab-reaction', { interaction: true, probability: 1, reducedMotion: reducedMotionRef.current })
    }
    const tabClosing = (): void => {
      scheduler.request('closing-tab-paw', { interaction: true, probability: 0.96, reducedMotion: reducedMotionRef.current })
    }
    const preview = (event: Event): void => {
      const id = eventDetail<{ id?: CatAnimationId }>(event)?.id
      if (id) scheduler.request(id, { force: true, reducedMotion: reducedMotionRef.current })
    }
    const resize = (): void => { scheduler.cancel(); armAmbient(5_000) }
    const pointerActivity = (event: PointerEvent): void => {
      activity()
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (target.closest('[data-bookmark-item]')) {
        scheduler.request('bookmark-paw', { interaction: true, probability: 0.84, reducedMotion: reducedMotionRef.current })
        return
      }
      const titledButton = target.closest<HTMLElement>('button[title]')
      const title = titledButton?.title.toLowerCase() ?? ''
      if (title.includes('workspace') || title.includes('sidebar')) {
        scheduler.request(layoutMode === 'vertical' ? 'sidebar-sneak' : 'toolbar-patrol', {
          interaction: true, probability: 0.58, reducedMotion: reducedMotionRef.current
        })
      } else if (title === 'reload' || title === 'refresh') {
        scheduler.request('toolbar-patrol', { interaction: true, probability: 0.64, reducedMotion: reducedMotionRef.current })
      }
    }

    let previousTabs = new Set(useBrowserStore.getState().tabs.filter((tab) => tab.workspaceId === workspaceId).map((tab) => tab.id))
    let previousActiveTabId = useBrowserStore.getState().workspaces.find((item) => item.id === workspaceId)?.activeTabId
    let previousActiveStatus = useBrowserStore.getState().tabs.find((tab) => tab.id === previousActiveTabId)?.status
    const unsubscribeStore = useBrowserStore.subscribe((store) => {
      const nextTabs = new Set(store.tabs.filter((tab) => tab.workspaceId === workspaceId).map((tab) => tab.id))
      const activeTabId = store.workspaces.find((item) => item.id === workspaceId)?.activeTabId
      if ([...nextTabs].some((id) => !previousTabs.has(id))) {
        const sceneId: CatAnimationId = nextTabs.size % 4 === 0 ? 'tab-climb' : 'tab-run'
        scheduler.request(sceneId, { interaction: true, probability: 0.74, reducedMotion: reducedMotionRef.current })
      } else if (activeTabId && activeTabId !== previousActiveTabId) {
        scheduler.request('tab-tail', { interaction: true, probability: 0.62, reducedMotion: reducedMotionRef.current })
      } else {
        const activeStatus = store.tabs.find((tab) => tab.id === activeTabId)?.status
        if (activeStatus === 'idle' && previousActiveStatus === 'loading') {
          scheduler.request('toolbar-patrol', { interaction: true, probability: 0.48, reducedMotion: reducedMotionRef.current })
        }
      }
      previousTabs = nextTabs
      previousActiveTabId = activeTabId
      previousActiveStatus = store.tabs.find((tab) => tab.id === activeTabId)?.status
    })

    window.addEventListener(CAT_ADDON_EVENT.omniboxFocus, omniboxFocus)
    window.addEventListener(CAT_ADDON_EVENT.omniboxInput, omniboxInput)
    window.addEventListener(CAT_ADDON_EVENT.omniboxBlur, omniboxBlur)
    window.addEventListener(CAT_ADDON_EVENT.newTabButton, newTabButton)
    window.addEventListener(CAT_ADDON_EVENT.tabClosing, tabClosing)
    window.addEventListener(CAT_ADDON_EVENT.previewScene, preview)
    window.addEventListener('pointerdown', pointerActivity, { capture: true, passive: true })
    window.addEventListener('keydown', activity, { capture: true })
    window.addEventListener('wheel', activity, { capture: true, passive: true })
    window.addEventListener('resize', resize)
    armIdle()
    armAmbient()
    return () => {
      alive = false
      delete document.documentElement.dataset.catAddonEnabled
      window.clearTimeout(idleTimer)
      window.clearTimeout(ambientTimer)
      unsubscribeStore()
      scheduler.dispose()
      schedulerRef.current = null
      window.removeEventListener(CAT_ADDON_EVENT.omniboxFocus, omniboxFocus)
      window.removeEventListener(CAT_ADDON_EVENT.omniboxInput, omniboxInput)
      window.removeEventListener(CAT_ADDON_EVENT.omniboxBlur, omniboxBlur)
      window.removeEventListener(CAT_ADDON_EVENT.newTabButton, newTabButton)
      window.removeEventListener(CAT_ADDON_EVENT.tabClosing, tabClosing)
      window.removeEventListener(CAT_ADDON_EVENT.previewScene, preview)
      window.removeEventListener('pointerdown', pointerActivity, { capture: true })
      window.removeEventListener('keydown', activity, { capture: true })
      window.removeEventListener('wheel', activity, { capture: true })
      window.removeEventListener('resize', resize)
    }
  }, [layoutMode, workspaceId])

  useEffect(() => {
    if (reducedMotion && active && !active.reducedMotion) schedulerRef.current?.cancel()
  }, [active, reducedMotion])

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    let index = 0
    const position = (): void => {
      residentDirector.cancel()
      resident.actor.show(Math.max(10, window.innerWidth - 76), window.innerHeight - 66)
    }
    const routine = (routineIndex: number): readonly CatSceneAction[] => {
      const homeX = Math.max(10, window.innerWidth - 76)
      const floorY = window.innerHeight - 66
      switch (routineIndex % 5) {
        case 0:
          return [
            { type: 'show', x: homeX, y: floorY, facing: 'left' },
            { type: 'play', animation: 'idle_tilt' },
            { type: 'play', animation: 'yes' },
            { type: 'turn', facing: 'right' }
          ]
        case 1:
          return [
            { type: 'show', x: homeX, y: floorY },
            { type: 'play', animation: 'scratch_start' },
            { type: 'play', animation: 'scratch_2', cycles: 2 },
            { type: 'play', animation: 'scratch_end' },
            { type: 'play', animation: 'sit' }
          ]
        case 2:
          return [
            { type: 'show', x: homeX, y: floorY, facing: 'left' },
            { type: 'travel', animation: 'walk', cycles: 2, x: Math.max(16, homeX - 120), y: floorY, durationMs: 1_450 },
            { type: 'play', animation: 'stop' },
            { type: 'play', animation: 'idle_tilt' },
            { type: 'turn', facing: 'right' },
            { type: 'travel', animation: 'walk', cycles: 2, x: homeX, y: floorY, durationMs: 1_450 },
            { type: 'play', animation: 'sit' }
          ]
        case 3:
          return [
            { type: 'show', x: homeX, y: floorY },
            { type: 'play', animation: 'sit_down' },
            { type: 'play', animation: 'rest_1' },
            { type: 'wait', durationMs: 900 },
            { type: 'play', animation: 'stand_up' },
            { type: 'play', animation: 'sit' }
          ]
        default:
          return [
            { type: 'show', x: homeX, y: floorY },
            { type: 'play', animation: 'sit_lift' },
            { type: 'play', animation: 'sit_yes' },
            { type: 'play', animation: 'idle_3' }
          ]
      }
    }
    const schedule = (delayMs = 2_400): void => {
      timer = window.setTimeout(async () => {
        if (!alive) return
        if (!activeRef.current && !errorVisible) await residentDirector.run(routine(index++), reducedMotion)
        if (alive) schedule(6_500 + index % 4 * 1_300)
      }, delayMs)
    }
    position()
    window.addEventListener('resize', position)
    schedule()
    return () => {
      alive = false
      window.clearTimeout(timer)
      window.removeEventListener('resize', position)
      residentDirector.cancel()
    }
  }, [errorVisible, reducedMotion, resident.actor, residentDirector, workspaceId])

  useEffect(() => {
    if (!errorVisible) return
    resident.actor.cancel()
    void resident.actor.play('sit_no', { cycles: 2, reducedMotion }).then(() => resident.actor.play('sit', { cycles: 2, reducedMotion }))
  }, [errorVisible, reducedMotion, resident.actor])

  useEffect(() => {
    resident.actor.animator.setVisible(document.visibilityState !== 'hidden')
    scene.actor.animator.setVisible(document.visibilityState !== 'hidden')
  }, [resident.actor, scene.actor])

  return (
    <div className="cat-addon-layer" aria-hidden="true" role="presentation" data-testid="cat-addon-layer" data-active-scene={active?.id ?? ''} data-scene-start-count={sceneStartCount} data-cat-count={1 + (scene.snapshot.visible ? 1 : 0)}>
      <div data-testid="cat-addon-resident" data-resident-motion={resident.snapshot.animationId}>
        <CatSprite runtime={runtime} actor={resident.snapshot} className={active ? 'cat-actor--quiet' : ''} />
      </div>
      <div className={`cat-scene-surface${sceneUsesClip ? ' cat-scene-surface--clipped' : ''}`} style={sceneClipStyle}>
        <CatSprite runtime={runtime} actor={scene.snapshot} className="cat-actor--scene" desiredScale={CAT_SCENE_SCALE} />
        {(active?.id === 'paw-swat' || active?.id === 'bookmark-paw') && (
          <span className="cat-paw-spark" style={{ left: sceneAnchor.left + sceneAnchor.width - 22, top: sceneAnchor.top + sceneAnchor.height / 2 }} />
        )}
        {active?.id === 'edge-zoomies' && <span className="cat-motion-dust" />}
        {active?.id === 'tab-nap' && <span className="cat-dream-pixel">z</span>}
      </div>
    </div>
  )
}
