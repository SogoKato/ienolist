import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "./api";

type State = { status: "loading" } | { status: "out" } | { status: "in"; me: Me };
type Value = { state: State; setMe(me: Me | null): void; reload(): Promise<void> };

const Context = createContext<Value | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const setMe = useCallback((me: Me | null) => setState(me ? { status: "in", me } : { status: "out" }), []);
  const reload = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/api/me"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setMe(null);
      else throw error;
    }
  }, [setMe]);
  useEffect(() => {
    reload().catch(() => setMe(null));
  }, [reload, setMe]);
  return <Context.Provider value={{ state, setMe, reload }}>{children}</Context.Provider>;
}

export function useSession(): Value {
  const value = useContext(Context);
  if (!value) throw new Error("useSession needs a SessionProvider");
  return value;
}
