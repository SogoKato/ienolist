import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";

export type Section = "shopping" | "fridge" | "recipes";

const SECTIONS: { key: Section; label: string; href: string }[] = [
  { key: "shopping", label: "買い物", href: "/" },
  { key: "fridge", label: "冷蔵庫", href: "/?list=fridge" },
  { key: "recipes", label: "レシピ", href: "/recipes" },
];

type TopProps = {
  active: Section;
  counts?: Partial<Record<Section, number>>;
  // Fetches the page's data again; called on a pull from the top or a tap on the current tab.
  onRefresh(): Promise<unknown>;
  // Stays in view with the header and tabs (the add box, the search box).
  children?: ReactNode;
};

// The top of the three main pages: the app's name, the way to the settings, the tabs and the
// page's own box stay in view while the list scrolls under them.
export function MainTop({ active, counts = {}, onRefresh, children }: TopProps) {
  const { pull, refreshing, refresh } = usePullToRefresh(onRefresh);
  return (
    <>
      <div className="top">
        <header className="bar">
          <h1>家のリスト</h1>
          <Link href="/settings" className="icon-link" aria-label="設定">
            設定
          </Link>
        </header>
        {/* Links, so the back button and reloads keep the place. */}
        <nav className="tabs" role="tablist">
          {SECTIONS.map(({ key, label, href }) => (
            <Link
              key={key}
              href={href}
              role="tab"
              aria-selected={active === key}
              className={active === key ? "tab active" : "tab"}
              onClick={(event) => {
                if (active !== key) return;
                // The current tab again: back to the top, with what is on the server now.
                event.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
                refresh();
              }}
            >
              {label}
              {counts[key] !== undefined && <span className="count">{counts[key]}</span>}
            </Link>
          ))}
        </nav>
        {children}
      </div>
      <div className="pull" style={{ height: refreshing ? PULL_AT : pull, transition: pull && !refreshing ? "none" : undefined }} aria-live="polite">
        {refreshing ? "更新中…" : pull >= PULL_AT ? "離すと更新" : pull > 0 ? "引っ張って更新" : ""}
      </div>
    </>
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
