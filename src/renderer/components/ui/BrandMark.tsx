import vastIcon from '../../../../assets/logos/vasticon.png'
import vastWordmark from '../../../../assets/logos/vast.png'

export function BrandMark({ compact = false }: { compact?: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <img
        src={vastIcon}
        alt="Vast"
        draggable={false}
        className="h-9 w-9 shrink-0 origin-center scale-110 select-none object-contain"
      />
      {!compact && (
        <svg
          viewBox="553 120 477 160"
          aria-hidden="true"
          focusable="false"
          className="pointer-events-none h-[18px] w-auto shrink-0 select-none overflow-visible"
        >
          <image href={vastWordmark} width="1584" height="396" />
        </svg>
      )}
    </div>
  )
}
