import type { IconDefinition } from '@fortawesome/free-solid-svg-icons';

export function Icon({ icon, standalone = false }: {
  icon: IconDefinition; standalone?: boolean;
}) {
  return <svg className={`icon${standalone ? ' icon-standalone' : ''}`}
    viewBox={`0 0 ${icon.icon[0]} ${icon.icon[1]}`} aria-hidden="true" focusable="false">
    <path fill="currentColor" d={Array.isArray(icon.icon[4]) ? icon.icon[4].join(' ') : icon.icon[4]} />
  </svg>;
}
