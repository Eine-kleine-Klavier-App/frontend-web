import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CompassIcon, LibraryIcon } from '@/ui/icons';
import { ChoiceThumb } from '@/ui/ChoiceGroup';
import { withPreview } from '@/features/browse/previewRoute';
import { AccountNav } from '@/features/auth/AccountNav';
import { useAuthStore } from '@/core/auth/authStore';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { LightSwitch } from '@/ui/LightSwitch';
import { CollectionTree } from '@/features/library/CollectionTree';

const NAV_ITEMS = [
  { to: '/explore', label: 'Explore', Icon: CompassIcon },
  { to: '/library', label: 'Library', Icon: LibraryIcon },
];

export function RailNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const authStatus = useAuthStore((s) => s.status);
  const openLogin = useAuthPrompt((s) => s.open);
  const authed = authStatus === 'authed';
  const previewId = searchParams.get('preview');
  const showCollections = authed && location.pathname.startsWith('/library');
  const tabHref = (pathname: string) => withPreview(pathname, previewId);

  return (
    <>
      <div className="app-nav-tabs">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink key={to} to={tabHref(to)}
            className={({ isActive }) => 'app-nav-item' + (isActive && !(to === '/library' && !authed) ? ' active' : '')}
            onClick={(event) => {
              if (to !== '/library' || authed) return;
              event.preventDefault();
              if (authStatus === 'anonymous') openLogin(() => navigate(tabHref('/library')));
            }}>
            {({ isActive }) => (
              <>
                {isActive && !(to === '/library' && !authed) && <ChoiceThumb groupId="app-nav-tabs" />}
                <Icon /><span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
      <CollectionTree visible={showCollections} previewId={previewId} />
      <div className="app-nav-foot"><AccountNav /><LightSwitch /></div>
    </>
  );
}
