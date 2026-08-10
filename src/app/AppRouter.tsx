import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/app/AppShell';
import ExploreScreen from '@/features/explore/ExploreScreen';
import LibraryScreen from '@/features/library/LibraryScreen';
import EditorScreen from '@/features/editor/EditorScreen';
import ScoreDetailScreen from '@/features/browse/ScoreDetailScreen';
import AuthorProfileScreen from '@/features/browse/AuthorProfileScreen';
import YouScreen from '@/features/browse/YouScreen';

/** Top-level route tree. Explore/Library sit inside AppShell's nav chrome (a layout route —
 *  `<Outlet/>` renders whichever of the two is active). The editor is a SIBLING route, not
 *  nested under AppShell — it's a screen you're pushed into by draft id, not a persistent tab,
 *  and keeps its own existing chrome untouched (see AppShell.tsx). */
export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/library" replace />} />
          <Route path="/explore" element={<ExploreScreen />} />
          <Route path="/library" element={<LibraryScreen />} />
          <Route path="/scores/:scoreId" element={<ScoreDetailScreen />} />
          <Route path="/authors/:authorId" element={<AuthorProfileScreen />} />
          <Route path="/you" element={<YouScreen />} />
        </Route>
        <Route path="/edit/:draftId" element={<EditorScreen />} />
      </Routes>
    </BrowserRouter>
  );
}
