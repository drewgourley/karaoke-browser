import { useState, useEffect, useCallback } from 'react';

/**
 * Manages fullscreen state for document.documentElement.
 * Optionally calls `onExit` when fullscreen is exited (e.g. to disable wake lock).
 */
export function useFullscreen(callbacks?: { onEnter?: () => void; onExit?: () => void }) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = document as any;
      const fs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
      setIsFullscreen(fs);
      if (!fs) callbacks?.onExit?.();
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = document.documentElement as any, doc = document as any;
    if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
      (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch(() => {});
      callbacks?.onEnter?.();
    } else {
      (document.exitFullscreen ?? (doc).webkitExitFullscreen)?.call(document)?.catch(() => {});
      callbacks?.onExit?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isFullscreen, toggle };
}
