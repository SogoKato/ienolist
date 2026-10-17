import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { api, type Me } from "../api";
import { describeError, guessDeviceName, registerPasskey } from "../passkeys";
import { useSession } from "../session";
import { ErrorText, Page } from "../ui";

type Invite = { householdName: string; recovery: boolean; displayName: string | null };

// The page an invite link opens: join a household, or set a new passkey after losing the old ones.
export function Join({ token }: { token: string }) {
  const { setMe } = useSession();
  const [, navigate] = useLocation();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [deviceName, setDeviceName] = useState(guessDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    api.get<Invite>(`/api/invites/${encodeURIComponent(token)}`).then(setInvite, () => setInvalid(true));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const startPath = `/api/invites/${encodeURIComponent(token)}/options`;
      setMe(await registerPasskey<Me>(startPath, { displayName: displayName || undefined }, "/api/join/finish", deviceName));
      navigate("/", { replace: true });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (invalid) {
    return (
      <Page title="招待リンクが無効です">
        <p>このリンクは、期限切れか、すでに使われています。招待した人に、新しいリンクを頼んでください。</p>
      </Page>
    );
  }
  if (!invite) return <p className="muted center">読み込み中…</p>;

  return (
    <Page title={invite.recovery ? "パスキーを作り直す" : `${invite.householdName} に参加`}>
      {invite.recovery ? (
        <p>
          {invite.displayName} さんのパスキーを、この端末で作り直します。これまでのパスキーとログインは、すべて使えなくなります。
        </p>
      ) : (
        <p>パスキーはこの端末に保存されます。</p>
      )}
      <form onSubmit={submit} className="stack">
        {!invite.recovery && (
          <label>
            あなたの名前
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={100} required autoComplete="name" />
          </label>
        )}
        <label>
          この端末の名前
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={100} />
        </label>
        <ErrorText>{error}</ErrorText>
        <button className="primary wide" disabled={busy}>
          パスキーを作る
        </button>
      </form>
    </Page>
  );
}
