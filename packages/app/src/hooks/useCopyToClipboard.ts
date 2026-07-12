import { useState, useCallback } from 'react';

/**
 * Returns a copy function and a label that temporarily shows "Copied!" feedback.
 *
 * @param resetMs - How long (ms) before the label resets. Default 1200.
 */
export function useCopyToClipboard(resetMs = 1200) {
  const [label, setLabel] = useState('Copy');

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setLabel('Copied!');
      setTimeout(() => setLabel('Copy'), resetMs);
    } catch { /* clipboard unavailable or denied */ }
  }, [resetMs]);

  return { label, copy };
}
