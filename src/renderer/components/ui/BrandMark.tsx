import vastIcon from '../../../../assets/logos/vasticon.png'
import vastWordmark from '../../../../assets/logos/vast.png'

export function BrandMark({ compact = false }: { compact?: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <img
        src={vastIcon}
        alt="Vast"
        draggable={false}
        className={`shrink-0 origin-center select-none object-contain drop-shadow-[0_0_10px_rgba(116,231,255,0.28)] ${
          compact ? 'h-8 w-8 scale-[1.12]' : 'h-9 w-9 scale-110'
        }`}
      />
      {!compact && (
        <svg
          viewBox="553 120 477 160"
          aria-hidden="true"
          focusable="false"
          className="pointer-events-none h-[18px] w-auto shrink-0 select-none overflow-visible drop-shadow-[0_0_8px_rgba(255,255,255,0.08)]"
        >
          <image href={vastWordmark} width="1584" height="396" />
        </svg>
      )}
    </div>
  )
}
