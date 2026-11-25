import { useEffect } from 'react';

/** Keeps the screen awake while `active`. The browser drops the lock whenever the tab is hidden, so it
 *  is asked for again when the tab is shown. A browser without the API, or one that refuses (no secure
 *  context, battery saver), leaves the screen to its own timeout: that is no error for the user. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = () => {
      if (sentinel && !sentinel.released) return;
      navigator.wakeLock.request('screen').then(
        (granted) => {
          if (cancelled) void granted.release();
          else sentinel = granted;
        },
        () => {},
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release();
    };
  }, [active]);
}
