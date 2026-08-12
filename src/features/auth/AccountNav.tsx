import { NavLink, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/core/auth/authStore';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { withPreview } from '@/features/browse/previewRoute';
import { UserIcon } from '@/ui/icons';

/** The account block at the foot of the app nav. Anonymous → a "Sign in" CTA that opens the login
 *  modal RIGHT OVER the current page (no intermediary screen — reads stay where they are). Signed
 *  in → the username row links straight to the personal "You" area; sign-out lives inside that
 *  profile, not in a nav menu. `username` may be null for a moment after a silent refresh (it
 *  arrives from /auth/me) — fall back to a neutral label. */
export function AccountNav() {
  const [searchParams] = useSearchParams();
  const status = useAuthStore((s) => s.status);
  const username = useAuthStore((s) => s.username);
  const openLogin = useAuthPrompt((s) => s.open);

  const label = username ?? 'You';
  const initial = (username ?? 'Y').charAt(0).toUpperCase();
  const profileHref = withPreview('/you', searchParams.get('preview'));
  return (
    <div className="app-nav-account-slot">
      {status === 'authed' ? (
        <NavLink
          to={profileHref}
          className={({ isActive }) => 'app-nav-item app-nav-account' + (isActive ? ' active' : '')}
        >
          <span className="app-nav-avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="app-nav-account-name">{label}</span>
        </NavLink>
      ) : (
        <button
          type="button"
          className="app-nav-item app-nav-account app-nav-signin"
          onClick={() => openLogin()}
          disabled={status === 'loading'}
        >
          <span className="app-nav-avatar app-nav-avatar--anon" aria-hidden="true">
            <UserIcon />
          </span>
          <span className="app-nav-account-name">Sign in</span>
        </button>
      )}
    </div>
  );
}
