import { Check, Pipette } from 'lucide-react'
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
      className={`workspace-appearance-picker rounded-2xl border border-white/[0.1] bg-[#0b0c11] shadow-glass ${compact ? 'p-2.5' : 'p-3'}`}
      data-testid="workspace-appearance-picker"
      data-workspace-id={workspaceId}
    >
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">Icon</div>
      <div className={`grid gap-1.5 ${compact ? 'grid-cols-6' : 'grid-cols-9'}`}>
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
              className={`relative grid h-8 w-8 place-items-center rounded-lg border transition ${
                active
                  ? 'border-white/[0.24] bg-white/[0.13] text-white'
                  : 'border-transparent text-white/45 hover:border-white/[0.1] hover:bg-white/[0.07] hover:text-white'
              }`}
              style={active ? { color } : undefined}
            >
              <WorkspaceIcon name={option.name} className="h-3.5 w-3.5" />
            </button>
          )
        })}
      </div>

      <div className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">Color</div>
      <div className={`grid gap-2 ${compact ? 'grid-cols-6' : 'grid-cols-12'}`}>
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
              className="relative grid h-7 w-7 place-items-center justify-self-center rounded-full border border-white/[0.14] transition hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              style={{ backgroundColor: option.value }}
            >
              {active && <Check className="h-3.5 w-3.5 text-[#07080b]" strokeWidth={3} />}
            </button>
          )
        })}
      </div>
      <label
        className="relative mt-2.5 flex h-8 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg border border-dashed border-white/[0.18] text-[11px] font-medium text-white/55 transition hover:border-white/[0.34] hover:bg-white/[0.05] hover:text-white"
        title="Choose custom color"
      >
        <Pipette className="pointer-events-none h-3.5 w-3.5" />
        <span>Custom color</span>
        <span className="pointer-events-none h-3.5 w-3.5 rounded-full border border-white/20" style={{ backgroundColor: color }} />
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
