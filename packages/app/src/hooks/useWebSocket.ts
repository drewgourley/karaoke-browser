import { useEffect, useRef, useState, useCallback } from 'react';
import type { ClientMessage, ServerMessage } from '@karaoke-browser/shared';

type Role = 'controller' | 'player' | 'request';

interface UseWebSocketReturn {
  sendMessage: (msg: ClientMessage) => void;
  lastMessage: ServerMessage | null;
  connected: boolean;
  displaced: boolean;
  reclaim: () => void;
}

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS     = 15_000;
const BACKOFF_FACTOR     = 2;

export function useWebSocket(
  role: Role,
  sessionId: string | null
): UseWebSocketReturn {
  const wsRef        = useRef<WebSocket | null>(null);
  const backoffRef   = useRef(BACKOFF_INITIAL_MS);
  const retryTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted    = useRef(true);

  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const [connected, setConnected]     = useState(false);
  const [displaced, setDisplaced]     = useState(false);

  const connect = useCallback(() => {
    if (!isMounted.current || !sessionId) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url   = `${proto}//${window.location.host}/ws?role=${role}&s=${sessionId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMounted.current) { ws.close(); return; }
      backoffRef.current = BACKOFF_INITIAL_MS;
      setConnected(true);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (!isMounted.current) return;
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        setLastMessage(msg);
      } catch { /* ignore malformed */ }
    };

    ws.onclose = (event: CloseEvent) => {
      if (!isMounted.current) return;
      setConnected(false);
      wsRef.current = null;
      // Code 4410: deliberately displaced by a newer connection — stop reconnecting.
      if (event.code === 4410) {
        setDisplaced(true);
        return;
      }
      // Exponential backoff reconnect
      retryTimer.current = setTimeout(() => {
        if (!isMounted.current) return;
        backoffRef.current = Math.min(backoffRef.current * BACKOFF_FACTOR, BACKOFF_MAX_MS);
        connect();
      }, backoffRef.current);
    };

    ws.onerror = () => { ws.close(); };
  }, [role, sessionId]);

  useEffect(() => {
    isMounted.current = true;
    connect();
    return () => {
      isMounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const reclaim = useCallback(() => {
    setDisplaced(false);
    backoffRef.current = BACKOFF_INITIAL_MS;
    connect();
  }, [connect]);

  const sendMessage = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { sendMessage, lastMessage, connected, displaced, reclaim };
}
