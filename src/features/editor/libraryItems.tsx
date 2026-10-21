import type { ReactNode } from 'react';
import { useEditor } from '@/app/store';
import { GRACE_VALUES, NOTE_VALUES, toolLabel, type InsertSpec } from '@/core/model/insertItems';
import type { Accidental, ArticulationMark, DurationValue } from '@/core/model/score';
import { ARTICULATION_LABEL } from '@/core/model/articulation';
import { KEY_NAMES } from '@/core/model/contexts';
import { markLabel, markToolId, parseMark } from '@/core/model/markTools';
import { DynamicIcon, HairpinIcon, NotationIcon, SmuflIcon, ToolIcon } from './icons';
import { INSERT_DRAG_TYPE } from './Toolbar';

// What the editor can insert, as the hot panel lists it. Every glyph is VexFlow's (insert items
// through `ToolIcon`, symbols through the SMuFL `getGlyphMarkup` helper). Only what can actually be
// inserted is listed — nothing disabled, nothing "coming".
//
// Two item states, each with its own behaviour:
//   insert — a click arms it as the insert tool; it can be pinned to a hotbar slot
//   build  — opens the Build tab with it preset (a dot, an accidental, an articulation, n:m…); these
//            live on the Build tab and in the search, not on a shelf

export function beginToolDrag(event: React.DragEvent<HTMLElement>, id: string) {
  event.dataTransfer.setData(INSERT_DRAG_TYPE, id);
  event.dataTransfer.effectAllowed = 'copy';
  if (!parseMark(id)) return;
  useEditor.getState().setTool(id);
  event.currentTarget.classList.add('is-dragging-context');
  const glyph = event.currentTarget.querySelector('svg, .vex-icon, span') ?? event.currentTarget;
  const box = glyph.getBoundingClientRect();
  event.dataTransfer.setDragImage(glyph, box.width / 2, box.height / 2);
}

export function endToolDrag(event: React.DragEvent<HTMLElement>) {
  event.currentTarget.classList.remove('is-dragging-context');
}

export type ItemState = 'insert' | 'build';
export type ConstructorMode = 'note' | 'rest' | 'tuplet' | 'timesig' | 'mark';

/** what the Build tab opens on: a mode, and the fields a build item presets */
export interface BuildPreset extends Partial<InsertSpec> {
  mode?: ConstructorMode;
}

export interface LibraryItem {
  key: string;
  label: string;
  state: ItemState;
  glyph: ReactNode;
  /** insert items: the tool id */
  tool?: string;
  /** build items: what the Build tab starts from */
  preset?: BuildPreset;
  hint?: string;
  /** a text caption under the glyph (the grace notes) */
  caption?: string;
}

/** `layout` names the grid a section's cells sit in (CSS `hp-grid--<layout>`) */
export interface LibrarySection {
  title: string;
  /** how the section is used, shown in the status line and in search results: "click a staff" */
  note?: string;
  layout?: 'values' | 'grace' | 'dynamics' | 'tempo' | 'lines' | 'clefs' | 'keys' | 'metres' | 'repeats' | 'tuplets';
  items: LibraryItem[];
}

export type ShelfId = 'notes' | 'marks' | 'signs';

export const VALUE_WORD: Record<DurationValue, string> = {
  w: 'Whole',
  h: 'Half',
  q: 'Quarter',
  '8': 'Eighth',
  '16': 'Sixteenth',
  '32': 'Thirty-second',
};

/** the marks of a note composite (an arpeggio belongs to a chord, built in the inspector) and their SMuFL glyphs */
export const ARTICULATION_GLYPH: Record<Exclude<ArticulationMark, 'arpeggio_up' | 'arpeggio_down'>, string> = {
  staccato: 'articStaccatoAbove',
  staccatissimo: 'articStaccatissimoAbove',
  tenuto: 'articTenutoAbove',
  accent: 'articAccentAbove',
  marcato: 'articMarcatoAbove',
  fermata: 'fermataAbove',
};
export const ACCIDENTAL_GLYPH: Record<'#' | 'b' | 'n', string> = { '#': 'accidentalSharp', b: 'accidentalFlat', n: 'accidentalNatural' };

const GRACE_CAPTION: Record<string, string> = { '8': '8th', '16': '16th', '32': '32nd' };

const text = (t: string) => <span className="hp-txt">{t}</span>;

const insertItem = (tool: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({
  key: tool,
  label: toolLabel(tool),
  state: 'insert',
  tool,
  glyph: <ToolIcon id={tool} />,
  ...extra,
});

const markItem = (tool: string, glyph: ReactNode, hint?: string, label?: string): LibraryItem => {
  const spec = parseMark(tool);
  return { key: tool, label: label ?? (spec ? markLabel(spec) : tool), state: 'insert', tool, glyph, hint };
};

/** a dynamic level as the engraver's own letters: pp = two pianos, mf = mezzo + forte */
const DYNAMIC_CODES: Record<string, string[]> = {
  ppp: ['dynamicPiano', 'dynamicPiano', 'dynamicPiano'],
  pp: ['dynamicPiano', 'dynamicPiano'],
  p: ['dynamicPiano'],
  mp: ['dynamicMezzo', 'dynamicPiano'],
  mf: ['dynamicMezzo', 'dynamicForte'],
  f: ['dynamicForte'],
  ff: ['dynamicForte', 'dynamicForte'],
  fff: ['dynamicForte', 'dynamicForte', 'dynamicForte'],
};

const keyLabel = (fifths: number, name: string) =>
  `${name} major · ${fifths === 0 ? 'no accidentals' : `${Math.abs(fifths)} ${fifths < 0 ? 'flat' : 'sharp'}${Math.abs(fifths) > 1 ? 's' : ''}`}`;

const SHELF_BUILDERS: Record<ShelfId, () => LibrarySection[]> = {
  notes: () => [
    {
      title: 'Notes & rests',
      layout: 'values',
      items: [...NOTE_VALUES.map((v) => insertItem(v)), ...NOTE_VALUES.map((v) => insertItem(v === 'q' ? 'rest' : `rest:${v}`))],
    },
    {
      title: 'Grace notes',
      note: 'click beside a note',
      layout: 'grace',
      items: (['slash', 'plain'] as const).flatMap((kind) =>
        GRACE_VALUES.map((v) => {
          const item = insertItem(`grace:${v}:${kind}`);
          return { ...item, hint: `${kind === 'slash' ? 'Slashed' : 'Plain'} ${GRACE_CAPTION[v] ?? v} grace note` };
        }),
      ),
    },
    {
      title: 'Tuplets',
      layout: 'tuplets',
      items: [insertItem('triplet')],
    },
  ],
  marks: () => {
    const dyn = (level: string) => <DynamicIcon level={level} />;
    return [
      {
        title: 'Dynamics',
        note: 'click a spot',
        layout: 'dynamics',
        items: Object.keys(DYNAMIC_CODES).map((level) => markItem(markToolId({ kind: 'dynamic', dynamic: level as never }), dyn(level))),
      },
      {
        title: 'Hairpins',
        note: 'click start, end',
        layout: 'dynamics',
        items: Object.keys(DYNAMIC_CODES).map((level) =>
          markItem(markToolId({ kind: 'hairpin', target: level as never }), <HairpinIcon level={level} opens={['mf', 'f', 'ff', 'fff'].includes(level)} />, 'Opens or closes to this level'),
        ),
      },
      {
        title: 'Tempo',
        note: 'click a spot',
        layout: 'tempo',
        items: [60, 80, 100, 120, 144].map((bpm) => markItem(markToolId({ kind: 'tempoBpm', bpm }), <span className="tempo-cell"><NotationIcon duration="q" rest={false} />{text(String(bpm))}</span>)),
      },
      {
        title: 'Repeats',
        note: 'click start, end',
        layout: 'lines',
        items: [
          markItem(markToolId({ kind: 'refrain' }), <ToolIcon id={markToolId({ kind: 'refrain' })} />, 'Click where the repeat starts, then where it ends'),
          markItem(markToolId({ kind: 'volta' }), <ToolIcon id={markToolId({ kind: 'volta' })} />, 'Click where the repeat starts and where it ends, then where its first ending ends'),
        ],
      },
      {
        title: 'Lines',
        note: 'click start, end',
        layout: 'lines',
        items: [
          markItem(markToolId({ kind: 'slur' }), <ToolIcon id={markToolId({ kind: 'slur' })} />),
          markItem(markToolId({ kind: 'sustain' }), <ToolIcon id={markToolId({ kind: 'sustain' })} />, 'Click where the pedal goes down, then where it comes up'),
          markItem(markToolId({ kind: 'transition', slower: true }), <span className="hp-word">rit.</span>, 'Click where it starts, then where it ends'),
          markItem(markToolId({ kind: 'transition', slower: false }), <span className="hp-word">accel.</span>, 'Click where it starts, then where it ends'),
          ...[1, -1, 2, -2].map((octaves) => markItem(markToolId({ kind: 'octave', octaves }), <ToolIcon id={markToolId({ kind: 'octave', octaves })} />)),
        ],
      },
    ];
  },
  signs: () => [
    {
      title: 'Clefs',
      note: 'click a staff',
      layout: 'clefs',
      items: (['treble', 'bass'] as const).map((clef) => markItem(markToolId({ kind: 'clef', clef }), <ToolIcon id={markToolId({ kind: 'clef', clef })} />)),
    },
    {
      title: 'Key signatures',
      note: 'click a staff',
      layout: 'keys',
      items: KEY_NAMES.map(({ fifths, name }) =>
        markItem(markToolId({ kind: 'key', fifths }), <ToolIcon id={markToolId({ kind: 'key', fifths })} />, `${name} major`, keyLabel(fifths, name)),
      ),
    },
    {
      title: 'Time signatures',
      note: 'click a measure',
      layout: 'metres',
      items: [[2, 4], [3, 4], [4, 4], [6, 8]].map(([n, d]) => insertItem(`ts:${n}:${d}`)),
    },
  ],
};

export const SHELF_TITLES: Record<ShelfId, string> = { notes: 'Notes', marks: 'Marks', signs: 'Signs' };
export const SHELF_IDS: ShelfId[] = ['notes', 'marks', 'signs'];

/** the sections of one shelf */
export const shelfSections = (shelf: ShelfId): LibrarySection[] => SHELF_BUILDERS[shelf]();

/** the rows under the shelves' "Custom …" lines: what opens the Build tab by hand */
export const CUSTOM_BUILD: Record<'tuplet' | 'timesig', { label: string; preset: BuildPreset }> = {
  tuplet: { label: 'Custom n:m', preset: { mode: 'tuplet' } },
  timesig: { label: 'Custom metre n/m', preset: { mode: 'timesig' } },
};

/** items that live on the Build tab and in the search only: dots, articulations, accidentals */
function buildOnlyItems(): { item: LibraryItem; kind: string }[] {
  const build = (item: LibraryItem, kind: string) => ({ item, kind });
  return [
    build({ key: 'dot', label: 'Dot', state: 'build', preset: { mode: 'note', dots: 1 }, glyph: <SmuflIcon codes={['augmentationDot']} />, hint: 'Build a dotted note' }, 'Dots'),
    build({ key: 'dot2', label: 'Double dot', state: 'build', preset: { mode: 'note', dots: 2 }, glyph: <SmuflIcon codes={['augmentationDot', 'augmentationDot']} />, hint: 'Build a double-dotted note' }, 'Dots'),
    build({ key: 'tuplet', label: 'Tuplet n:m', state: 'build', preset: { mode: 'tuplet' }, glyph: text('n:m'), hint: 'Build any tuplet' }, 'Tuplets'),
    build({ key: 'tsnm', label: 'Time signature n/m', state: 'build', preset: { mode: 'timesig' }, glyph: text('n/m'), hint: 'Build any time signature' }, 'Signs'),
    ...(Object.keys(ARTICULATION_GLYPH) as (keyof typeof ARTICULATION_GLYPH)[]).map((a) =>
      build({
        key: a,
        label: ARTICULATION_LABEL[a],
        state: 'build',
        preset: { mode: 'note', articulations: [a] },
        glyph: <SmuflIcon codes={[ARTICULATION_GLYPH[a]]} />,
        hint: `Build a note with ${a}`,
      }, 'Articulation'),
    ),
    ...(['#', 'b', 'n'] as const).map((acc) =>
      build({
        key: `acc${acc}`,
        label: acc === '#' ? 'Sharp' : acc === 'b' ? 'Flat' : 'Natural',
        state: 'build',
        preset: { mode: 'note', accidental: acc as Accidental },
        glyph: <SmuflIcon codes={[ACCIDENTAL_GLYPH[acc]]} />,
        hint: 'Build a note with this accidental',
      }, 'Accidental'),
    ),
  ];
}

export interface SearchEntry {
  item: LibraryItem;
  /** where it lives and how it is used: "Signs · click a staff", "Accidental · opens Build" */
  where: string;
}

/** every item the search can find, with a line saying where it lives */
export function searchEntries(): SearchEntry[] {
  const onShelves = SHELF_IDS.flatMap((shelf) =>
    shelfSections(shelf).flatMap((section) =>
      section.items.map((item) => ({
        item,
        where: `${SHELF_TITLES[shelf]} · ${section.note ?? (shelf === 'notes' ? 'click the staff' : 'click a staff')}`,
      })),
    ),
  );
  const built = buildOnlyItems().map(({ item, kind }) => ({ item, where: `${kind} · opens Build` }));
  return [...onShelves, ...built];
}

/** the use of a tool as a sentence, for the status line: "Click the staff to place it" */
export function toolUse(tool: string): string {
  if (parseMark(tool)) {
    const section = SHELF_IDS.flatMap((s) => shelfSections(s)).find((sec) => sec.items.some((i) => i.tool === tool));
    return section?.note ? `${section.note[0].toUpperCase()}${section.note.slice(1)}` : 'Click the staff to place it';
  }
  if (tool.startsWith('ts:') || tool.startsWith('timesig')) return 'Click a measure';
  if (tool.startsWith('grace:')) return 'Click beside a note';
  return 'Click the staff to place it';
}
