import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { api, type Me } from "../api";
import { describeError, guessDeviceName, registerPasskey } from "../passkeys";
import { useSession } from "../session";
import { ErrorText, Page } from "../ui";

export function Setup() {
  const { setMe } = useSession();
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<{ initialized: boolean; needsSetupToken: boolean } | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [deviceName, setDeviceName] = useState(guessDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<{ initialized: boolean; needsSetupToken: boolean }>("/api/setup").then(setStatus, (e) => setError(describeError(e)));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const me = await registerPasskey<Me>("/api/setup/options", { displayName, householdName, setupToken: setupToken || undefined }, "/api/setup/finish", deviceName);
      setMe(me);
      navigate("/", { replace: true });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (status?.initialized) {
    return (
      <Page title="セットアップ済み">
        <p>このアプリはすでにセットアップされています。</p>
        <Link href="/login">ログインへ</Link>
      </Page>
    );
  }

  return (
    <Page title="最初のセットアップ">
      <p>あなたが、この家の管理者になります。パスキーはこの端末に保存されます。</p>
      <form onSubmit={submit} className="stack">
        <label>
          あなたの名前
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={100} required autoComplete="name" />
        </label>
        <label>
          家の名前
          <input value={householdName} onChange={(e) => setHouseholdName(e.target.value)} maxLength={100} required placeholder="例: 我が家" />
        </label>
        {status?.needsSetupToken && (
          <label>
            セットアップ用トークン
            <input value={setupToken} onChange={(e) => setSetupToken(e.target.value)} type="password" required autoComplete="off" />
          </label>
        )}
        <label>
          この端末の名前
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={100} />
        </label>
        <ErrorText>{error}</ErrorText>
        <button className="primary wide" disabled={busy}>
          パスキーを作って始める
        </button>
      </form>
    </Page>
  );
}
