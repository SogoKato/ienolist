import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { GearIcon } from "./icons";

export type Section = "shopping" | "fridge" | "recipes";

const SECTIONS: { key: Section; label: string; href: string }[] = [
  { key: "shopping", label: "買い物", href: "/" },
  { key: "fridge", label: "冷蔵庫", href: "/?list=fridge" },
  { key: "recipes", label: "レシピ", href: "/recipes" },
];

// Where each tab was left, and its list as last seen, while the app stays open: a tab opens the
// page left there (the recipe being cooked from, after a look at the fridge), and from a recipe
// the current tab goes up to the list, still filtered.
const left: Partial<Record<Section, string>> = {};
const lists: Partial<Record<Section, string>> = {};
export const listPath = (section: Section) => lists[section] ?? SECTIONS.find((s) => s.key === section)!.href;

function useHere() {
  const [path] = useLocation();
  const search = useSearch();
  return search ? `${path}?${search}` : path;
}

type TopProps = {
  active: Section;
  counts?: Partial<Record<Section, number>>;
  // Fetches the page's data again; called on a pull from the top or a tap on the current tab.
  onRefresh(): Promise<unknown>;
  // Stays in view with the header and tabs (the add box, the search box).
  children?: ReactNode;
};

// The top of the three main pages, which also refresh: pulled down from the top, or with a tap on
// the current tab.
export function MainTop({ active, counts, onRefresh, children }: TopProps) {
  const { pull, refreshing, refresh } = usePullToRefresh(onRefresh);
  const here = useHere();
  useEffect(() => {
    lists[active] = here;
  }, [active, here]);
  return (
    <>
      <Top
        at={active}
        counts={counts}
        onCurrent={() => {
          // The current tab again: back to the top, with what is on the server now.
          window.scrollTo({ top: 0, behavior: "smooth" });
          refresh();
        }}
      >
        {children}
      </Top>
      <div className="pull" style={{ height: refreshing ? PULL_AT : pull, transition: pull && !refreshing ? "none" : undefined }} aria-live="polite">
        {refreshing ? "更新中…" : pull >= PULL_AT ? "離すと更新" : pull > 0 ? "引っ張って更新" : ""}
      </div>
    </>
  );
}

// The top every signed-in page starts with: the app's name, the way to the settings and the tabs
// stay in view while the page scrolls under them. `at` is the tab the page belongs to, lit, or the
// settings, where the gear is lit instead.
export function Top({ at, counts = {}, onCurrent, children }: { at: Section | "settings"; counts?: Partial<Record<Section, number>>; onCurrent?(): void; children?: ReactNode }) {
  const [, navigate] = useLocation();
  const here = useHere();
  useEffect(() => {
    if (at !== "settings") left[at] = here;
  }, [at, here]);
  // The settings' entry in the history says which page the gear opened them from.
  const from = (history.state as { from?: string } | null)?.from;
  return (
    <div className="top">
      <header className="bar">
        <h1>家のリスト</h1>
        {at === "settings" ? (
          // There the gear closes them: back to that page, or to the shopping list when they were
          // opened some other way (by their address, after signing in).
          <Link
            href={from ?? "/"}
            className="icon-link active"
            aria-label="設定を閉じる"
            onClick={(event) => {
              event.preventDefault();
              if (from) history.back();
              else navigate("/", { replace: true });
            }}
          >
            <GearIcon />
          </Link>
        ) : (
          <Link href="/settings" state={{ from: here }} className="icon-link" aria-label="設定">
            <GearIcon />
          </Link>
        )}
      </header>
      {/* Links, so the back button and reloads keep the place. */}
      <nav className="tabs" role="tablist">
        {SECTIONS.map(({ key, label, href }) => (
          <Link
            key={key}
            href={href}
            role="tab"
            aria-selected={at === key}
            className={at === key ? "tab active" : "tab"}
            onClick={(event) => {
              event.preventDefault();
              if (at !== key) navigate(left[key] ?? href);
              else if (onCurrent) onCurrent();
              else navigate(listPath(key));
            }}
          >
            {label}
            {counts[key] !== undefined && <span className="count">{counts[key]}</span>}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}

// How far (in CSS pixels, after the drag is damped) a pull must go before letting go refreshes.
const PULL_AT = 56;

// Pull down from the very top of the page and let go to refresh. The app runs as an installed
// web app, where the phone's own pull-to-refresh is not there.
function usePullToRefresh(onRefresh: () => Promise<unknown>) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const latest = useRef(onRefresh);
  latest.current = onRefresh;

  const refresh = useRef(async () => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    try {
      await latest.current();
    } finally {
      busy.current = false;
      setRefreshing(false);
    }
  }).current;

  useEffect(() => {
    let startY: number | null = null;
    let distance = 0;
    const start = (event: TouchEvent) => {
      startY = window.scrollY <= 0 && event.touches.length === 1 ? event.touches[0].clientY : null;
      distance = 0;
    };
    const move = (event: TouchEvent) => {
      if (startY === null) return;
      if (window.scrollY > 0) {
        startY = null;
        setPull(0);
        return;
      }
      // Half the finger's travel, so it feels like pulling against something.
      distance = Math.min(Math.max(0, event.touches[0].clientY - startY) / 2, PULL_AT * 1.5);
      setPull(distance);
    };
    const end = () => {
      if (startY !== null && distance >= PULL_AT) refresh();
      startY = null;
      distance = 0;
      setPull(0);
    };
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    };
  }, [refresh]);

  return { pull, refreshing, refresh };
}
