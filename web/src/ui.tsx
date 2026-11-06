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

// Line icons for a row's actions. They are decoration: the button around each one says what it does.
const icon = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const PencilIcon = () => (
  <svg {...icon}>
    <path d="M4 20l1-4L15.5 5.5a2.12 2.12 0 0 1 3 3L8 19z" />
    <path d="M13.5 7.5l3 3" />
  </svg>
);

export const TrashIcon = () => (
  <svg {...icon}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

export const ErrorText = ({ children }: { children: ReactNode }) => (children ? <p className="error" role="alert">{children}</p> : null);

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
}
