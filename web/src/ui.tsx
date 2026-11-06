import type { ReactNode } from "react";

// A page under the main ones: the way back (a BackLink) above its title.
export function Page({ title, children, back }: { title: string; children: ReactNode; back?: ReactNode }) {
  return (
    <main className="page">
      {back}
      <header className="bar">
        <h1>{title}</h1>
      </header>
      {children}
    </main>
  );
}

export const ErrorText = ({ children }: { children: ReactNode }) => (children ? <p className="error" role="alert">{children}</p> : null);

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
}
