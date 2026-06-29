import { useEffect, useRef } from 'react';
import NoSleep from 'nosleep.js';

/**
 * Keeps the screen awake while `enabled` is true, or whenever the page is
 * running as a PWA in standalone mode (covers iOS "Add to Home Screen").
 *
 * Uses the Wake Lock API where available, with an automatic video-loop
 * fallback for browsers that don't support it (pre-16.4 iOS, Firefox Android).
 * Powered by nosleep.js which handles all the edge cases.
 */
export function useWakeLock(enabled: boolean): void {
  const noSleepRef = useRef<InstanceType<typeof NoSleep> | null>(null);

  // PWA standalone mode = iOS "Add to Home Screen" full-screen equivalent.
  const isStandalone =
    typeof window !== 'undefined' &&
    window.matchMedia('(display-mode: standalone)').matches;

  const shouldEnable = enabled || isStandalone;

  useEffect(() => {
    if (!noSleepRef.current) {
      noSleepRef.current = new NoSleep();
    }
    const ns = noSleepRef.current;

    if (shouldEnable) {
      ns.enable().catch(() => {});
    } else {
      ns.disable();
    }

    return () => {
      ns.disable();
    };
  }, [shouldEnable]);
}
