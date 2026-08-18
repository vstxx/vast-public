import { useMemo, type CSSProperties } from 'react'
import { catScaleForDpi, snapCatCoordinate, type CatAddonRuntimeBundle } from '../../../shared/cat-addon-runtime'
import type { CatActorSnapshot } from './cat-engine'

type CatSpriteStyle = CSSProperties & Record<`--cat-${string}`, string | number>

export function CatSprite({
  runtime,
  actor,
  className = '',
  desiredScale = 2
}: {
  runtime: CatAddonRuntimeBundle
  actor: CatActorSnapshot
  className?: string
  desiredScale?: number
}): JSX.Element {
  const style = useMemo(() => {
    const dpr = window.devicePixelRatio || 1
    const scale = catScaleForDpi(dpr, desiredScale)
    return {
      '--cat-x': `${snapCatCoordinate(actor.x, dpr)}px`,
      '--cat-y': `${snapCatCoordinate(actor.y, dpr)}px`,
      '--cat-transition-ms': `${actor.transitionMs}ms`,
      '--cat-frame-size': `${runtime.metadata.atlas.frame_width * scale}px`,
      '--cat-atlas-width': `${runtime.metadata.atlas.width * scale}px`,
      '--cat-atlas-height': `${runtime.metadata.atlas.height * scale}px`,
      '--cat-atlas-x': `${-actor.atlasX * scale}px`,
      '--cat-atlas-y': `${-actor.atlasY * scale}px`,
      '--cat-facing': actor.facing === 'left' ? -1 : 1,
      backgroundImage: `url("${runtime.atlasDataUrl}")`
    } as CatSpriteStyle
  }, [actor, desiredScale, runtime])

  return (
    <div
      className={`cat-actor ${actor.visible ? 'cat-actor--visible' : ''} ${className}`}
      style={{
        '--cat-x': style['--cat-x'],
        '--cat-y': style['--cat-y'],
        '--cat-transition-ms': style['--cat-transition-ms'],
        '--cat-frame-size': style['--cat-frame-size']
      } as CatSpriteStyle}
      data-animation={actor.animationId}
      data-cat-x={actor.x}
      data-cat-y={actor.y}
      data-source-frame={actor.sourceFrame}
      data-source-character="Cat_Grey_White"
      data-cat-entity="true"
    >
      <span className="cat-sprite" style={style} />
    </div>
  )
}
