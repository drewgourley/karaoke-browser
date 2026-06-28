import { useEffect, useRef } from 'react';

/**
 * Requests a Screen Wake Lock while `enabled` is true.
 * Wake locks are automatically released by the browser when the page is
 * hidden; this hook re-acquires the lock on `visibilitychange` so it stays
 * active after the user returns to the tab/app.
 *
 * Silently no-ops when the Wake Lock API is unavailable (older browsers).
 */
export function useWakeLock(enabled: boolean): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;

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
  }, [enabled]);
}
