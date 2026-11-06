import { useState } from "react";
import { useSession } from "../session";
import { Page } from "../ui";

// Where an assistant connects: the MCP endpoint at the address the app is open at.
const mcpUrl = () => `${window.location.origin}/mcp`;
// claude.ai's link to its "add custom connector" dialog, filled in; the person still confirms there.
const claudeLink = (name: string) => `https://claude.ai/customize/connectors?${new URLSearchParams({ modal: "add-custom-connector", connectorName: name, connectorUrl: mcpUrl() })}`;

// What a connected assistant can be asked, each as a short conversation: having connected one does
// not tell what it can do. `with` is what goes along with the words (a photo, a link); the replies
// are made up, to show the kind of answer.
const SHOTS: { label: string; title: string; ask: string; with?: string; reply: string }[] = [
  {
    label: "写真から",
    title: "レシートを送るだけで、冷蔵庫へ",
    ask: "買ったものを冷蔵庫に入れて",
    with: "レシートの写真",
    reply: "牛乳、卵、豆腐、長ねぎを冷蔵庫に入れました。",
  },
  {
    label: "買い足し",
    title: "冷蔵庫と見比べて、足りない分だけ",
    ask: "肉じゃがの材料のうち、冷蔵庫にないものを買い物リストに入れて",
    reply: "じゃがいもと玉ねぎは冷蔵庫にあったので、牛肉としらたきを買い物リストに入れました。",
  },
  {
    label: "レシピ",
    title: "気になったレシピを、URL でそのまま",
    ask: "このレシピを登録して",
    with: "レシピのページの URL",
    reply: "「鶏もも肉と白菜の味噌ミルク煮」を、主菜・煮込みのタグで登録しました。",
  },
  {
    label: "献立",
    title: "作った記録から、今週の献立",
    ask: "しばらく作っていないレシピから、今週の夕飯を 3 つ選んで",
    reply: "豚汁（3 週間前）、ぶりのラーメン（1 か月前）、まだ作っていない味噌ミルク煮はどうでしょう。",
  },
  {
    label: "振り返り",
    title: "よく買うものも、すぐわかる",
    ask: "最近よく買っているものは？",
    reply: "この 1 か月だと、牛乳（4 回）、卵（3 回）、バナナ（3 回）です。",
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

// A row of cards like an app store's screenshots, swiped through sideways.
function Shots() {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <section aria-labelledby="shots">
      <h2 id="shots">こんなふうに頼めます</h2>
      <ul className="plain shots">
        {SHOTS.map(({ label, title, ask, with: along, reply }) => (
          <li key={label} className="shot">
            <p className="shot-label">{label}</p>
            <h3>{title}</h3>
            <div className="chat">
              <p className="bubble me">
                {along && <span className="attached">{along}</span>}
                {ask}
              </p>
              <p className="bubble ai">{reply}</p>
            </div>
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
  return (
    <section aria-labelledby="connect">
      <h2 id="connect">つなぐ</h2>
      <div className="connect-choices">
        <button className={guide === "claude" ? "primary" : undefined} aria-expanded={guide === "claude"} onClick={() => setGuide(guide === "claude" ? null : "claude")}>
          Claude とつなぐ
        </button>
        <button className={guide === "chatgpt" ? "primary" : undefined} aria-expanded={guide === "chatgpt"} onClick={() => setGuide(guide === "chatgpt" ? null : "chatgpt")}>
          ChatGPT とつなぐ
        </button>
      </div>
      {guide === "claude" && (
        <div className="invite">
          <p>開いた画面で「追加」を押し、続く「接続を許可しますか？」の画面で許可してください。</p>
          <a className="button primary" href={claudeLink(name)} target="_blank" rel="noopener noreferrer">
            Claude の追加画面を開く
          </a>
          <p className="muted">Claude のアプリからは、設定のコネクタで「カスタムコネクタを追加」を選び、名前に「{name}」、URL に次を入れても追加できます。</p>
          <McpUrl />
        </div>
      )}
      {guide === "chatgpt" && (
        <div className="invite">
          <p>ChatGPT のアプリでは追加できません。Safari などのブラウザで ChatGPT にログインして進めてください。</p>
          <ol className="steps">
            <li>下のボタンで ChatGPT のプラグインの画面を開く（アプリが開いたら、ブラウザで chatgpt.com を開き直す）</li>
            <li>右上の「追加」から「カスタム MCP サーバーを追加」を選ぶ</li>
            <li>名前に「{name}」、サーバー URL に下の URL を入れる（認証は OAuth のまま）</li>
            <li>「理解したうえで続けます」にチェックして、「プラグインとして作成」を押す</li>
            <li>「{name}に接続」を押し、続く「接続を許可しますか？」の画面で許可する</li>
          </ol>
          <McpUrl />
          <a className="button" href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">
            ChatGPT を開く
          </a>
        </div>
      )}
    </section>
  );
}

function McpUrl() {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <input readOnly value={mcpUrl()} aria-label="接続先の URL" onFocus={(e) => e.currentTarget.select()} />
      <button onClick={() => navigator.clipboard?.writeText(mcpUrl()).then(() => setCopied(true), () => {})}>{copied ? "コピーしました" : "URL をコピー"}</button>
    </>
  );
}
