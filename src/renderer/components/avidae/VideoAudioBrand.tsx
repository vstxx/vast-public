import videoAudioArtwork from '../../../../resources/avidae/static/video-audio.png'
import { useId } from 'react'

interface VideoAudioMarkProps {
  className?: string
  strokeWidth?: number
}

export function VideoAudioMark({ className = '' }: VideoAudioMarkProps): JSX.Element {
  const colorFilterId = useId()

  return (
    <svg
      className={`video-audio-source-mark ${className}`}
      viewBox="402 135 122 122"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id={colorFilterId} colorInterpolationFilters="sRGB">
          <feFlood floodColor="currentColor" result="accent" />
          <feComposite in="accent" in2="SourceAlpha" operator="in" />
        </filter>
      </defs>
      <image href={videoAudioArtwork} x="0" y="0" width="1584" height="396" filter={`url(#${colorFilterId})`} />
    </svg>
  )
}

interface VideoAudioBrandProps {
  className?: string
}

export function VideoAudioBrand({ className = '' }: VideoAudioBrandProps): JSX.Element {
  return (
    <svg
      className={`video-audio-source-lockup ${className}`}
      viewBox="402 135 824 122"
      role="img"
      aria-label="Video & Audio"
      focusable="false"
    >
      <image href={videoAudioArtwork} x="0" y="0" width="1584" height="396" />
    </svg>
  )
}
