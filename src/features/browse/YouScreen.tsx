import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePageReady } from '@/ui/PageTransition';
import { plateTintClass } from './plateTint';
import { useAuthStore } from '@/core/auth/authStore';
import { AccountSecurity } from '@/features/auth/AccountSecurity';
import { SignInPrompt } from '@/features/auth/SignInPrompt';
import { Button } from '@/ui/Button';
import { ArrowRightIcon, SignOutIcon } from '@/ui/icons';
import { withPreview } from './previewRoute';
import { runAuthSceneTransition } from '@/features/auth/authSceneTransition';
import { BROWSE_QUERY_KEYS, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';

export default function YouScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const authStatus = useAuthStore((s) => s.status);
  const userId = useAuthStore((s) => s.userId);
  const username = useAuthStore((s) => s.username);
  const signOut = useAuthStore((s) => s.signOut);
  const { data: scores } = useBrowseQuery(
    'private', BROWSE_QUERY_KEYS.myScores, () => libraryGateway.listMyScores(), authStatus === 'authed',
  );
  usePageReady(authStatus !== 'loading');
  const previewId = searchParams.get('preview');
  const displayName = username ?? 'You';
  const handleSignOut = () => runAuthSceneTransition('sign-out', () => {
    signOut();
    navigate(withPreview('/explore', previewId), { replace: true });
  });

  if (authStatus === 'loading') return <div className="you-screen"><div className="browse-loading">Restoring your session…</div></div>;
  if (authStatus === 'anonymous') return <div className="you-screen"><SignInPrompt title="You" subtitle="Sign in to see your account and scores." /></div>;

  return (
    <div className="you-screen">
      <header className={'author-hero you-hero ' + plateTintClass(displayName)}>
        <div className="author-avatar" aria-hidden="true">{displayName.trim().charAt(0).toUpperCase() || '?'}</div>
        <div className="author-hero-body">
          <span className="author-hero-eyebrow">Account</span>
          <h1 className="author-hero-name">{displayName}</h1>
          {username && <span className="author-hero-handle">@{username}</span>}
        </div>
        <Button variant="secondary" className="you-signout" icon={<SignOutIcon />} onClick={handleSignOut}>Sign out</Button>
      </header>
      <AccountSecurity />
      {userId && scores && scores.length > 0 && (
        <button type="button" className="you-scores-link"
          onClick={() => navigate(withPreview(`/authors/${userId}`, previewId))}>
          <span>View your scores</span><ArrowRightIcon />
        </button>
      )}
    </div>
  );
}
