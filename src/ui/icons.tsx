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

export function FolderOpenIcon() {
  return glyph(
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" {...STROKE} />,
  );
}

export function FolderPlusIcon() {
  return glyph(
    <>
      <path d="M12 10v6" {...STROKE} />
      <path d="M9 13h6" {...STROKE} />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" {...STROKE} />
    </>,
  );
}

export function TrashIcon() {
  return glyph(
    <>
      <path d="M3 6h18" {...STROKE} />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" {...STROKE} />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" {...STROKE} />
      <path d="M10 11v6" {...STROKE} />
      <path d="M14 11v6" {...STROKE} />
    </>,
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

export function SlidersIcon() {
  return glyph(
    <>
      <path d="M21 4h-7" {...STROKE} />
      <path d="M10 4H3" {...STROKE} />
      <path d="M21 12h-9" {...STROKE} />
      <path d="M8 12H3" {...STROKE} />
      <path d="M21 20h-5" {...STROKE} />
      <path d="M12 20H3" {...STROKE} />
      <path d="M14 2v4" {...STROKE} />
      <path d="M8 10v4" {...STROKE} />
      <path d="M16 18v4" {...STROKE} />
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

// lucide 1.8.0: skip-back, skip-forward, rewind, fast-forward, repeat — the playback island
export function SkipBackIcon() {
  return glyph(
    <>
      <path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" {...STROKE} />
      <path d="M3 20V4" {...STROKE} />
    </>,
  );
}

export function SkipForwardIcon() {
  return glyph(
    <>
      <path d="M21 4v16" {...STROKE} />
      <path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" {...STROKE} />
    </>,
  );
}

export function RewindIcon() {
  return glyph(
    <>
      <path d="M12 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 12 18z" {...STROKE} />
      <path d="M22 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 22 18z" {...STROKE} />
    </>,
  );
}

export function FastForwardIcon() {
  return glyph(
    <>
      <path d="M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z" {...STROKE} />
      <path d="M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z" {...STROKE} />
    </>,
  );
}

export function RepeatIcon() {
  return glyph(
    <>
      <path d="m17 2 4 4-4 4" {...STROKE} />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" {...STROKE} />
      <path d="m7 22-4-4 4-4" {...STROKE} />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" {...STROKE} />
    </>,
  );
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

// lucide-static 1.61.0: undo-2, redo-2, lock / lock-open, circle-help, circle-alert, mouse-pointer-2
export function UndoIcon() {
  return glyph(
    <>
      <path d="M9 14 4 9l5-5" {...STROKE} />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" {...STROKE} />
    </>,
  );
}
export function RedoIcon() {
  return glyph(
    <>
      <path d="m15 14 5-5-5-5" {...STROKE} />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" {...STROKE} />
    </>,
  );
}
export function LockIcon({ locked }: { locked: boolean }) {
  return glyph(
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" {...STROKE} />
      <path d={locked ? 'M7 11V7a5 5 0 0 1 10 0v4' : 'M7 11V7a5 5 0 0 1 9.9-1'} {...STROKE} />
    </>,
  );
}
// lucide-static 0.468.0: file-up, file-diff
export function FileUpIcon() {
  return glyph(
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" {...STROKE} />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" {...STROKE} />
      <path d="M12 12v6" {...STROKE} />
      <path d="m15 15-3-3-3 3" {...STROKE} />
    </>,
  );
}
export function HelpIcon() {
  return glyph(
    <>
      <circle cx="12" cy="12" r="10" {...STROKE} />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" {...STROKE} />
      <path d="M12 17h.01" {...STROKE} />
    </>,
  );
}
export function AlertIcon() {
  return glyph(
    <>
      <circle cx="12" cy="12" r="10" {...STROKE} />
      <line x1="12" x2="12" y1="8" y2="12" {...STROKE} />
      <line x1="12" x2="12.01" y1="16" y2="16" {...STROKE} />
    </>,
  );
}
export function MousePointerIcon() {
  return glyph(
    <path
      d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"
      {...STROKE}
    />,
  );
}
// lucide-static 1.61.0: sun, moon — the day/night switch
export function SunIcon() {
  return glyph(
    <>
      <circle cx="12" cy="12" r="4" {...STROKE} />
      <path d="M12 2v2" {...STROKE} />
      <path d="M12 20v2" {...STROKE} />
      <path d="m4.93 4.93 1.41 1.41" {...STROKE} />
      <path d="m17.66 17.66 1.41 1.41" {...STROKE} />
      <path d="M2 12h2" {...STROKE} />
      <path d="M20 12h2" {...STROKE} />
      <path d="m6.34 17.66-1.41 1.41" {...STROKE} />
      <path d="m19.07 4.93-1.41 1.41" {...STROKE} />
    </>,
  );
}
export function MoonIcon() {
  return glyph(
    <path
      d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      {...STROKE}
    />,
  );
}
// Lucide `piano`, `unplug`, `file-text`, `rotate-ccw`
export function PianoIcon() {
  return glyph(
    <>
      <path d="M10 13v4" {...STROKE} />
      <path d="M14 13v4" {...STROKE} />
      <path d="M18 13v4" {...STROKE} />
      <path d="M2 13h20" {...STROKE} />
      <path d="M22 11.5A3.5 3.5 0 0 0 18.5 8a3.52 3.52 0 0 1-3.173-2A7 7 0 0 0 2 9v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2z" {...STROKE} />
      <path d="M6 13v4" {...STROKE} />
    </>,
  );
}

export function UnplugIcon() {
  return glyph(
    <>
      <path d="m19 5 3-3" {...STROKE} />
      <path d="m2 22 3-3" {...STROKE} />
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" {...STROKE} />
      <path d="M7.5 13.5 10 11" {...STROKE} />
      <path d="M10.5 16.5 13 14" {...STROKE} />
      <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" {...STROKE} />
    </>,
  );
}

/** Lucide `chart-no-axes-gantt` turned a quarter turn: bars of different lengths in columns, as notes fall in the waterfall. */
export function WaterfallIcon() {
  return glyph(
    <>
      <path d="M19 6v12" {...STROKE} />
      <path d="M12 4v10" {...STROKE} />
      <path d="M5 12v8" {...STROKE} />
    </>,
  );
}

export function FileTextIcon() {
  return glyph(
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" {...STROKE} />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" {...STROKE} />
      <path d="M10 9H8" {...STROKE} />
      <path d="M16 13H8" {...STROKE} />
      <path d="M16 17H8" {...STROKE} />
    </>,
  );
}

export function WandSparklesIcon() {
  return glyph(
    <>
      <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" {...STROKE} />
      <path d="m14 7 3 3" {...STROKE} />
      <path d="M5 6v4" {...STROKE} />
      <path d="M19 14v4" {...STROKE} />
      <path d="M10 2v2" {...STROKE} />
      <path d="M7 8H3" {...STROKE} />
      <path d="M21 16h-4" {...STROKE} />
      <path d="M11 3H9" {...STROKE} />
    </>,
  );
}

export function PlugZapIcon() {
  return glyph(
    <>
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" {...STROKE} />
      <path d="m2 22 3-3" {...STROKE} />
      <path d="M7.5 13.5 10 11" {...STROKE} />
      <path d="M10.5 16.5 13 14" {...STROKE} />
      <path d="m18 3-4 4h6l-4 4" {...STROKE} />
    </>,
  );
}

export function GalleryHorizontalIcon() {
  return glyph(
    <>
      <path d="M2 3v18" {...STROKE} />
      <rect width="12" height="18" x="6" y="3" rx="2" {...STROKE} />
      <path d="M22 3v18" {...STROKE} />
    </>,
  );
}

export function PaletteIcon() {
  return glyph(
    <>
      <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" {...STROKE} />
      <circle cx="13.5" cy="6.5" r=".5" {...STROKE} fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" {...STROKE} fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" {...STROKE} fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" {...STROKE} fill="currentColor" />
    </>,
  );
}

export function RotateCcwIcon() {
  return glyph(
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" {...STROKE} />
      <path d="M3 3v5h5" {...STROKE} />
    </>,
  );
}

// Lucide `pin` (lucide-static 1.61.0)
export function PinIcon() {
  return glyph(
    <>
      <path d="M12 17v5" {...STROKE} />
      <path
        d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
        {...STROKE}
      />
    </>,
  );
}
