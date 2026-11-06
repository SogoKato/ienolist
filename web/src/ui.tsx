import type { ReactNode } from "react";
import { Top, type Section } from "./nav";

// A page with its own title. Pages of the signed-in app start with the shared top (`at`: the tab
// the page belongs to, or the settings); pages that are a step of something (signing in, setting
// up, joining, allowing a connection) have only their title.
export function Page({ title, at, children }: { title?: string; at?: Section | "settings"; children: ReactNode }) {
  return (
    <main className="page">
      {at && <Top at={at} />}
      {title && (
        <header className="bar">
          <h1>{title}</h1>
        </header>
      )}
      {children}
    </main>
  );
}

export const ErrorText = ({ children }: { children: ReactNode }) => (children ? <p className="error" role="alert">{children}</p> : null);

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
}
