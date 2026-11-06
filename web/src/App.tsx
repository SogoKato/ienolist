import { Redirect, Route, Router, Switch, useLocation, useSearch } from "wouter";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { Authorize } from "./pages/Authorize";
import { Join } from "./pages/Join";
import { Lists } from "./pages/Lists";
import { useAppLocation } from "./nav";
import { Login } from "./pages/Login";
import { NewRecipe, RecipeDetail, Recipes } from "./pages/Recipes";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { SessionProvider, useSession } from "./session";

// Pages that need someone signed in; anyone else is sent to sign in (or to set the app up),
// and brought back here afterwards.
function Private({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const [location] = useLocation();
  const search = useSearch();
  const [initialized, setInitialized] = useState<boolean | null>(null);
  useEffect(() => {
    if (state.status === "out") api.get<{ initialized: boolean }>("/api/setup").then((s) => setInitialized(s.initialized), () => setInitialized(true));
  }, [state.status]);

  if (state.status === "loading") return <p className="muted center">読み込み中…</p>;
  if (state.status === "in") return <>{children}</>;
  if (initialized === null) return <p className="muted center">読み込み中…</p>;
  if (!initialized) return <Redirect to="/setup" replace />;
  return <Redirect to={`/login?next=${encodeURIComponent(location + (search ? `?${search}` : ""))}`} replace />;
}

export function App() {
  return (
    <SessionProvider>
      <Router hook={useAppLocation}>
        <Switch>
          <Route path="/login" component={Login} />
          <Route path="/setup" component={Setup} />
          <Route path="/join/:token">{(params) => <Join token={params.token} />}</Route>
          <Route path="/authorize">
            <Private>
              <Authorize />
            </Private>
          </Route>
          <Route path="/settings">
            <Private>
              <Settings />
            </Private>
          </Route>
          <Route path="/recipes">
            <Private>
              <Recipes />
            </Private>
          </Route>
          <Route path="/recipes/new">
            <Private>
              <NewRecipe />
            </Private>
          </Route>
          <Route path="/recipes/:id">
            {(params) => (
              <Private>
                <RecipeDetail key={params.id} id={params.id} />
              </Private>
            )}
          </Route>
          <Route path="/">
            <Private>
              <Lists />
            </Private>
          </Route>
          <Route>
            <Redirect to="/" replace />
          </Route>
        </Switch>
      </Router>
    </SessionProvider>
  );
}
