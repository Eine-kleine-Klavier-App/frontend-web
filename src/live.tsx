// TEMPORARY verification stand (not committed): the REAL EditorScreen against the REAL backend through
// the Vite proxy. The access token is minted by the backend's own signer and put in sessionStorage by the test.
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import './styles/tokens.css';
import './index.css';
import { useEditor } from '@/app/store';
import { useAuthStore } from '@/core/auth/authStore';
import { playback } from '@/core/playback/PlaybackController';
import EditorScreen from '@/features/editor/EditorScreen';

const params = new URLSearchParams(location.search);
const token = sessionStorage.getItem('verifyToken');
if (token) useAuthStore.getState().applyAccessToken(token);
useEditor.setState({ pitchPolicy: (params.get('policy') ?? 'ask') as 'ask' | 'preserve_pitch' | 'preserve_step' });
const w = window as never as Record<string, unknown>;
w.__editor = useEditor;
w.__playback = playback;
w.__auth = useAuthStore;
const draft = params.get('draft') ?? '';

createRoot(window.document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[`/edit/${draft}`]}>
    <Routes>
      <Route path="/edit/:draftId" element={<EditorScreen />} />
      <Route path="*" element={<div>elsewhere</div>} />
    </Routes>
  </MemoryRouter>,
);
