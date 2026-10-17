import { useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { safeNext } from "../api";
import { describeError, signInWithPasskey } from "../passkeys";
import { useSession } from "../session";
import { ErrorText, Page } from "../ui";

export function Login() {
  const { setMe } = useSession();
  const [, navigate] = useLocation();
  const next = safeNext(new URLSearchParams(useSearch()).get("next"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      setMe(await signInWithPasskey());
      navigate(next, { replace: true });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="ログイン">
      <p>この端末に保存したパスキーでログインします。</p>
      <ErrorText>{error}</ErrorText>
      <button className="primary wide" onClick={signIn} disabled={busy}>
        パスキーでログイン
      </button>
      <p className="muted">
        はじめて使う場合は、招待リンクを受け取るか、<Link href="/setup">最初のセットアップ</Link>をしてください。
      </p>
    </Page>
  );
}
