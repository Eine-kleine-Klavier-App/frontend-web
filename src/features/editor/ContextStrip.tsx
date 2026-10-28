import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { glassSettleMotion, lift, springSettle } from '@/styles/motion';
import { useEditor } from '@/app/store';
import { CheckIcon, ChevronDownIcon, MinusIcon, PlusIcon } from '@/ui/icons';
import { ChoiceGroup, ChoiceThumb } from '@/ui/ChoiceGroup';
import { useDismiss } from '@/ui/useDismiss';
import { DEFAULT_VOICE_COLORS, resolveVoiceColor } from '@/core/model/voiceColors';
import { voiceCarrierIds, orderedVoiceCarrierIds } from '@/core/model/query';
import { PitchModePrompt } from './PitchModePrompt';

function staffLabel(staffOrder: string[], id: string): string {
  const i = staffOrder.indexOf(id);
  if (i === 0) return 'Upper';
  if (i === 1) return 'Lower';
  return `Staff ${i + 1}`;
}

const POLICIES = [
  { value: 'ask', label: 'Ask first', hint: 'Choose each time an edit changes how notes read.' },
  { value: 'preserve_pitch', label: 'Keep sound', hint: 'Same pitches, redrawn on the new staff.' },
  { value: 'preserve_step', label: 'Keep position', hint: 'Same place on the staff, the pitches change.' },
] as const;

/** One glass popover under its anchor: the same surface and arrival as every popover in the app. */
function GlassMenu({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const { surface, layer } = glassSettleMotion(reduce, -6);
  return (
    <motion.div className={`strip-menu glass ${className}`} role="dialog" aria-label={label} {...surface}>
      <motion.span className="strip-menu-arrow" aria-hidden="true" {...layer} />
      <motion.div className="glass-lens" {...layer} />
      <motion.div className="glass-tint" {...layer} />
      <motion.div className="glass-specular" {...layer} />
      <motion.div className="glass-rim" {...layer} />
      <motion.div className="glass-content" {...layer}>{children}</motion.div>
    </motion.div>
  );
}

// The strip above the sheet: where new notes are written (staff, voice) and how an edit that changes
// how notes read is treated (the policy chip). The prompt that asks for that choice opens from the
// chip, so the answer is given where the policy lives; nothing covers the score.
// Alt+Left/Right pick the voice and Alt+Up/Down the staff (Alt+digit pins to a hotbar slot).
export function ContextStrip({ readOnly = false }: { readOnly?: boolean }) {
  const doc = useEditor((s) => s.document);
  const currentStaff = useEditor((s) => s.currentStaff);
  const currentVoice = useEditor((s) => s.currentVoice);
  const setCurrentStaff = useEditor((s) => s.setCurrentStaff);
  const setCurrentVoice = useEditor((s) => s.setCurrentVoice);
  const voiceColors = useEditor((s) => s.voiceColors);
  const setVoiceColor = useEditor((s) => s.setVoiceColor);
  const selectMany = useEditor((s) => s.selectMany);
  const policy = useEditor((s) => s.pitchPolicy);
  const zoom = useEditor((s) => s.zoom);
  const setZoom = useEditor((s) => s.setZoom);
  const setPolicy = useEditor((s) => s.setPitchPolicy);
  const policyMenuOpen = useEditor((s) => s.policyMenuOpen);
  const setPolicyMenuOpen = useEditor((s) => s.setPolicyMenuOpen);
  const asking = useEditor((s) => s.pitchModeRequest !== null);
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);
  const voiceRef = useRef<HTMLDivElement>(null);
  const voiceRowRef = useRef<HTMLDivElement>(null);
  const swatchGroupId = useId();
  const policyRef = useRef<HTMLDivElement>(null);
  const policyMenuId = useId();

  useDismiss(voiceMenuOpen, [voiceRef, voiceRowRef], () => setVoiceMenuOpen(false));
  useDismiss(policyMenuOpen, [policyRef], () => setPolicyMenuOpen(false));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const s = useEditor.getState();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const voice = s.document.voices[s.currentVoice + (e.key === 'ArrowLeft' ? -1 : 1)];
        if (!voice) return;
        e.preventDefault();
        s.setCurrentVoice(voice.index);
      } else if (!readOnly && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const order = s.document.staffOrder;
        const next = order[order.indexOf(s.currentStaff) + (e.key === 'ArrowUp' ? -1 : 1)];
        if (!next) return;
        e.preventDefault();
        s.setCurrentStaff(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly]);

  const voice = doc.voices[currentVoice];
  const voiceColor = voice ? resolveVoiceColor(voice.id, voice.index, voiceColors) : '';
  const policyLabel = POLICIES.find((p) => p.value === policy)?.label ?? '';

  return (
    <div className="context-strip">
      <div className="context-strip-in">
        {!readOnly && <div className="strip-field">
          <span className="strip-eyebrow">Staff</span>
          <ChoiceGroup
            value={currentStaff}
            onChange={setCurrentStaff}
            options={doc.staffOrder.map((id) => ({ value: id, label: staffLabel(doc.staffOrder, id), title: `${staffLabel(doc.staffOrder, id)} staff` }))}
            ariaLabel="Staff"
          />
        </div>}

        <div className="strip-field" ref={voiceRef}>
          <span className="strip-eyebrow">Voice</span>
          <ChoiceGroup
            value={String(currentVoice)}
            onChange={(v) => setCurrentVoice(Number(v))}
            options={doc.voices.map((v) => ({
              value: String(v.index),
              label: String(v.index + 1),
              ariaLabel: `Voice ${v.index + 1}`,
              title: `Voice ${v.index + 1}`,
              className: 'strip-voice',
              style: { '--vc': resolveVoiceColor(v.id, v.index, voiceColors) } as CSSProperties,
            }))}
            ariaLabel="Voice"
          />
          <button
            type="button"
            className={'icon-btn ghost strip-more' + (voiceMenuOpen ? ' active' : '')}
            title="Voice colour and select all"
            aria-label="Voice options"
            aria-haspopup="dialog"
            aria-expanded={voiceMenuOpen}
            disabled={!voice}
            onClick={() => { setPolicyMenuOpen(false); setVoiceMenuOpen((v) => !v); }}
          >
            <ChevronDownIcon />
          </button>
        </div>

        {!readOnly && <div className="strip-field strip-policy" ref={policyRef}>
          <button
            type="button"
            className="strip-chip"
            title="How an edit that changes how notes read treats them: a clef, an octave line, a note moved to another staff"
            aria-haspopup="menu"
            aria-expanded={policyMenuOpen || asking}
            aria-controls={policyMenuId}
            onClick={() => { if (asking) return; setVoiceMenuOpen(false); setPolicyMenuOpen(!policyMenuOpen); }}
          >
            <span className="strip-chip-label">Staff changes</span> <b>{policyLabel}</b>
            <ChevronDownIcon />
          </button>
          <AnimatePresence>
            {policyMenuOpen && !asking && (
              <GlassMenu className="strip-menu--policy" label="When notes change">
                <div id={policyMenuId} role="menu">
                  {POLICIES.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={p.value === policy}
                      className={'strip-row strip-row--option' + (p.value === policy ? ' selected' : '')}
                      onClick={() => { setPolicy(p.value); setPolicyMenuOpen(false); }}
                    >
                      <span><b>{p.label}</b><small>{p.hint}</small></span>
                      <CheckIcon />
                    </button>
                  ))}
                </div>
              </GlassMenu>
            )}
            {asking && (
              <GlassMenu className="strip-menu--prompt" label="How should the notes change?">
                <PitchModePrompt />
              </GlassMenu>
            )}
          </AnimatePresence>
        </div>}

        <div className="zoom" role="group" aria-label="Zoom">
          <button type="button" className="icon-btn ghost" aria-label="Zoom out" onClick={() => setZoom(zoom - 0.1)}>
            <MinusIcon />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" className="icon-btn ghost" aria-label="Zoom in" onClick={() => setZoom(zoom + 0.1)}>
            <PlusIcon />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {voiceMenuOpen && voice && (
          <motion.div
            ref={voiceRowRef}
            className="strip-voice-row"
            role="group"
            aria-label={`Voice ${voice.index + 1} options`}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: springSettle }}
            exit={{ opacity: 0, y: -4, transition: lift }}
          >
            <span className="strip-voice-tile" style={{ '--vc': voiceColor } as CSSProperties} aria-hidden="true" />
            <b>Voice {voice.index + 1}</b>
            <button
              type="button"
              className="editor-action"
              onClick={() => {
                // carrier granularity, not note granularity: every carrier of the voice is selected as a whole,
                // like a double-click or the arrow keys do ([[note-vs-carrier-selection-granularity]])
                selectMany(voiceCarrierIds(doc, voice.id), false, orderedVoiceCarrierIds(doc, voice.id));
                setVoiceMenuOpen(false);
              }}
            >
              Select all notes
            </button>
            <span className="strip-menu-label">Colour</span>
            <div className="voice-swatch-row keycap-grid">
              {DEFAULT_VOICE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="voice-swatch"
                  style={{ '--vc': c } as CSSProperties}
                  title={c}
                  aria-label={`Voice colour ${c}`}
                  aria-pressed={c === voiceColor}
                  onClick={() => setVoiceColor(voice.id, c)}
                >
                  {c === voiceColor && <ChoiceThumb groupId={swatchGroupId} />}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}