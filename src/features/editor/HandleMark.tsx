/** What dragging a handle does: it changes the span of a mark (where it begins and ends), moves the whole
 *  mark, or only stretches its shape. The editor draws each role with its own mark, everywhere. */
export type HandleRole = 'span' | 'move' | 'shape';

/** `size` is the radius of the round mark; the square and the diamond are the same area. */
export function HandleMark({ role, x, y, size, ...paint }: {
  role: HandleRole; x: number; y: number; size: number;
  className?: string; fill?: string; stroke?: string; strokeWidth?: number; pointerEvents?: 'none' | 'all';
}) {
  const half: number = size * 0.886;
  if (role === 'shape') return <circle cx={x} cy={y} r={size} {...paint} />;
  if (role === 'span') return <rect x={x - half} y={y - half} width={half * 2} height={half * 2} {...paint} />;
  return <rect x={x - half} y={y - half} width={half * 2} height={half * 2} transform={`rotate(45 ${x} ${y})`} {...paint} />;
}
