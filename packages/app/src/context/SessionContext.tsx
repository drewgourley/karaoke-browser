import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

const SESSION_KEY = 'kp_session';

interface SessionContextValue {
  sessionId: string | null;
  setSessionId: (id: string | null) => void;
  authStatus: { authRequired: boolean; authed: boolean } | null;
  refreshAuth: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionIdState] = useState<string | null>(
    () => localStorage.getItem(SESSION_KEY)
  );
  const [authStatus, setAuthStatus] = useState<{ authRequired: boolean; authed: boolean } | null>(null);

  const setSessionId = (id: string | null) => {
    setSessionIdState(id);
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  };

  const refreshAuth = async () => {
    try {
      const r = await fetch('/api/auth-status');
      if (r.ok) setAuthStatus(await r.json() as { authRequired: boolean; authed: boolean });
    } catch { /* network error — leave null */ }
  };

  useEffect(() => { void refreshAuth(); }, []);

  return (
    <SessionContext.Provider value={{ sessionId, setSessionId, authStatus, refreshAuth }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
