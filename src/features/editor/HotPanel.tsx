import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/app/store';
import { ChoiceThumb } from '@/ui/ChoiceGroup';
import { ChevronRightIcon, CloseIcon, SearchIcon } from '@/ui/icons';
import { NOTE_VALUES, toolLabel } from '@/core/model/insertItems';
import { markLabel, parseMark } from '@/core/model/markTools';
import { Constructor } from './Constructor';
import { ToolIcon } from './icons';
import {
  CUSTOM_BUILD,
  SHELF_TITLES,
  beginToolDrag,
  endToolDrag,
  searchEntries,
  shelfSections,
  toolUse,
  type BuildPreset,
  type LibraryItem,
  type LibrarySection,
  type ShelfId,
} from './libraryItems';

// The rail library: one horizontal category row over a full-width shelf.

const VALUE_HEAD: Record<string, string> = { w: '1/1', h: '1/2', q: '1/4', '8': '1/8', '16': '1/16', '32': '1/32' };
const RESULTS_SHOWN = 8;

type Tab = ShelfId | 'build';
const CATEGORY_TABS: readonly Tab[] = ['notes', 'marks', 'signs', 'build'];

const armedLabel = (tool: string) => {
  const mark = parseMark(tool);
  return mark ? markLabel(mark) : toolLabel(tool);
};

export function HotPanel({ onRequestOpen, onPick }: {
  onRequestOpen?: () => void;
  onPick?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('notes');
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<{ value: BuildPreset; key: number }>({ value: {}, key: 0 });
  const [focusTick, setFocusTick] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const catGroupId = useId();
  const cellGroupId = useId();
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const locked = useEditor((s) => s.locked);

  const build = (value: BuildPreset) => {
    setQuery('');
    setPreset((p) => ({ value, key: p.key + 1 }));
    setTab('build');
  };
  const arm = (id: string) => {
    if (locked) return;
    setTool(id);
    onPick?.();
  };
  const choose = (next: Tab) => {
    setQuery('');
    setTab(next);
  };

  // "/" jumps to the search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Slash' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      e.preventDefault();
      onRequestOpen?.();
      if (tab === 'build') setTab('notes');
      setFocusTick((n) => n + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, onRequestOpen]);
  useEffect(() => { if (focusTick) searchRef.current?.focus(); }, [focusTick]);

  const entries = useMemo(searchEntries, []);
  const q = query.trim().toLowerCase();
  // a name that starts with the query first, then one that contains it, then a match in the hint or the place
  const found = q
    ? entries
        .map((entry) => {
          const label = entry.item.label.toLowerCase();
          const rank = label.startsWith(q) ? 0 : label.includes(q) ? 1 : `${entry.item.hint ?? ''} ${entry.where}`.toLowerCase().includes(q) ? 2 : -1;
          return { entry, rank };
        })
        .filter(({ rank }) => rank >= 0)
        .sort((a, b) => a.rank - b.rank)
        .map(({ entry }) => entry)
    : [];

  const cat = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      tabIndex={tab === id ? 0 : -1}
      id={`${catGroupId}-${id}`}
      aria-controls={`${catGroupId}-shelf`}
      aria-selected={tab === id}
      className={'hp-cat' + (tab === id ? ' active' : '')}
      onClick={() => choose(id)}
    >
      {tab === id && <ChoiceThumb groupId={catGroupId} />}
      <span className="hp-cat-label">{label}</span>
    </button>
  );

  const cell = (item: LibraryItem) => {
    const active = tool === item.tool;
    return (
      <button
        key={item.key}
        type="button"
        className={'hp-cell' + (active ? ' active' : '') + (item.caption ? ' hp-cell--captioned' : '')}
        title={item.hint ? `${item.label} — ${item.hint}` : item.label}
        aria-label={item.label}
        aria-pressed={active}
        aria-disabled={locked}
        draggable={!locked}
        onDragStart={(e) => beginToolDrag(e, item.tool!)}
        onDragEnd={endToolDrag}
        onClick={() => arm(item.tool!)}
      >
        {active && <ChoiceThumb groupId={cellGroupId} />}
        {item.glyph}
        {item.caption && <span className="hp-cell-caption">{item.caption}</span>}
      </button>
    );
  };

  const section = (s: LibrarySection) => (
    <section key={s.title} className="hp-section" aria-label={s.title}>
      <div className="hp-head"><span>{s.title}</span></div>
      <div className={`hp-grid hp-grid--${s.layout ?? 'values'}`}>
        {s.layout === 'values' && NOTE_VALUES.map((v) => <span key={v} className="hp-values-head" aria-hidden="true">{VALUE_HEAD[v]}</span>)}
        {s.items.map(cell)}
        {s.title === 'Tuplets' && <CustomRow label={CUSTOM_BUILD.tuplet.label} onClick={() => build(CUSTOM_BUILD.tuplet.preset)} />}
      </div>
      {s.title === 'Time signatures' && <CustomRow label={CUSTOM_BUILD.timesig.label} onClick={() => build(CUSTOM_BUILD.timesig.preset)} />}
    </section>
  );

  const armed = tool !== 'select';
  const body = tab === 'build'
    ? <Constructor key={preset.key} preset={preset.value} />
    : (
      <>
        <label className="hp-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="text"
            role="searchbox"
            placeholder="Search elements"
            aria-label="Search elements"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && found[0]) {
                const { item } = found[0];
                if (item.state === 'insert' && item.tool) arm(item.tool); else if (item.preset) build(item.preset);
              }
            }}
          />
          {query ? (
            <button type="button" className="hp-search-clear" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><CloseIcon /></button>
          ) : (
            <kbd aria-hidden="true">/</kbd>
          )}
        </label>
        <div className="hp-scroll keycap-grid">
          {q ? (
            <>
              {found.slice(0, RESULTS_SHOWN).map(({ item, where }) => (
                <button
                  key={`${where}:${item.key}`}
                  type="button"
                  className={'hp-result' + (tool === item.tool ? ' active' : '')}
                  draggable={item.state === 'insert'}
                  onDragStart={(e) => item.tool && beginToolDrag(e, item.tool)}
                  onDragEnd={endToolDrag}
                  onClick={() => (item.state === 'insert' && item.tool ? arm(item.tool) : item.preset && build(item.preset))}
                >
                  <span className="hp-result-glyph">{item.glyph}</span>
                  <span className="hp-result-text"><strong>{item.label}</strong><small>{where}</small></span>
                  {item.state === 'build' && <span className="hp-result-badge">Build</span>}
                </button>
              ))}
              {found.length > RESULTS_SHOWN && <p className="hp-empty">{found.length - RESULTS_SHOWN} more — type a little more.</p>}
              {!found.length && <p className="hp-empty">Nothing matches “{query.trim()}”.</p>}
            </>
          ) : (
            shelfSections(tab).map(section)
          )}
        </div>
        <div className="hp-status" role="status">
          {q ? (
            <span className="hp-status-text hp-status-text--hint">Enter arms it · drag to a slot, or <kbd>⌥</kbd> + digit pins it.</span>
          ) : locked ? (
            <span className="hp-status-text hp-status-text--hint">Editing is locked. Unlock with <kbd>L</kbd>.</span>
          ) : armed ? (
            <>
              <span className="hp-status-glyph"><ToolIcon id={tool} /></span>
              <span className="hp-status-text"><strong>{armedLabel(tool)}</strong><small>{toolUse(tool)}</small></span>
              <button type="button" className="hp-status-key" title="Stop placing (V)" aria-label="Stop placing (V)" onClick={() => setTool('select')}><kbd>V</kbd></button>
            </>
          ) : (
            <span className="hp-status-text hp-status-text--hint">Pick an element, then click the score.</span>
          )}
        </div>
      </>
    );

  return (
    <div className="hot-panel">
      <div className="hp-cats" role="tablist" aria-orientation="horizontal" aria-label="Library" onKeyDown={(e) => {
        // One Tab stop; arrows, Home and End move the active category.
        const keys: Record<string, 'prev' | 'next' | 'first' | 'last'> = { ArrowUp: 'prev', ArrowLeft: 'prev', ArrowDown: 'next', ArrowRight: 'next', Home: 'first', End: 'last' };
        const move = keys[e.key];
        if (!move || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.hp-cat'));
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (at === -1) return;
        e.preventDefault();
        e.stopPropagation();
        const to = move === 'first' ? 0 : move === 'last' ? buttons.length - 1 : (at + (move === 'next' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[to].focus();
        choose(CATEGORY_TABS[to]);
      }}>
        {CATEGORY_TABS.map((id) => cat(id, id === 'build' ? 'Build' : SHELF_TITLES[id]))}
      </div>
      <div className="hp-shelf" role="tabpanel" id={`${catGroupId}-shelf`} aria-labelledby={`${catGroupId}-${tab}`}>{body}</div>
    </div>
  );
}

/** a quiet line that opens the Build tab on a mode ("Custom n:m") */
function CustomRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="hp-row" onClick={onClick}>
      <span>{label}</span>
      <ChevronRightIcon />
    </button>
  );
}
