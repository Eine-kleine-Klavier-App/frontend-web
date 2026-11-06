// TEMPORARY demo (not committed): the editor on a score built through the backend engine, with no sign-in and no draft.
// Editing does nothing here: the gateway hands the same document back.
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './index.css';
import { useEditor } from '@/app/store';
import { fromView } from '@/core/model/fromView';
import { EditorView } from '@/features/editor/EditorView';
import { PropertiesPanel } from '@/features/editor/PropertiesPanel';

const view = await (await fetch('/' + (new URLSearchParams(location.search).get('view') ?? 'demo-view') + '.json')).json();
const drop = (new URLSearchParams(location.search).get('drop') ?? '').split(',').filter(Boolean);
view.contexts = view.contexts.filter((c: { kind: string }) => !drop.includes(c.kind));
const document = fromView(view, 'demo');
useEditor.setState({
  document, loading: false, scoreId: 'demo', locked: false, pitchPolicy: 'preserve_pitch',
  gateway: { apply: async (_id: string, command: unknown) => { ((window as never as { __commands: unknown[] }).__commands ??= []).push(command); return useEditor.getState().document; } },
} as never);
(window as never as { __editor: unknown }).__editor = useEditor;
createRoot(window.document.getElementById('root')!).render(<div style={{ height: '100vh', display: 'flex' }}><div style={{ flex: 1, minWidth: 0 }}><EditorView /></div><div style={{ width: 320 }}><PropertiesPanel placement="rail" /></div></div>);
