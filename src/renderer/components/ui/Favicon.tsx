import { Activity, Database, FileText, Globe2, History, LayoutGrid, NotebookPen, Sparkles, Wifi } from 'lucide-react'
import type { ComponentType } from 'react'
import {
  INTERNAL_AUTOMATION_URL,
  INTERNAL_AVIDAE_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_NEW_TAB_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_PDF_VIEWER_URL,
  INTERNAL_SESSION_TIMELINE_URL,
  INTERNAL_SITE_DATA_URL
} from '../../../shared/constants'
import { hostnameFor, isInternalUrl, matchesInternalUrl } from '../../lib/url'
import { VideoAudioMark } from '../avidae/VideoAudioBrand'

interface FaviconProps {
  url?: string
  favicon?: string
  title?: string
  className?: string
}

interface InternalIconProps {
  className?: string
  strokeWidth?: number
}

interface InternalTabMeta {
  icon: ComponentType<InternalIconProps>
  iconClassName: string
  tabClassName: string
  activeTabClassName: string
  labelClassName: string
}

const subtleInternalLabelClassName = 'text-inherit'

function internalMeta(icon: ComponentType<InternalIconProps>, iconClassName: string, tint: string): InternalTabMeta {
  return {
    icon,
    iconClassName,
    tabClassName: `border-white/4 ${tint} text-vast-soft hover:border-white/10 hover:bg-white/6 hover:text-white`,
    activeTabClassName: `border-white/11 ${tint} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_12px_32px_rgba(0,0,0,0.18)]`,
    labelClassName: subtleInternalLabelClassName
  }
}

export function getInternalTabMeta(url?: string): InternalTabMeta | null {
  if (!url) return null

  if (url === INTERNAL_AVIDAE_URL) {
    return internalMeta(VideoAudioMark, 'bg-white/5.5 ring-1 ring-white/8', 'bg-[linear-gradient(135deg,rgba(118,18,154,0.06),rgba(255,255,255,0.022))]')
  }

  if (url === INTERNAL_AUTOMATION_URL) {
    return internalMeta(Sparkles, 'bg-[#cf8cff]/13 text-[#e6bbff] ring-1 ring-white/8', 'bg-[linear-gradient(135deg,rgba(207,140,255,0.045),rgba(255,255,255,0.022))]')
  }

  if (url === INTERNAL_NETWORK_URL) {
    return internalMeta(Wifi, 'bg-[#44f6d8]/12 text-[#8fffee] ring-1 ring-white/8', 'bg-[linear-gradient(135deg,rgba(68,246,216,0.044),rgba(255,255,255,0.022))]')
  }

  if (url === INTERNAL_NOTES_URL) {
    return internalMeta(NotebookPen, 'bg-[#8fa1ff]/13 text-[#c8cfff] ring-1 ring-white/8', 'bg-[linear-gradient(135deg,rgba(143,161,255,0.045),rgba(255,255,255,0.022))]')
  }

  if (matchesInternalUrl(url, INTERNAL_PDF_VIEWER_URL)) {
    return internalMeta(FileText, 'bg-[#ffb684]/13 text-[#ffd8b0] ring-1 ring-white/8', 'bg-[linear-gradient(135deg,rgba(255,182,132,0.046),rgba(255,255,255,0.022))]')
  }

  if (url === INTERNAL_SITE_DATA_URL) {
    return internalMeta(Database, 'bg-[#afbbff]/13 text-[#dde2ff] ring-1 ring-white/8', 'bg-[linear-gradient(135deg,rgba(175,187,255,0.045),rgba(255,255,255,0.022))]')
  }

  if (url === INTERNAL_DIAGNOSTICS_URL) {
    return internalMeta(Activity, 'bg-[#ff89ac]/13 text-[#ffc2d2] ring-1 ring-white/8', 'bg-[linear-gradient(135deg,rgba(255,137,172,0.045),rgba(255,255,255,0.022))]')
  }

  if (url === INTERNAL_SESSION_TIMELINE_URL) {
    return internalMeta(History, 'bg-[#7cc8ff]/13 text-[#caecff] ring-1 ring-white/8', 'bg-[linear-gradient(135deg,rgba(124,200,255,0.045),rgba(255,255,255,0.022))]')
  }

  if (url === INTERNAL_NEW_TAB_URL) {
    return {
      icon: LayoutGrid,
      iconClassName: 'bg-white/5.5 text-white/55 ring-1 ring-white/8',
      tabClassName: 'border-transparent text-vast-soft hover:border-white/[0.07] hover:bg-white/5 hover:text-white',
      activeTabClassName: 'border-white/10 bg-white/7.5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]',
      labelClassName: 'text-inherit'
    }
  }

  return null
}

export function Favicon({ url, favicon, title, className = '' }: FaviconProps): JSX.Element {
  if (favicon) {
    return <img src={favicon} alt="" className={`h-4 w-4 rounded-micro object-cover ${className}`} />
  }

  if (url && !isInternalUrl(url)) {
    const host = hostnameFor(url)
    const letter = (title || host || '*').trim().charAt(0).toUpperCase()
    return (
      <span
        className={`grid h-4 w-4 place-items-center rounded-micro bg-white/10 text-[9px] font-semibold text-white/80 ${className}`}
      >
        {letter}
      </span>
    )
  }

  const internalMeta = getInternalTabMeta(url)
  if (internalMeta) {
    const Icon = internalMeta.icon
    return (
      <span className={`grid h-4 w-4 place-items-center rounded-micro ${internalMeta.iconClassName} ${className}`}>
        <Icon className="h-[10px] w-[10px]" strokeWidth={2.2} />
      </span>
    )
  }

  return <Globe2 className={`h-4 w-4 text-vast-cyan ${className}`} aria-hidden />
}
