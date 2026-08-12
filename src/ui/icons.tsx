import type { ReactNode } from 'react';

// Application chrome uses one embedded 24×24 icon family. The paths are Lucide geometry
// (ISC-licensed), kept local so the visual system has no runtime/package dependency. Music
// notation remains owned by VexFlow; BrandMark is the app's custom mark below.
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function glyph(children: ReactNode, className?: string) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export function BrandMark({ className }: { className?: string } = {}) {
  return glyph(
    <>
      <circle cx="7" cy="17" r="3" fill="currentColor" />
      <circle cx="16" cy="15" r="3" fill="currentColor" />
      <path d="M10 17V6l9-2v11" {...STROKE} />
      <path d="M10 8.5 19 6.5" {...STROKE} />
    </>,
    className,
  );
}

export function CompassIcon() {
  return glyph(
    <>
      <circle cx="12" cy="12" r="10" {...STROKE} />
      <path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" {...STROKE} />
    </>,
  );
}

export function LibraryIcon() {
  return glyph(
    <>
      <rect width="8" height="18" x="3" y="3" rx="1" {...STROKE} />
      <path d="M7 3v18" {...STROKE} />
      <path d="M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z" {...STROKE} />
    </>,
  );
}

export function FolderIcon() {
  return glyph(
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" {...STROKE} />,
  );
}

export function UserIcon() {
  return glyph(
    <>
      <circle cx="12" cy="8" r="5" {...STROKE} />
      <path d="M20 21a8 8 0 0 0-16 0" {...STROKE} />
    </>,
  );
}

export function SignOutIcon() {
  return glyph(
    <>
      <path d="m16 17 5-5-5-5" {...STROKE} />
      <path d="M21 12H9" {...STROKE} />
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" {...STROKE} />
    </>,
  );
}

export function EditIcon() {
  return glyph(
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" {...STROKE} />
      <path d="m15 5 4 4" {...STROKE} />
    </>,
  );
}

export function PracticeIcon() {
  return glyph(
    <>
      <path d="M12 11.4V9.1" {...STROKE} />
      <path d="m12 17 6.59-6.59" {...STROKE} />
      <path d="m15.05 5.7-.218-.691a3 3 0 0 0-5.663 0L4.418 19.695A1 1 0 0 0 5.37 21h13.253a1 1 0 0 0 .951-1.31L18.45 16.2" {...STROKE} />
      <circle cx="20" cy="9" r="2" {...STROKE} />
    </>,
  );
}

export function CollapsePanelIcon() {
  return glyph(
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" {...STROKE} />
      <path d="M15 3v18" {...STROKE} />
      <path d="m8 9 3 3-3 3" {...STROKE} />
    </>,
  );
}

export function CloseIcon({ className }: { className?: string } = {}) {
  return glyph(
    <>
      <path d="M18 6 6 18" {...STROKE} />
      <path d="m6 6 12 12" {...STROKE} />
    </>,
    className,
  );
}

export function SearchIcon() {
  return glyph(
    <>
      <path d="m21 21-4.34-4.34" {...STROKE} />
      <circle cx="11" cy="11" r="8" {...STROKE} />
    </>,
  );
}

export function ChevronRightIcon({ className }: { className?: string } = {}) {
  return glyph(<path d="m9 18 6-6-6-6" {...STROKE} />, className);
}

export function ChevronLeftIcon() {
  return glyph(<path d="m15 18-6-6 6-6" {...STROKE} />);
}

export function ChevronDownIcon() {
  return glyph(<path d="m6 9 6 6 6-6" {...STROKE} />);
}

export function CheckIcon() {
  return glyph(<path d="M20 6 9 17l-5-5" {...STROKE} />);
}

export function PlusIcon() {
  return glyph(
    <>
      <path d="M5 12h14" {...STROKE} />
      <path d="M12 5v14" {...STROKE} />
    </>,
  );
}

export function ArrowLeftIcon() {
  return glyph(
    <>
      <path d="m12 19-7-7 7-7" {...STROKE} />
      <path d="M19 12H5" {...STROKE} />
    </>,
  );
}

export function ArrowRightIcon() {
  return glyph(
    <>
      <path d="M5 12h14" {...STROKE} />
      <path d="m12 5 7 7-7 7" {...STROKE} />
    </>,
  );
}

export function PlayIcon() {
  return glyph(<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" {...STROKE} />);
}

export function PauseIcon() {
  return glyph(
    <>
      <rect x="14" y="3" width="5" height="18" rx="1" {...STROKE} />
      <rect x="5" y="3" width="5" height="18" rx="1" {...STROKE} />
    </>,
  );
}

export function StopIcon() {
  return glyph(<rect width="18" height="18" x="3" y="3" rx="2" {...STROKE} />);
}

export function ReplayIcon() {
  return glyph(
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" {...STROKE} />
      <path d="M3 3v5h5" {...STROKE} />
    </>,
  );
}

export function StarIcon() {
  return glyph(
    <path
      d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />,
  );
}

export function TrendingUpIcon() {
  return glyph(
    <>
      <path d="M16 7h6v6" {...STROKE} />
      <path d="m22 7-8.5 8.5-5-5L2 17" {...STROKE} />
    </>,
  );
}

export function TrendingDownIcon() {
  return glyph(
    <>
      <path d="M16 17h6v-6" {...STROKE} />
      <path d="m22 17-8.5-8.5-5 5L2 7" {...STROKE} />
    </>,
  );
}

export function MinusIcon() {
  return glyph(<path d="M5 12h14" {...STROKE} />);
}
