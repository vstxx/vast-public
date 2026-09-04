import { Check, ChevronDown } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

export interface VastSelectOption<T extends string | number = string> {
  value: T
  label: string
  description?: string
  disabled?: boolean
  icon?: ReactNode
}

export type VastSelectSize = 'short' | 'medium' | 'long'

interface VastSelectProps<T extends string | number> {
  value: T
  options: readonly VastSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
  placeholder?: string
  className?: string
  buttonClassName?: string
  menuClassName?: string
  align?: 'start' | 'end'
  size?: VastSelectSize
  dataSettingsSelect?: string
}

interface MenuPosition {
  left: number
  top: number
  minWidth: number
  maxWidth: number
  maxHeight: number
  placement: 'top' | 'bottom'
}

const viewportPadding = 10
const menuGap = 7

function enabledOptionIndexes<T extends string | number>(options: readonly VastSelectOption<T>[]): number[] {
  return options.flatMap((option, index) => option.disabled ? [] : [index])
}

export function VastSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = 'Select',
  className = '',
  buttonClassName = '',
  menuClassName = '',
  align = 'end',
  size,
  dataSettingsSelect
}: VastSelectProps<T>): JSX.Element {
  const controlId = useId().replace(/:/g, '')
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const active = options[selectedIndex]
  const enabledIndexes = useMemo(() => enabledOptionIndexes(options), [options])

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setPosition(null)
    if (restoreFocus) window.requestAnimationFrame(() => buttonRef.current?.focus())
  }, [])

  const calculatePosition = useCallback(() => {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const estimatedHeight = Math.min(304, Math.max(52, options.length * 44 + 12))
    const availableBelow = viewportHeight - rect.bottom - menuGap - viewportPadding
    const availableAbove = rect.top - menuGap - viewportPadding
    const placement: MenuPosition['placement'] = availableBelow < Math.min(180, estimatedHeight) && availableAbove > availableBelow ? 'top' : 'bottom'
    const availableHeight = placement === 'bottom' ? availableBelow : availableAbove
    const maxHeight = Math.max(92, Math.min(304, availableHeight))
    const maxWidth = Math.max(176, Math.min(448, viewportWidth - viewportPadding * 2))
    const minWidth = Math.min(Math.max(rect.width, 176), maxWidth)
    const renderedMenu = menuRef.current?.getBoundingClientRect()
    const renderedWidth = Math.min(Math.max(renderedMenu?.width ?? minWidth, minWidth), maxWidth)
    const preferredLeft = align === 'end' ? rect.right - renderedWidth : rect.left
    const left = Math.min(Math.max(viewportPadding, preferredLeft), viewportWidth - renderedWidth - viewportPadding)
    const renderedHeight = Math.min(renderedMenu?.height ?? estimatedHeight, maxHeight)
    const preferredTop = placement === 'bottom'
      ? rect.bottom + menuGap
      : rect.top - menuGap - renderedHeight
    const maximumTop = Math.max(viewportPadding, viewportHeight - renderedHeight - viewportPadding)
    const top = Math.min(Math.max(viewportPadding, preferredTop), maximumTop)
    setPosition({ left, top, minWidth, maxWidth, maxHeight, placement })
  }, [align, options.length])

  const openMenu = useCallback((preferredIndex = selectedIndex) => {
    if (disabled || enabledIndexes.length === 0) return
    const initial = options[preferredIndex]?.disabled ? enabledIndexes[0] : preferredIndex
    setHighlightedIndex(initial)
    setOpen(true)
  }, [disabled, enabledIndexes, options, selectedIndex])

  const choose = useCallback((index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    close(true)
  }, [close, onChange, options])

  const moveHighlight = useCallback((direction: 1 | -1) => {
    if (enabledIndexes.length === 0) return
    const current = enabledIndexes.indexOf(highlightedIndex)
    const base = current >= 0 ? current : 0
    const next = (base + direction + enabledIndexes.length) % enabledIndexes.length
    setHighlightedIndex(enabledIndexes[next])
  }, [enabledIndexes, highlightedIndex])

  useLayoutEffect(() => {
    if (!open) return
    calculatePosition()
    const update = (): void => calculatePosition()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    if (buttonRef.current) observer?.observe(buttonRef.current)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
    }
  }, [calculatePosition, open])

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!open || !position || !menu) return
    calculatePosition()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => calculatePosition())
    observer.observe(menu)
    return () => observer.disconnect()
  }, [calculatePosition, open, position?.maxHeight, position?.maxWidth, position?.minWidth])

  useEffect(() => {
    if (!open || !position) return
    window.requestAnimationFrame(() => {
      menuRef.current?.focus()
      menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${highlightedIndex}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }, [open, position, highlightedIndex])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close()
    }
    const onBlur = (): void => close()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [close, open])

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== undefined) window.clearTimeout(typeaheadTimerRef.current)
  }, [])

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(event.key === 'ArrowDown' ? selectedIndex : enabledIndexes.at(-1) ?? selectedIndex)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open ? close() : openMenu()
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const index = event.key === 'Home' ? enabledIndexes[0] : enabledIndexes.at(-1)
      if (index !== undefined) setHighlightedIndex(index)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(highlightedIndex)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      close()
      return
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    typeaheadRef.current += event.key.toLocaleLowerCase()
    if (typeaheadTimerRef.current !== undefined) window.clearTimeout(typeaheadTimerRef.current)
    typeaheadTimerRef.current = window.setTimeout(() => { typeaheadRef.current = '' }, 650)
    const match = options.findIndex((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(typeaheadRef.current))
    if (match >= 0) setHighlightedIndex(match)
  }

  const menuStyle: CSSProperties | undefined = position ? {
    left: position.left,
    top: position.top,
    width: 'max-content',
    minWidth: position.minWidth,
    maxWidth: position.maxWidth,
    maxHeight: position.maxHeight,
    transformOrigin: position.placement === 'bottom' ? 'top' : 'bottom'
  } : undefined
  const shell = buttonRef.current?.closest('.app-shell')
  const portalThemeClass = shell?.classList.contains('light-theme')
    ? 'light-theme'
    : shell?.classList.contains('dim-theme') ? 'dim-theme' : 'dark-theme'

  return (
    <div
      className={`vast-select-control ${size ? `vast-select-size-${size}` : ''} ${className}`.trim()}
      data-vast-select={ariaLabel}
      data-vast-select-size={size}
      data-settings-select={dataSettingsSelect}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        ref={buttonRef}
        id={`${controlId}-button`}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${controlId}-listbox` : undefined}
        className={`vast-select-button ${buttonClassName}`.trim()}
        onClick={() => open ? close() : openMenu()}
        onKeyDown={onButtonKeyDown}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {active?.icon && <span className="vast-select-leading-icon">{active.icon}</span>}
          <span className={`truncate ${active ? '' : 'text-vast-soft'}`}>{active?.label ?? placeholder}</span>
        </span>
        <span className="vast-select-trailing-icon" aria-hidden="true">
          <ChevronDown className={`h-4 w-4 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && position && createPortal(
        <div className={portalThemeClass} data-vast-select-portal-theme style={{ display: 'contents' }}>
          <div
            ref={menuRef}
            id={`${controlId}-listbox`}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-activedescendant={`${controlId}-option-${highlightedIndex}`}
            className={`vast-select-menu ${menuClassName}`.trim()}
            style={menuStyle}
            data-placement={position.placement}
            onKeyDown={onMenuKeyDown}
          >
            {options.map((option, index) => {
              const selected = option.value === value
              const highlighted = index === highlightedIndex
              return (
                <button
                  key={option.value}
                  id={`${controlId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled || undefined}
                  disabled={option.disabled}
                  data-value={option.value}
                  data-option-index={index}
                  className={`vast-select-option ${selected ? 'is-active' : ''} ${highlighted ? 'is-highlighted' : ''}`.trim()}
                  onMouseEnter={() => !option.disabled && setHighlightedIndex(index)}
                  onClick={() => choose(index)}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {option.icon && <span className="vast-select-leading-icon">{option.icon}</span>}
                    <span className="vast-select-option-copy">
                      <span className="vast-select-option-label" title={option.label}>{option.label}</span>
                      {option.description && <span className="vast-select-description">{option.description}</span>}
                    </span>
                  </span>
                  <span className="vast-select-check" aria-hidden="true">{selected && <Check className="h-4 w-4" />}</span>
                </button>
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
