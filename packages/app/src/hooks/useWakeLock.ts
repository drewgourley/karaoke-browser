import { useEffect, useRef } from 'react';

/**
 * Requests a Screen Wake Lock while `enabled` is true, or whenever the page
 * is running as a PWA in standalone mode (covers iOS "Add to Home Screen",
 * where programmatic fullscreen is unavailable so `isFullscreen` stays false).
 *
 * Wake locks are released by the browser when the page is hidden; this hook
 * re-acquires on `visibilitychange` so it stays active after the user returns.
 *
 * Silently no-ops when the Wake Lock API is unavailable (pre-16.4 iOS, Firefox
 * Android). For older-iOS support add the `nosleep.js` package as a fallback.
 */
export function useWakeLock(enabled: boolean): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  // PWA standalone mode = iOS "Add to Home Screen" full-screen equivalent.
  const isStandalone =
    typeof window !== 'undefined' &&
    window.matchMedia('(display-mode: standalone)').matches;

  const shouldEnable = enabled || isStandalone;

  useEffect(() => {
    if (!shouldEnable || !('wakeLock' in navigator)) return;

    let active = true;

    const acquire = async () => {
      if (!active || document.visibilityState !== 'visible') return;
      try {
        lockRef.current = await navigator.wakeLock.request('screen');
        lockRef.current.addEventListener('release', () => {
          lockRef.current = null;
        });
      } catch {
        // Permission denied or API unavailable — fail silently.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !lockRef.current) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [shouldEnable]);
}
