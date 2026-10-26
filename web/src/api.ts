// The web API, as the browser uses it: JSON over fetch, with the session in a cookie.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, typeof data?.error === "string" ? data.error : `エラーが発生しました (${response.status})`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: (path: string) => request<void>("DELETE", path),
};

export type Role = "admin" | "member";
export type Me = { user: { id: string; displayName: string; role: Role }; household: { id: string; name: string } };

export type List = "shopping" | "fridge";
export type Status = "to_buy" | "bought" | "in_stock" | "used_up";
export type Item = { id: string; list: List; status: Status; name: string; note: string | null; createdAt: string; updatedAt: string };

export type Recipe = {
  id: string;
  title: string;
  url: string | null;
  book: { id: string; title: string } | null;
  page: string | null;
  tags: string[];
  body?: string | null;
  cookCount: number;
  lastCookedOn: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Book = { id: string; title: string; recipeCount: number };
export type Tag = { tag: string; recipeCount: number };
export type Cook = { id: string; recipeId: string | null; title: string; cookedOn: string; note: string | null; source: "web" | "mcp"; recordedAt: string };

export type Member = { id: string; displayName: string; role: Role };
export type Passkey = { id: string; deviceName: string | null; createdAt: number; lastUsedAt: number | null };
export type Connection = { id: string; clientName: string; scopes: string[]; createdAt: number };

// What a ceremony needs from the server: an id to answer with, and the browser's options.
export type Ceremony<O> = { challengeId: string; options: O };

// Only same-site paths may be followed after signing in (never another site, never `//host`).
export function safeNext(value: string | null): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/";
}
