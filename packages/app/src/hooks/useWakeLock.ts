import { useEffect, useRef, useCallback } from 'react';
import NoSleep from 'nosleep.js';

/**
 * Returns `{ enable, disable }` functions that MUST be called directly from
 * user-interaction handlers (click / touchstart). iOS Safari enforces that
 * video.play() — the nosleep fallback — happens synchronously within a user
 * gesture; calling it from a useEffect breaks that chain and silently fails.
 *
 * Also auto-enables on the first touch when running as a PWA in standalone
 * mode, since that's the iOS equivalent of fullscreen.
 */
export function useWakeLock(): { enable: () => void; disable: () => void } {
  const nsRef = useRef<InstanceType<typeof NoSleep> | null>(null);

  const getOrCreate = () => {
    if (!nsRef.current) nsRef.current = new NoSleep();
    return nsRef.current;
  };

  const enable = useCallback(() => {
    getOrCreate().enable().catch(() => {});
  }, []);

  const disable = useCallback(() => {
    nsRef.current?.disable();
  }, []);

  // In PWA standalone mode, auto-enable on the very first user touch so iOS
  // gets the wake lock without needing a dedicated fullscreen button.
  useEffect(() => {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    if (!isStandalone) return;
    const onFirstTouch = () => { getOrCreate().enable().catch(() => {}); };
    document.addEventListener('touchstart', onFirstTouch, { once: true });
    document.addEventListener('click',      onFirstTouch, { once: true });
    return () => {
      document.removeEventListener('touchstart', onFirstTouch);
      document.removeEventListener('click',      onFirstTouch);
    };
  }, []);

  // Cleanup on unmount.
  useEffect(() => () => { nsRef.current?.disable(); }, []);

  return { enable, disable };
}
