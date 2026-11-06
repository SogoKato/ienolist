import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { accessLabel, api, type Connection, type Member, type Passkey } from "../api";
import { describeError, guessDeviceName, registerPasskey } from "../passkeys";
import { useSession } from "../session";
import { ErrorText, formatDate, Page } from "../ui";

export function Settings() {
  const { state, setMe } = useSession();
  const [, navigate] = useLocation();
  const [error, setError] = useState("");
  if (state.status !== "in") return null;
  const { me } = state;

  async function logout() {
    try {
      await api.post("/api/logout");
    } catch {
      // Signing out locally is what matters.
    }
    setMe(null);
    navigate("/login", { replace: true });
  }

  return (
    <Page title="設定" at="settings">
      <p>
        {me.household.name} / {me.user.displayName} さん{me.user.role === "admin" ? "(管理者)" : ""}
      </p>
      <ErrorText>{error}</ErrorText>
      <Connections onError={setError} />
      <Passkeys onError={setError} />
      <Members admin={me.user.role === "admin"} selfId={me.user.id} onError={setError} />
      <section>
        <button onClick={logout}>ログアウト</button>
      </section>
    </Page>
  );
}

function Connections({ onError }: { onError(message: string): void }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const load = useCallback(() => api.get<{ connections: Connection[] }>("/api/connections").then((r) => setConnections(r.connections), (e) => onError(describeError(e))), [onError]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-labelledby="connections">
      <h2 id="connections">接続中のアシスタント</h2>
      <p className="muted">Claude などが、あなたの代わりにリストを使えるようにした接続です。</p>
      {connections?.length === 0 && <p className="muted">接続はありません。</p>}
      <ul className="plain rows">
        {connections?.map((c) => (
          <li key={c.id}>
            <span>
              <strong>{c.clientName}</strong>
              <span className="muted"> {formatDate(c.createdAt)} から ・ {accessLabel(c.scopes)}</span>
            </span>
            <button
              onClick={async () => {
                if (!confirm(`「${c.clientName}」の接続を解除しますか？`)) return;
                try {
                  await api.delete(`/api/connections/${c.id}`);
                  await load();
                } catch (e) {
                  onError(describeError(e));
                }
              }}
            >
              解除
            </button>
          </li>
        ))}
      </ul>
      {/* What connecting brings and how, on a page of its own. */}
      <Link href="/assistants" state={{ from: "/settings" }} className="promo">
        <strong>Claude や ChatGPT とつなぐ</strong>
        <span>話しかけるだけでリストが動きます。頼み方の例とつなぎ方</span>
      </Link>
    </section>
  );
}

function Passkeys({ onError }: { onError(message: string): void }) {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [deviceName, setDeviceName] = useState(guessDeviceName());
  const load = useCallback(() => api.get<{ passkeys: Passkey[] }>("/api/passkeys").then((r) => setPasskeys(r.passkeys), (e) => onError(describeError(e))), [onError]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-labelledby="passkeys">
      <h2 id="passkeys">パスキー</h2>
      <ul className="plain rows">
        {passkeys?.map((p) => (
          <li key={p.id}>
            <span>
              <strong>{p.deviceName ?? "名前なし"}</strong>
              <span className="muted"> {formatDate(p.createdAt)} に追加{p.lastUsedAt ? ` ・ 最後の利用 ${formatDate(p.lastUsedAt)}` : ""}</span>
            </span>
            {passkeys.length > 1 && (
              <button
                onClick={async () => {
                  if (!confirm("このパスキーを削除しますか？")) return;
                  try {
                    await api.delete(`/api/passkeys/${encodeURIComponent(p.id)}`);
                    await load();
                  } catch (e) {
                    onError(describeError(e));
                  }
                }}
              >
                削除
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="add"
        onSubmit={async (event) => {
          event.preventDefault();
          onError("");
          try {
            await registerPasskey("/api/passkeys/options", {}, "/api/passkeys/finish", deviceName);
            await load();
          } catch (e) {
            onError(describeError(e));
          }
        }}
      >
        <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} aria-label="この端末の名前" maxLength={100} />
        <button>この端末のパスキーを追加</button>
      </form>
    </section>
  );
}

function Members({ admin, selfId, onError }: { admin: boolean; selfId: string; onError(message: string): void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: number; forName: string | null } | null>(null);

  useEffect(() => {
    api.get<{ members: Member[] }>("/api/members").then((r) => setMembers(r.members), (e) => onError(describeError(e)));
  }, [onError]);

  async function invite(forUser?: Member) {
    onError("");
    try {
      const created = await api.post<{ path: string; expiresAt: number }>("/api/invites", forUser ? { forUserId: forUser.id } : {});
      setLink({ url: `${window.location.origin}${created.path}`, expiresAt: created.expiresAt, forName: forUser?.displayName ?? null });
    } catch (e) {
      onError(describeError(e));
    }
  }

  return (
    <section aria-labelledby="members">
      <h2 id="members">家族</h2>
      <ul className="plain rows">
        {members?.map((m) => (
          <li key={m.id}>
            <span>
              <strong>{m.displayName}</strong>
              <span className="muted"> {m.role === "admin" ? "管理者" : "メンバー"}</span>
            </span>
            {admin && m.id !== selfId && <button onClick={() => invite(m)}>パスキー再登録のリンク</button>}
          </li>
        ))}
      </ul>
      {admin && <button onClick={() => invite()}>家族を招待するリンクを作る</button>}
      {link && (
        <div className="invite" role="status">
          <p>
            {link.forName ? `${link.forName} さんがパスキーを作り直すためのリンク` : "招待リンク"}です。{new Date(link.expiresAt * 1000).toLocaleDateString("ja-JP")} まで、1 回だけ使えます。相手だけに渡してください。
          </p>
          <input readOnly value={link.url} aria-label="リンク" onFocus={(e) => e.currentTarget.select()} />
          <button onClick={() => navigator.clipboard?.writeText(link.url).catch(() => {})}>コピー</button>
        </div>
      )}
    </section>
  );
}
