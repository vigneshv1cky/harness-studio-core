import type { IconProps } from './icons/props.ts'

/**
 * Render Harness Studio's mark: a white target on a blue tile, the same artwork as the
 * app and Chrome extension icons.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with the product name for accessibility).
 */
export function HarnessStudioMark({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="100 100 824 824" aria-hidden="true">
      <rect x="100" y="100" width="824" height="824" rx="185" fill="#2563eb" />
      <g stroke="#fff" strokeWidth="64" strokeLinecap="round" fill="none">
        <circle cx="512" cy="512" r="190" />
        <path d="M512 230v60M512 734v60M230 512h60M734 512h60" />
      </g>
      <circle cx="512" cy="512" r="62" fill="#fff" />
    </svg>
  )
}
