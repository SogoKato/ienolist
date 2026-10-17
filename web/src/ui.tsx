import type { ReactNode } from "react";

export function Page({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <main className="page">
      <header className="bar">
        <h1>{title}</h1>
        {actions}
      </header>
      {children}
    </main>
  );
}

export const ErrorText = ({ children }: { children: ReactNode }) => (children ? <p className="error" role="alert">{children}</p> : null);

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
}
