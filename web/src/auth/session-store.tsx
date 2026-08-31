import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiClient, ApiError } from "@/api/client";
import type { SessionResponse } from "@/api/schemas";

export type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "unavailable" }
  | { status: "authenticated"; session: SessionResponse };

interface SessionContextValue {
  api: ApiClient;
  state: SessionState;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const [api] = useState(() => client ?? new ApiClient());
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const session = await api.loadSession();
      setState({ status: "authenticated", session });
    } catch (error) {
      setState(error instanceof ApiError && error.status === 401
        ? { status: "anonymous" }
        : { status: "unavailable" });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ api, state, refresh }), [api, refresh, state]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
