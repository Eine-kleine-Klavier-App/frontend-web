import { useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { settleMotion } from '@/styles/motion';
import { useEditor } from '@/app/store';
import { CheckIcon, UndoIcon } from '@/ui/icons';

const NOTICE_MS = 10000;

/** After an edit made under a fixed policy: what the policy did, and the two ways back — the other mode
 *  (undo, then the same edit the other way) or a plain undo. Sits in the toast lane; it is dropped at the
 *  next edit, undo or load, and after a while. */
export function PitchModeNotice({ notice }: { notice: NonNullable<ReturnType<typeof useEditor.getState>['pitchNotice']> }) {
  const clear = useEditor((s) => s.clearPitchNotice);
  const undo = useEditor((s) => s.undo);
  const dispatch = useEditor((s) => s.dispatch);
  const reduce = useReducedMotion();
  useEffect(() => {
    const timer = window.setTimeout(clear, NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, clear]);
  const other = notice.mode === 'preserve_pitch' ? 'preserve_step' : 'preserve_pitch';
  return (
    <motion.div className="editor-toast editor-toast--notice" role="status" {...settleMotion(reduce)}>
      <CheckIcon />
      <span>{notice.text}</span>
      <button type="button" className="editor-toast-action" onClick={() => { void undo().then(() => dispatch(notice.command, other)); }}>
        {other === 'preserve_step' ? 'Keep position instead' : 'Keep sound instead'}
      </button>
      <button type="button" className="editor-toast-action" onClick={() => { void undo(); }}>
        <UndoIcon /> Undo
      </button>
    </motion.div>
  );
}
