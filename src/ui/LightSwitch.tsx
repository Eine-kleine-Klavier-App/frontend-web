import { useReducedMotion } from 'motion/react';
import { MoonIcon, SunIcon } from '@/ui/icons';
import { currentTheme, toggleTheme } from '@/ui/theme';
import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

/** The ONE day/night switch: the same control on every page (the rail's foot on wide screens, the
 *  top bar or the tab bar where the rail collapses). It shows where a click takes you — the moon
 *  while it's day, the sun at night. Both icons are always present and the theme in scope picks
 *  the visible one (index.css), so the static copy of the page that ui/theme.ts spreads over the
 *  live one shows the right icon with no React in the loop. The motion: ui/theme.ts. */
export function LightSwitch() {
  const reduce = useReducedMotion();
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'light' as const);
  const label = theme === 'light' ? 'Switch to dark' : 'Switch to light';
  return (
    <button
      type="button"
      className="icon-btn ghost light-switch"
      aria-label={label}
      title={label}
      onClick={(e) => void toggleTheme(e.currentTarget, !!reduce)}
    >
      <span className="light-switch-icon ls-moon">
        <MoonIcon />
      </span>
      <span className="light-switch-icon ls-sun">
        <SunIcon />
      </span>
    </button>
  );
}
