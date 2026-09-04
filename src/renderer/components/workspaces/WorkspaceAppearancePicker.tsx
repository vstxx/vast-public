import { Pipette } from 'lucide-react'
import { WORKSPACE_ICON_OPTIONS, WorkspaceIcon } from './WorkspaceIcon'

export const WORKSPACE_COLOR_OPTIONS = [
  { value: '#74e7ff', label: 'Cyan' },
  { value: '#60a5fa', label: 'Blue' },
  { value: '#818cf8', label: 'Indigo' },
  { value: '#b7a7ff', label: 'Lilac' },
  { value: '#c084fc', label: 'Purple' },
  { value: '#f472b6', label: 'Pink' },
  { value: '#fb7185', label: 'Rose' },
  { value: '#fb923c', label: 'Orange' },
  { value: '#facc15', label: 'Yellow' },
  { value: '#a3e635', label: 'Lime' },
  { value: '#4ade80', label: 'Green' },
  { value: '#2dd4bf', label: 'Teal' }
] as const

interface WorkspaceAppearancePickerProps {
  workspaceId: string
  icon: string
  color: string
  onChange: (patch: { icon?: string; color?: string }) => void
  compact?: boolean
}

export function WorkspaceAppearancePicker({ workspaceId, icon, color, onChange, compact = false }: WorkspaceAppearancePickerProps): JSX.Element {
  return (
    <div
      className={`workspace-appearance-picker rounded-xl bg-white/[0.025] ${compact ? 'p-2' : 'p-2.5'}`}
      data-testid="workspace-appearance-picker"
      data-workspace-id={workspaceId}
    >
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">Icon</div>
      <div className={`grid gap-1 ${compact ? 'grid-cols-6' : 'grid-cols-9'}`}>
        {WORKSPACE_ICON_OPTIONS.map((option) => {
          const active = option.name === icon
          return (
            <button
              key={option.name}
              type="button"
              title={`Use ${option.label} icon`}
              aria-label={`Use ${option.label} icon`}
              aria-pressed={active}
              onClick={() => onChange({ icon: option.name })}
              className={`relative grid h-7 w-7 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50 ${
                active
                  ? 'bg-white/[0.1] text-white'
                  : 'text-white/42 hover:bg-white/[0.055] hover:text-white/75'
              }`}
              style={active ? { color } : undefined}
            >
              <WorkspaceIcon name={option.name} className="h-3.5 w-3.5" />
            </button>
          )
        })}
      </div>

      <div className="mb-1.5 mt-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">Color</div>
      <div className={`grid gap-1.5 ${compact ? 'grid-cols-6' : 'grid-cols-12'}`}>
        {WORKSPACE_COLOR_OPTIONS.map((option) => {
          const active = option.value.toLowerCase() === color.toLowerCase()
          return (
            <button
              key={option.value}
              type="button"
              title={`Use ${option.label} color`}
              aria-label={`Use ${option.label} color`}
              aria-pressed={active}
              onClick={() => onChange({ color: option.value })}
              className={`relative h-6 w-6 justify-self-center rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c11] ${active ? 'ring-2 ring-white/75 ring-offset-2 ring-offset-[#0b0c11]' : ''}`}
              style={{ backgroundColor: option.value }}
            />
          )
        })}
      </div>
      <label
        className="relative mt-2 flex h-7 w-fit cursor-pointer items-center gap-1.5 overflow-hidden rounded-md bg-white/[0.04] px-2.5 text-[11px] font-medium text-white/55 transition-colors hover:bg-white/[0.075] hover:text-white/80 focus-within:ring-1 focus-within:ring-white/50"
        title="Choose custom color"
      >
        <Pipette className="pointer-events-none h-3.5 w-3.5" />
        <span>Custom</span>
        <span className="pointer-events-none h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
        <input
          type="color"
          aria-label="Choose custom workspace color"
          value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#74e7ff'}
          onChange={(event) => onChange({ color: event.target.value })}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  )
}
