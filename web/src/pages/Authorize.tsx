import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { api } from "../api";
import { describeError } from "../passkeys";
import { useSession } from "../session";
import { ErrorText, Page } from "../ui";

type Ask = { clientName: string; redirectHost: string; scopes: string[] };
type Answer = Ask | { redirectTo: string };

const SCOPE_TEXT: Record<string, string> = {
  "items:read": "買い物リストと冷蔵庫リストを見る",
  "items:write": "アイテムを追加・変更・削除・移動する",
};

// Where an assistant (Claude, ChatGPT, …) asks to use the lists on the person's behalf.
export function Authorize() {
  const search = useSearch();
  const { state } = useSession();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Answer>(`/api/oauth/authorization?${search}`).then(
      (answer) => ("redirectTo" in answer ? window.location.replace(answer.redirectTo) : setAsk(answer)),
      (e) => setError(describeError(e)),
    );
  }, [search]);

  async function decide(decision: "allow" | "deny") {
    setBusy(true);
    setError("");
    try {
      const { redirectTo } = await api.post<{ redirectTo: string }>("/api/oauth/authorize", { params: Object.fromEntries(new URLSearchParams(search)), decision });
      window.location.assign(redirectTo);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  if (error && !ask) {
    return (
      <Page title="接続できません">
        <ErrorText>{error}</ErrorText>
        <Link href="/">ホームへ</Link>
      </Page>
    );
  }
  if (!ask) return <p className="muted center">読み込み中…</p>;

  return (
    <Page title="接続を許可しますか？">
      <p>
        <strong>{ask.clientName}</strong> が、{state.status === "in" ? `${state.me.household.name} のリスト` : "リスト"}を使おうとしています。
      </p>
      <ul className="plain">
        {ask.scopes.map((scope) => (
          <li key={scope}>{SCOPE_TEXT[scope] ?? scope}</li>
        ))}
      </ul>
      <p className="muted">
        許可すると、ブラウザは <code>{ask.redirectHost}</code> に戻ります。心当たりがなければ「許可しない」を選んでください。名前は相手が自己申告したものです。
      </p>
      <ErrorText>{error}</ErrorText>
      <div className="row-actions">
        <button className="primary" onClick={() => decide("allow")} disabled={busy}>
          許可する
        </button>
        <button onClick={() => decide("deny")} disabled={busy}>
          許可しない
        </button>
      </div>
    </Page>
  );
}
