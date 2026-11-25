// TEMPORARY QA stand (not to be committed): the REAL PracticeScreen on demo-view.json, no sign-in, no backend, with a fake MIDI keyboard.
// window.__midi.plug('FP-10') / .unplug() / .press(60) / .release(60) drive the keyboard.
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import './styles/tokens.css';
import './index.css';
import { useEditor } from '@/app/store';
import { fromView } from '@/core/model/fromView';
import { navigation } from '@/core/navigation/ScoreNavigation';
import { playback } from '@/core/playback/PlaybackController';
import type { PlaybackMap, PlaybackNote, PlaybackAnchor } from '@/core/playback/PlaybackGateway';
import PracticeScreen from '@/features/practice/PracticeScreen';
import { practice } from '@/core/practice/PracticeSession';

const params = new URLSearchParams(location.search);
const view = await (await fetch('/' + (params.get('view') ?? 'demo-editor-view') + '.json')).json();
const document = fromView(view, 'demo');
useEditor.setState({
  document, loading: false, scoreId: 'demo', locked: false, source: { kind: 'saved', id: 'demo' },
  savedScore: { id: 'demo', title: 'Etude in practice', composer: null, isPublic: true, updatedAt: '2026-11-22T00:00:00Z', authorId: null, authorName: null },
  currentStaff: document.staffOrder[0] ?? '',
  loadSource: async () => {}, clearSource: () => {},
} as never);

// a plain playback map: 120 bpm, every note of the document at its item position; with ?repeat=1 the first two bars are played twice
// and with ?volta=1 the third bar is skipped on the second pass (the route is a list of [from, to) beats)
const MS_PER_BEAT = 500;
const DURATION_BEATS: Record<string, number> = { w: 4, h: 2, q: 1, '8': 0.5, '16': 0.25, '32': 0.125 };
interface Leaf { carrierId: string; beat: number; length: number; pitches: { sourceId: string; pitch: number }[] }
const leaves: Leaf[] = [];
let totalBeats = 0;
document.measures.forEach((measure, mi) => {
  const beats = measure.timeSignature.beats * 4 / measure.timeSignature.beatValue;
  measure.voices.forEach((voice, vi) => {
    voice.items.forEach((item) => {
      if (item.kind !== 'note') return;
      const length = (DURATION_BEATS[item.duration] ?? 1) * (item.dots ? 1.5 : 1);
      leaves.push({
        carrierId: item.id, beat: totalBeats + item.position, length,
        pitches: item.notes.map((note, ni) => ({ sourceId: note.noteId, pitch: note.midiNote ?? ((vi === 0 ? 62 : 40) + ((note.staffStep * 2 + ni * 4 + mi) % 14 + 14) % 14) })),
      });
    });
  });
  totalBeats += beats;
});
const params2 = new URLSearchParams(location.search);
const route: [number, number][] = params2.get('volta') ? [[0, 8], [0, 4], [8, totalBeats]] : params2.get('repeat') ? [[0, 8], [0, 8], [8, totalBeats]] : [[0, totalBeats]];
const notes: PlaybackNote[] = [];
const anchors: PlaybackAnchor[] = [];
const segments: PlaybackMap['segments'] = [];
let passMs = 0;
for (const [from, to] of route) {
  for (const leaf of leaves) {
    if (leaf.beat < from || leaf.beat >= to) continue;
    const startMs = passMs + (leaf.beat - from) * MS_PER_BEAT;
    const endMs = startMs + leaf.length * MS_PER_BEAT * 0.95;
    anchors.push({ carrierId: leaf.carrierId, startMs, endMs });
    for (const { sourceId, pitch } of leaf.pitches) notes.push({ pitch, sourceId, startMs, keyReleaseMs: endMs, endMs, velocity: 70 });
  }
  const endMs = passMs + (to - from) * MS_PER_BEAT;
  segments.push({ startBeats: from, endBeats: to, startMs: passMs, endMs, moments: [{ beats: from, timeMs: passMs }, { beats: to, timeMs: endMs }] });
  passMs = endMs;
}
notes.sort((a, b) => a.startMs - b.startMs);
const extentMs = passMs;
const map: PlaybackMap = { pedals: [], notes, anchors, extentMs, version: 1, segments };
navigation.update({ map });
// binding the score clears the plan, as it does for a real score; the stand hands it back when it is asked for
(playback as never as { prepareMap: () => Promise<void> }).prepareMap = async () => { if (!navigation.getState().map) navigation.update({ map }); };
(window as never as { __nav: unknown }).__nav = navigation;
(window as never as { __practice: unknown }).__practice = practice;
(window as never as { __editor: unknown }).__editor = useEditor;
(window as never as { __points: unknown }).__points = notes.map((n) => [n.startMs, n.pitch]);

// a fake keyboard behind Web MIDI
const ports: Array<{ id: string; name: string; state: string; onmidimessage: null | ((e: { data: number[]; timeStamp: number }) => void) }> = [];
const access = { onstatechange: null as null | ((e: unknown) => void), inputs: { values: () => ports[Symbol.iterator]() } };
(navigator as never as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess = async () => access;
(window as never as { __midi: unknown }).__midi = {
  plug(name = 'FP-10') { ports.length = 0; ports.push({ id: 'fp10', name, state: 'connected', onmidimessage: null }); access.onstatechange?.({}); },
  unplug() { if (ports[0]) { ports[0].state = 'disconnected'; access.onstatechange?.({}); } },
  replug() { if (ports[0]) { ports[0].state = 'connected'; access.onstatechange?.({}); } },
  press(pitch: number) { ports[0]?.onmidimessage?.({ data: [0x90, pitch, 90], timeStamp: performance.now() }); },
  release(pitch: number) { ports[0]?.onmidimessage?.({ data: [0x80, pitch, 0], timeStamp: performance.now() }); },
};

createRoot(window.document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/scores/demo/practice']}>
    <Routes>
      <Route path="/scores/:scoreId/practice" element={<PracticeScreen />} />
      <Route path="*" element={<div>elsewhere</div>} />
    </Routes>
  </MemoryRouter>,
);
