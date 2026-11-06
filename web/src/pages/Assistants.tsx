import { useEffect, useState } from "react";
import { accessLabel, api, type Connection } from "../api";
import { useSession } from "../session";
import { LinkIcon, PhotoIcon } from "../icons";
import { Page } from "../ui";

// Where an assistant connects: the MCP endpoint at the address the app is open at.
const mcpUrl = () => `${window.location.origin}/mcp`;
// claude.ai's link to its "add custom connector" dialog, filled in; the person still confirms there.
const claudeLink = (name: string) => `https://claude.ai/customize/connectors?${new URLSearchParams({ modal: "add-custom-connector", connectorName: name, connectorUrl: mcpUrl() })}`;

// What a connected assistant can be asked, each as a short conversation: having connected one does
// not tell what it can do. `sent` is what goes along with the words (a photo, a link); the replies
// are made up, to show the kind of answer, and `caption` says in a sentence what it did.
const SHOTS: { label: string; ask: string; sent?: { kind: "photo" | "link"; label: string }; reply: string; caption: string }[] = [
  {
    label: "写真から",
    sent: { kind: "photo", label: "レシートの写真" },
    ask: "買ったものを冷蔵庫に入れて",
    reply: "牛乳、卵、豆腐、長ねぎを冷蔵庫に入れました。",
    caption: "レシートの写真を送ると、買ったものを冷蔵庫に入れてくれます。",
  },
  {
    label: "買い足し",
    ask: "肉じゃがの材料のうち、冷蔵庫にないものを買い物リストに入れて",
    reply: "じゃがいもと玉ねぎは冷蔵庫にあったので、牛肉としらたきを買い物リストに入れました。",
    caption: "冷蔵庫と見比べて、足りないものだけを買い物リストに入れてくれます。",
  },
  {
    label: "レシピ",
    sent: { kind: "link", label: "www.kurashiru.com/recipes/…" },
    ask: "このレシピを登録して",
    reply: "「鶏もも肉と白菜の味噌ミルク煮」を、主菜・煮込みのタグで登録しました。",
    caption: "レシピのページの URL を送ると、レシピ集に登録してくれます。",
  },
  {
    label: "献立",
    ask: "しばらく作っていないレシピから、今週の夕飯を 3 つ選んで",
    reply: "豚汁（3 週間前）、ぶりのラーメン（1 か月前）、まだ作っていない味噌ミルク煮はどうでしょう。",
    caption: "作った記録をもとに、献立を考えてくれます。",
  },
  {
    label: "振り返り",
    ask: "最近よく買っているものは？",
    reply: "この 1 か月だと、牛乳（4 回）、卵（3 回）、バナナ（3 回）です。",
    caption: "買い物の記録から、よく買うものを教えてくれます。",
  },
];

// What connecting an assistant brings, shown before connecting, with the ways to connect Claude and
// ChatGPT; the connections themselves are listed in the settings.
export function Assistants() {
  const { state } = useSession();
  if (state.status !== "in") return null;
  const { name } = state.me.household;

  return (
    <Page at="settings">
      <section className="hero">
        <p className="eyebrow">アシスタント連携</p>
        <h2 className="hero-title">
          話しかけるだけで、
          <br />
          {name}のリストが動く
        </h2>
        <p className="lead">Claude や ChatGPT とつなぐと、買い物リストや冷蔵庫、レシピを、チャットから見たり書き換えたりできます。</p>
      </section>
      <Shots />
      <Connect name={name} />
      <section aria-labelledby="safe">
        <h2 id="safe">安心して使えるように</h2>
        <ul className="points">
          <li>つなぐときに「閲覧のみ」を選べば、見るだけで書き換えません。</li>
          <li>接続は、設定からいつでも解除できます。</li>
          <li>家族の管理や招待、パスキーには、アシスタントは触れません。</li>
        </ul>
      </section>
    </Page>
  );
}

// A row of cards like an app store's screenshots, swiped through sideways. The conversation is what
// stands out; a sentence under it says what happened.
function Shots() {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <section aria-labelledby="shots">
      <h2 id="shots">こんなふうに頼めます</h2>
      <ul className="plain shots">
        {SHOTS.map(({ label, ask, sent, reply, caption }) => (
          <li key={label} className="shot">
            <p className="shot-label">{label}</p>
            <div className="chat">
              {sent && (
                <p className={`sent ${sent.kind}`}>
                  {sent.kind === "photo" ? <PhotoIcon /> : <LinkIcon />}
                  <span>{sent.label}</span>
                </p>
              )}
              <p className="bubble me">{ask}</p>
              <p className="bubble ai">{reply}</p>
            </div>
            <p className="shot-caption">{caption}</p>
            <button className="quiet" onClick={() => navigator.clipboard?.writeText(ask).then(() => setCopied(ask), () => {})}>
              {copied === ask ? "コピーしました" : "頼み方をコピー"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// `name` is the household's, which the assistants show the connection as. Neither assistant can be
// connected from here in one step: claude.ai opens its dialog filled in, and ChatGPT adds servers
// only in a browser, by hand.
function Connect({ name }: { name: string }) {
  const [guide, setGuide] = useState<"claude" | "chatgpt" | null>(null);
  // The guide gives way to the news once the assistant has connected.
  const done = useNewConnection(guide);
  const open = (which: "claude" | "chatgpt") => setGuide(guide === which ? null : which);
  return (
    <section aria-labelledby="connect">
      <h2 id="connect">つなぐ</h2>
      <div className="connect-choices">
        <button className={guide === "claude" ? "primary" : undefined} aria-expanded={guide === "claude"} onClick={() => open("claude")}>
          Claude とつなぐ
        </button>
        <button className={guide === "chatgpt" ? "primary" : undefined} aria-expanded={guide === "chatgpt"} onClick={() => open("chatgpt")}>
          ChatGPT とつなぐ
        </button>
      </div>
      {done && (
        <div className="invite joined" role="status">
          <p className="joined-title">接続できました！</p>
          <p>
            <strong>{done.clientName}</strong> が、{name}のリストを{accessLabel(done.scopes)}で使えるようになりました。
          </p>
          <FirstAsks name={name} />
        </div>
      )}
      {!done && guide === "claude" && (
        <div className="invite">
          <p>開いた画面で「追加」を押し、続く「接続を許可しますか？」の画面で許可してください。</p>
          <a className="button primary" href={claudeLink(name)} target="_blank" rel="noopener noreferrer">
            Claude の追加画面を開く
          </a>
          <p className="muted">Claude のアプリからは、設定のコネクタで「カスタムコネクタを追加」を選び、名前に「{name}」、URL に次を入れても追加できます。</p>
          <McpUrl />
        </div>
      )}
      {!done && guide === "chatgpt" && (
        <div className="invite">
          <p>ChatGPT のアプリでは追加できません。スマホでもパソコンでも、ブラウザ（Chrome や Safari など）で ChatGPT にログインして進めてください。</p>
          {/* The words in 「」 are ChatGPT's own, as its form shows them. */}
          <ol className="steps">
            <li>
              ChatGPT のプラグインの画面を開く
              <a className="button primary" href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">
                ChatGPT のプラグインを開く
              </a>
              <span className="note">ChatGPT のアプリが開いたら、ブラウザで chatgpt.com/plugins を開き直してください。</span>
            </li>
            <li>右上の「追加」から「カスタム MCP サーバーを追加」を選ぶ</li>
            <li>「名前」に「{name}」と入れる</li>
            <li>
              「接続タイプ」は「サーバーURL」のまま、その下の「https://example.com/mcp」と薄く出ている欄に、次の URL を貼り付ける
              <McpUrl />
            </li>
            <li>「認証」は「OAuth」のまま。「理解したうえで続けます」にチェックして、「プラグインとして作成」を押す</li>
            <li>「{name}に接続」を押し、続く「接続を許可しますか？」の画面で許可する</li>
          </ol>
        </div>
      )}
    </section>
  );
}

// The first things to ask, right after connecting: one that shows it works (the fridge is never
// empty, and reading is allowed even read-only), and one whose answer, steered by the server's
// instructions, suggests what to ask next from the household's own lists. Both name the connection,
// which helps the assistant reach for it.
function FirstAsks({ name }: { name: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const asks = [`${name}の冷蔵庫に何がある？`, `${name}のリストで何ができる？`];
  return (
    <div className="first-asks">
      <p className="joined-sub">まずはこう聞いてみましょう</p>
      <ol className="plain">
        {asks.map((ask) => (
          <li key={ask}>
            <span>「{ask}」</span>
            <button className="quiet" onClick={() => navigator.clipboard?.writeText(ask).then(() => setCopied(ask), () => {})}>
              {copied === ask ? "コピーしました" : "コピー"}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

// While a guide is open, the connection it leads to, once there is one: the connections are looked
// at again every few seconds, and as soon as the page is back in view (from the assistant's tab or
// app), until one that was not there at first shows up. Watching stops after a while.
const WATCH_EVERY = 3000;
const WATCH_FOR = 15 * 60 * 1000;

function useNewConnection(guide: string | null): Connection | null {
  const [added, setAdded] = useState<Connection | null>(null);
  useEffect(() => {
    setAdded(null);
    if (!guide) return;
    let known: Set<string> | null = null;
    let over = false;
    const check = async () => {
      if (over || document.hidden) return;
      try {
        const { connections } = await api.get<{ connections: Connection[] }>("/api/connections");
        if (over) return;
        if (!known) {
          known = new Set(connections.map((c) => c.id));
          return;
        }
        const found = connections.find((c) => !known!.has(c.id));
        if (found) {
          setAdded(found);
          stop();
        }
      } catch {
        // Tried again on the next round.
      }
    };
    const timer = setInterval(check, WATCH_EVERY);
    const limit = setTimeout(() => stop(), WATCH_FOR);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    function stop() {
      over = true;
      clearInterval(timer);
      clearTimeout(limit);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    }
    void check();
    return stop;
  }, [guide]);
  return added;
}

// The address to give the assistant, as text to copy rather than a field or a link, so it is not
// opened in the browser by mistake.
function McpUrl() {
  const [copied, setCopied] = useState(false);
  return (
    <span className="mcp-url">
      <code aria-label="接続先の URL">{mcpUrl()}</code>
      <button onClick={() => navigator.clipboard?.writeText(mcpUrl()).then(() => setCopied(true), () => {})}>{copied ? "コピーしました" : "URL をコピー"}</button>
    </span>
  );
}
