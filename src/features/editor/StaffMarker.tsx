import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { animate, useReducedMotion } from 'motion/react';
import { useEditor } from '@/app/store';
import { springSnappy } from '@/styles/motion';
import { resolveVoiceColor } from '@/core/model/voiceColors';
import type { ScoreLayout } from '@/rendering/ScoreRenderer';

/** Where new notes go, on the sheet itself: a thin bar in the current voice's colour at the left of the
 *  current staff, on every system. Its size and place come from the layout (the staff's own step), so it
 *  scales with the score. It takes no pointer. */
export function StaffMarker({ layout }: { layout: ScoreLayout }) {
  const staffId = useEditor((s) => s.currentStaff);
  const voice = useEditor((s) => s.document.voices[s.currentVoice]);
  const voiceColors = useEditor((s) => s.voiceColors);
  if (!voice) return null;
  const color = resolveVoiceColor(voice.id, voice.index, voiceColors);
  // the first measure of each system on this staff: the zone with the least x among those on one line
  const starts = new Map<number, (typeof layout.staffZones)[number]>();
  for (const zone of layout.staffZones) {
    if (zone.staffId !== staffId) continue;
    const line = Math.round(zone.bottomLineY);
    const known = starts.get(line);
    if (!known || zone.x0 < known.x0) starts.set(line, zone);
  }
  return (
    <>
      {[...starts.values()].map((zone) => {
        const measure = layout.measures.find((m) => m.id === zone.measureId);
        if (!measure) return null;
        // one bar per system, whichever staff it stands at: the same measure starts the system on both
        return (
          <StaffBar
            key={zone.measureId}
            staffId={staffId}
            color={color}
            left={measure.x - zone.stepPx * 4.5}
            top={zone.bottomLineY - zone.stepPx * 8}
            width={zone.stepPx * 0.4}
            height={zone.stepPx * 8}
          />
        );
      })}
    </>
  );
}

/** The bar of one system. When another staff is chosen it travels to that staff on the spring of every selection mark (the choice thumb's), from where it is drawn now, even mid-flight; a new place for the same staff (the score re-flowed, a zoom step) is drawn at once. */
function StaffBar({ staffId, color, left, top, width, height }: { staffId: string; color: string; left: number; top: number; width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef({ left, top, width, height });
  const chosen = useRef(staffId);
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const place = (geometry: typeof shown.current) => {
      shown.current = geometry;
      for (const [name, value] of Object.entries(geometry)) node.style.setProperty(name, `${value}px`);
    };
    const to = { left, top, width, height };
    const from = shown.current;
    const moved = chosen.current !== staffId;
    chosen.current = staffId;
    if (!moved || reduce) {
      place(to);
      return;
    }
    place(from); // React has just written the new place into the node; take it back before the frame is shown
    const flight = animate(0, 1, {
      ...springSnappy,
      onUpdate: (t) => place({
        left: from.left + (to.left - from.left) * t,
        top: from.top + (to.top - from.top) * t,
        width: from.width + (to.width - from.width) * t,
        height: from.height + (to.height - from.height) * t,
      }),
      onComplete: () => place(to),
    });
    return () => flight.stop();
  }, [staffId, left, top, width, height, reduce]);
  return <div ref={ref} className="staff-marker" aria-hidden="true" style={{ left, top, width, height, '--vc': color } as CSSProperties} />;
}
