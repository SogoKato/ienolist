import { Link } from "wouter";

export type Section = "shopping" | "fridge" | "recipes";

const SECTIONS: { key: Section; label: string; href: string }[] = [
  { key: "shopping", label: "買い物", href: "/" },
  { key: "fridge", label: "冷蔵庫", href: "/?list=fridge" },
  { key: "recipes", label: "レシピ", href: "/recipes" },
];

// The app's name and the way to the settings, on every main page.
export function MainHeader() {
  return (
    <header className="bar">
      <h1>家のリスト</h1>
      <Link href="/settings" className="icon-link" aria-label="設定">
        設定
      </Link>
    </header>
  );
}

// The three main pages. They are links, so the back button and reloads keep the place.
export function MainTabs({ active, counts = {} }: { active: Section; counts?: Partial<Record<Section, number>> }) {
  return (
    <nav className="tabs" role="tablist">
      {SECTIONS.map(({ key, label, href }) => (
        <Link key={key} href={href} role="tab" aria-selected={active === key} className={active === key ? "tab active" : "tab"}>
          {label}
          {counts[key] !== undefined && <span className="count">{counts[key]}</span>}
        </Link>
      ))}
    </nav>
  );
}
