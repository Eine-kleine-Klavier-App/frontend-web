// TEMPORARY design-audit stand (not committed): the REAL EditorScreen on demo-view.json, no sign-in, no backend.
// ?view=demo-view|demo-graces  ?drop=<context kinds to remove>  ?policy=ask|preserve_pitch|preserve_step  ?t=<ms> playback clock  ?theme=dark|light
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import './styles/tokens.css';
import './index.css';
import { useEditor } from '@/app/store';
import { fromView } from '@/core/model/fromView';
import { playback } from '@/core/playback/PlaybackController';
import { navigation, timeAtBeat, beatAtTime } from '@/core/navigation/ScoreNavigation';
import type { PlaybackMap, PlaybackNote, PlaybackSegment } from '@/core/playback/PlaybackGateway';
import EditorScreen from '@/features/editor/EditorScreen';

const params = new URLSearchParams(location.search);
const view = await (await fetch('/' + (params.get('view') ?? 'demo-editor-view') + '.json')).json();
const drop = (params.get('drop') ?? '').split(',').filter(Boolean);
view.contexts = view.contexts.filter((c: { kind: string }) => !drop.includes(c.kind));
const document = fromView(view, 'demo');
const policy = (params.get('policy') ?? 'ask') as 'ask' | 'preserve_pitch' | 'preserve_step';
useEditor.setState({
  document, loading: false, scoreId: 'demo', locked: false, pitchPolicy: policy,
  currentStaff: document.staffOrder[0] ?? '',
  gateway: {
    load: async (_draftId: string) => document,
    apply: async () => useEditor.getState().document,
  },
} as never);
(window as never as { __editor: unknown }).__editor = useEditor;

// ?clock=1 runs the playback clock (Play, Pause, Stop and the slider work on the stand); without it the clock stands still at ?t
// synthetic playback map: 120 bpm, every real note of the document sounds at its item position
const MS_PER_BEAT = 500;
const DURATION_BEATS: Record<string, number> = { w: 4, h: 2, q: 1, '8': 0.5, '16': 0.25, '32': 0.125 };
interface BaseNote { pitch: number; sourceId: string; start: number; end: number }
const base: BaseNote[] = [];
let totalBeats = 0;
document.measures.forEach((measure, mi) => {
  const beats = measure.timeSignature.beats * 4 / measure.timeSignature.beatValue;
  const start = totalBeats;
  measure.voices.forEach((voice, vi) => {
    voice.items.forEach((item) => {
      if (item.kind !== 'note') return;
      const len = (DURATION_BEATS[item.duration] ?? 1) * (item.dots ? 1.5 : 1);
      item.notes.forEach((note, ni) => {
        const pitch = note.midiNote ?? ((vi === 0 ? 62 : 40) + ((note.staffStep * 2 + ni * 4 + mi) % 14 + 14) % 14);
        base.push({ pitch, sourceId: note.noteId, start: start + item.position, end: start + item.position + len * 0.95 });
      });
    });
  });
  totalBeats += beats;
});
// a third, wide voice not tied to a document note (no voice): long low pedal tones
for (let m = 0; m < document.measures.length; m++) base.push({ pitch: m % 2 ? 31 : 36, sourceId: '', start: m * 4, end: m * 4 + 3.8 });
// and a high sparkle line
for (let i = 0; i < totalBeats * 2; i += 3) base.push({ pitch: 84 + (i % 5) * 2, sourceId: '', start: i / 2, end: i / 2 + 0.5 });
// the route: ?repeat=1 plays the first two measures twice
const route: [number, number][] = params.get('repeat') ? [[0, 8], [0, totalBeats]] : [[0, totalBeats]];
const notes: PlaybackNote[] = [];
const segments: PlaybackSegment[] = [];
let offsetBeats = 0;
for (const [from, to] of route) {
  for (const note of base) if (note.start >= from && note.start < to) notes.push({ pitch: note.pitch, sourceId: note.sourceId, startMs: (offsetBeats + note.start - from) * MS_PER_BEAT, endMs: (offsetBeats + Math.min(note.end, to) - from) * MS_PER_BEAT, keyReleaseMs: (offsetBeats + Math.min(note.end, to) - from) * MS_PER_BEAT, velocity: 60 });
  const startMs = offsetBeats * MS_PER_BEAT, endMs = (offsetBeats + to - from) * MS_PER_BEAT;
  segments.push({ startBeats: from, endBeats: to, startMs, endMs, moments: [{ beats: from, timeMs: startMs }, { beats: to, timeMs: endMs }] });
  offsetBeats += to - from;
}
notes.sort((a, z) => a.startMs - z.startMs);
const playedBeats = offsetBeats;
const map: PlaybackMap = { pedals: [], notes, anchors: [], segments, extentMs: playedBeats * MS_PER_BEAT, version: 1 };
const controller = playback as never as { prepareMap: () => Promise<void>; set: (patch: object) => void };
playback.bindDraft('demo');
const t = Number(params.get('t') ?? 6 * MS_PER_BEAT * 4 + 120); // bar 7-ish, shortly after an onset
const playing = params.get('playing') !== '0';
const apply = (ms: number, on = playing) => {
  navigation.update({ map, timeMs: ms, timeBeats: beatAtTime(map, ms), totalBeats });
  controller.set({ ready: true, mapLoading: false, playing: on });
};
controller.prepareMap = async () => {
  if (!navigation.getState().map) apply(t);
};
apply(t);
if (params.get('clock') === '1') {
  const standIn = playback as never as Record<'play' | 'pause' | 'stop' | 'seek', (...args: never[]) => unknown>;
  let running = playing;
  let ms = t;
  let last = performance.now();
  standIn.play = async () => { running = true; controller.set({ playing: true, paused: false }); };
  standIn.pause = () => { running = false; controller.set({ playing: false, paused: true }); };
  standIn.stop = () => { running = false; ms = 0; navigation.update({ timeMs: 0, timeBeats: 0 }); controller.set({ playing: false, paused: false }); };
  standIn.seek = ((beats: number) => { ms = timeAtBeat(map, beats); navigation.update({ timeMs: ms, timeBeats: beats }); }) as never;
  const tick = (now: number) => {
    requestAnimationFrame(tick);
    const step = now - last;
    last = now;
    if (!running) return;
    ms = ms >= map.extentMs ? 0 : Math.min(map.extentMs, ms + step);
    navigation.update({ timeMs: ms, timeBeats: beatAtTime(map, ms) });
  };
  requestAnimationFrame(tick);
}
(window as never as { __setTime: (ms: number, on?: boolean) => void }).__setTime = apply;
(window as never as { __notes: PlaybackNote[] }).__notes = notes;
(window as never as { __checks: unknown }).__checks = { map, timeAtBeat: (b: number) => timeAtBeat(map, b), beatAtTime: (ms: number) => beatAtTime(map, ms) };

createRoot(window.document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/edit/demo']}>
    <Routes>
      <Route path="/edit/:draftId" element={<EditorScreen />} />
      <Route path="*" element={<div>elsewhere</div>} />
    </Routes>
  </MemoryRouter>,
);
