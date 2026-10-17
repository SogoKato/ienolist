# 設計メモ

世帯向けの冷蔵庫リスト + 買い物リストの Web アプリ。エージェントは内蔵せず、利用者が自分の Claude などからリモート MCP で読み書きする。アプリはデータの置き場に徹する。

プロトタイプ（`legacy/`）での実際の使われ方が出発点になっている。

- 一番使われているのは冷蔵庫リスト。目的は買い足しの防止と、家族間の共有（家にいる人が更新し、外出中の人がスーパーで見る）。
- 期限と数量は管理していない。
- 内蔵エージェントの「何が作れるか」の提案は合わずに使われなくなった。Claude + MCP で良くなるかは仮説。
- レシピ本文を保管する必要があるかは未検証。

## 方針

| 項目 | 決定 |
|---|---|
| 対象 | 技術者が自分の世帯用にデプロイする（セルフホスト） |
| ライセンス | MIT |
| 言語・基盤 | TypeScript、Hono、Vite + React の PWA、Drizzle + SQLite |
| 配備 | 第一は Cloudflare（Workers + D1、Free 枠で収まること）、第二は Docker + SQLite |
| 認証 | パスキーのみ。パスワードは持たない |
| MCP 認証 | アプリ自身が OAuth 認可サーバー（DCR、PKCE）。外部 IdP は使わない |
| MCP ツール | RESTful な粒度（リソースごとの list / get / create / update / delete） |

### Cloudflare Free に収める根拠（スパイクの実測）

- 公式 MCP SDK（zod + ajv）はバンドル 1.5 MiB で、アイドル後の最初の呼び出しが 20〜50 ms CPU かかり、上限の 10 ms を超えた。自前の薄いハンドラー（zod/mini、`tools/list` はビルド時に JSON 生成）にすると、バンドル 205 KiB、アイドル後でも中央値 3 ms、95 パーセンタイル 9 ms になった。
- 認可サーバー（約 385 行）も実機で、`/oauth/register` 3〜8 ms、`/oauth/authorize` 2〜6 ms、`/oauth/token` 5〜13 ms（初回のみ 13 ms）、`/mcp` 2〜12 ms。
- そのため、MCP SDK は使わず、`zod/mini` の自前実装を使う。

## 認証

### 利用者のログイン（PWA）

- WebAuthn のパスキーのみ。利用者ごとに複数のパスキーを登録できる。検証には `@simplewebauthn/server` を使う。
- パスキーは発見可能な資格情報（ログイン時にユーザー名を聞かない）で、端末でのユーザー確認（生体認証や PIN）を必須にする。アテステーションは求めない。
- 認証の途中経過（チャレンジ）は DB に保存し、5 分で失効、1 回使うと消える。最初の管理者の世帯名や、招待の内容は、チャレンジに紐づけてサーバー側で持つ。
- セッションは Cookie（トークンはハッシュで保存）。有効期間は 30 日。最後のパスキーは削除できない。

### 初回と家族の追加

1. **最初の管理者**: 最初にセットアップ画面を完了した人が管理者になる。競合は `app_meta` の一意キーで防ぐ（先に挿入できた方だけが成功）。任意のシークレット `SETUP_TOKEN` が設定されていれば、セットアップ画面でその入力を必須にする。未設定なら「最初のアクセス者が管理者」。
2. **家族の追加**: 管理者が招待リンクを発行し（有効期間 7 日、1 回限り、DB にはハッシュで保存）、本人の端末でパスキーを登録する。
3. **使えるパスキーを全て失った時**（他の端末のパスキーが残っていれば、その端末でログインして追加・削除するだけでよい）: 管理者が、その利用者向けの再登録リンクを発行する（`invites.user_id` を指定）。リンクを使っても利用者は同じ人のまま（ID、履歴、役割は変わらない）で、その利用者の既存のパスキー、セッション、MCP のトークンはすべて失効し、新しいパスキーだけが残る（紛失した端末で入れないようにするため）。管理者自身が全てのパスキーを失った場合は、運用者がコマンドで再登録リンクを発行する。
4. 先に他人が管理者になってしまった場合の復旧は、DB の `users` 系テーブルを空にして、やり直す（README に手順を書く）。再デプロイだけでは D1 のデータは消えない。

### Web API（PWA 向け）

- 設定は環境変数 `PUBLIC_URL`（必須。パスなしのオリジン。https のみ、localhost は http も可）、`SETUP_TOKEN`（任意）、`APP_NAME`（任意）。RP ID とオリジンは `PUBLIC_URL` から導き、`Host` ヘッダーは信用しない。
- セッション Cookie: `HttpOnly`、`SameSite=Lax`（claude.ai から同意画面へのリンクで Cookie が付くように。Strict は使えない）、https では `Secure` と `__Host-` 接頭辞。localhost の http では接頭辞と `Secure` を外す。
- CSRF: 状態を変える要求（GET/HEAD/OPTIONS 以外）は `Origin` が `PUBLIC_URL` と完全に一致しなければ 403。本文は `application/json` のみ（クロスサイトのフォームでは送れない）。
- 全レスポンスに `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`frame-ancestors 'none'`、`Referrer-Policy: same-origin`。`/api` は `Cache-Control: no-store`。
- エラーは `{ "error": "…" }` で、`invalid`→400、`unauthorized`→401、`forbidden`→403、`not_found`→404、`conflict`→409。想定外の例外は 500 の「Internal error」のみで、詳細はログに出す。
- レート制限は未実装。パスキーには推測できる秘密がないが、`/api/login/options` などの乱用対策は、デプロイ先（Cloudflare のレート制限など）に任せる想定。

### MCP の認可（OAuth 2.1）

- メタデータ: RFC 8414（認可サーバー）と RFC 9728（保護リソース）。`resource` パラメータ（RFC 8707）は、このアプリの `/mcp` のみ許可する。
- クライアント登録: DCR（RFC 7591）。公開クライアントのみ（PKCE S256 必須、client secret なし）。事前登録のクライアントは設定で持てるようにする。CIMD は、クライアント側の対応が確認できるまで保留する。
- 認可コードは 1 回限り、保存はハッシュ、有効期限は 5 分。
- アクセストークン（1 時間）とリフレッシュトークン（30 日、回転）は不透明な文字列で、DB にはハッシュで保存する。
- スコープは `items:read` と `items:write` の 2 つ。`items:write` に作成、更新、削除、移動を含める。冷蔵庫や買い物リストの削除は日常の操作であり、承認の要否は、Claude 側のツール単位の設定に任せる。
- リダイレクト URI は https か、ループバックの http（`localhost`、`127.0.0.1`、`[::1]`）のみで、フラグメント不可。登録されたものと完全一致を要求する。クライアントやリダイレクト URI の誤りには、リダイレクトせずエラーを表示する。それ以外の誤りは、`error`、`state`、`iss`（RFC 9207）を付けてクライアントへ返す。
- 認可の流れ: クライアントが `GET /oauth/authorize` へ飛ばす → 検証して `/authorize?<同じクエリ>`（PWA の同意画面）へ 302 → 未ログインならパスキーでログイン → 同意画面が `GET /api/oauth/authorization` で内容を取得し、`POST /api/oauth/authorize`（`decision: allow | deny`）の結果の `redirectTo` へ遷移する。同意の POST は Cookie 認証の Web API なので、同一オリジン検査（CSRF 対策）が効く。
- 同意画面は、クライアント名と、リダイレクト先のホストを表示する（名前は自己申告のため）。許可するスコープは、要求されたものの全部か、全て拒否かの二択。
- 設定画面に、接続中のセッション一覧と取り消しを置く（`GET /api/connections`、`DELETE /api/connections/:id`。自分の接続のみ）。取り消すと、そのクライアントのアクセストークンとリフレッシュトークンが即座に無効になる。
- DCR は認証なしで登録できるため、登録数に上限（100）を設ける。トークンを一度も発行されなかったクライアントは 7 日後に消し、上限に達した時は、その中で最も古いものを消して空ける。全てが使用中なら登録を断る。Claude は接続のたびに `register` を 2 回呼ぶ。
- リフレッシュは同じ行のハッシュを回転させる（同時の 2 回目は失敗する）。盗まれたトークンの再利用検知（古いリフレッシュトークンの再提示で全体を失効させる）は行わない。
- CORS: メタデータ、`/oauth/register`、`/oauth/token`、`/oauth/revoke`、`/mcp` は任意のオリジンから呼べる（Cookie を使わないため）。`/oauth/authorize` と `/api` は同一オリジンのみ。
- 事前登録のクライアントは `createOAuthService` の `clients` で渡す（使われた時に DB へ反映される）。環境変数からの読み込みは、エントリポイントを作る時に足す。

### Web UI（PWA）

- `web/`: Vite + React + wouter。ビルドは `pnpm build`（出力は `dist/web`）。開発は `pnpm start`（API。`PUBLIC_URL=http://localhost:5173`）と `pnpm dev:web`（`:5173`、API へプロキシ）。パスキーはブラウザから見えるオリジンに結びつくため、この組み合わせにする。
- 画面: セットアップ（`/setup`）、招待・再登録（`/join/:token`）、ログイン（`/login`）、リスト（`/`）、設定（`/settings`）、接続の同意（`/authorize`）。未ログインで開くと `/login?next=…` へ送り、ログイン後に戻す（`next` は同一サイトのパスのみ）。
- リスト: 買い物と冷蔵庫のタブ。チェックは状態の切り替えだけで、リスト間は動かさない（動かすのは、項目のメニューか「まとめて…へ移す」）。チェックは即座に反映し、失敗したら再読み込みで戻す。20 秒ごと、および画面に戻った時に再読み込みして、他の端末やアシスタントの変更を反映する。
- 設定: 接続中のアシスタントの一覧と解除、自分のパスキーの追加・削除、家族の一覧、招待リンクの作成（管理者）、メンバーのパスキー再登録リンク（管理者）、ログアウト。
- 同意画面: クライアント名、戻り先のホスト、許可する内容を表示する。名前は自己申告であることも書く。
- PWA: マニフェスト、アイコン（`scripts/make-icons.ts` で生成）、Service Worker（アプリ本体のみキャッシュ。`/api`、`/oauth`、`/mcp` は常にネットワーク）。リストのオフライン閲覧と書き込みは未対応。
- 静的ファイルの配信: Node 版は `src/http/static.ts`（SPA のフォールバックつき。`WEB_DIR` で場所を変更）。Workers 版は静的アセット（`not_found_handling: single-page-application`、API は `run_worker_first`）。どちらも CSP などのヘッダーを付ける（Workers 版は `web/public/_headers`）。
- 文言は日本語のみで、コンポーネントに直接書いてある。多言語化は未対応（OSS 公開時の言語の方針は未決）。

### 実行とデプロイ

- エントリポイントは 2 つ。`src/worker.ts`（Cloudflare Workers + D1）と `src/node.ts`（Node + SQLite ファイル。`pnpm start`）。どちらも `src/main.ts` の `buildApp(db, env)` でサービスをつなぐ。
- 設定: `PUBLIC_URL`（必須）、`SETUP_TOKEN`、`APP_NAME`、`OAUTH_CLIENTS`（事前登録クライアントの JSON 配列 `[{clientId, name, redirectUris}]`）。Node ではさらに `DATABASE_PATH`（既定 `./data/app.db`）と `PORT`（既定 8787）。Workers では vars / secrets。ローカルの Workers は `.dev.vars`。
- スキーマは `drizzle/` の SQL。Node は起動時に未適用分を適用する（`_migrations` で記録）。D1 は `wrangler d1 migrations apply DB --local|--remote`。
- ローカルの Workers: `.dev.vars` に `PUBLIC_URL=http://localhost:8787` → `wrangler d1 migrations apply DB --local` → `pnpm dev`。
- `pnpm e2e`: 実際の HTTP で、セットアップ（ソフトウェアのパスキー）→ クライアント登録 → 同意 → トークン → MCP 操作 → リフレッシュ → 接続の取り消しまでを通す。引数なしだと Node 版を一時 DB で起動して検査する。`BASE_URL=http://localhost:8787 pnpm e2e` で、起動済みの `wrangler dev` などを検査する（その `PUBLIC_URL` は同じ URL で、世帯が未作成であること）。
- 確認済み: Node 版、`wrangler dev --local`（workerd + ローカル D1）、実際の Cloudflare（workers.dev、D1）の 3 つで `pnpm e2e` が通る。`nodejs_compat` は不要。Worker の起動時間は 19 ms。
- 実機の CPU 時間（2026-10-17、Free プラン、`wrangler tail` の `cpuTime`、`scripts/measure.ts` で 20 ラウンドを間隔 0.4 秒で実行した 173 件）。単位は ms:

  | 要求 | p50 | p90 | 最大 | 10 超 |
  |---|---|---|---|---|
  | `POST /mcp`（tools/call） | 4 | 6 | 10 | 0/18 |
  | `POST /oauth/token` | 4 | 5 | 9 | 0/38 |
  | `POST /oauth/register` | 7 | 10 | 12 | 1/20 |
  | `POST /api/logout` | 5 | 8 | 13 | 1/20 |
  | `POST /api/login/options` | 3 | 6 | 10 | 0/15 |
  | `POST /api/login/finish`（パスキー検証） | 9 | 11 | 20 | 3/20 |
  | `POST /api/oauth/authorize`（同意） | 11 | 15 | 15 | 13/20 |
  | `GET /api/items`（セッション認証 + 一覧） | 10 | 14 | 15 | 9/20 |
  | `POST /api/setup/finish`（登録検証、1 回） | 15 | | | |
  | `POST /api/setup/options`（コールドスタート直後、1 回） | 43 | | | |

  - 173 件中 28 件が 10 ms を超えたが、全て `outcome: ok` で、CPU 超過のエラーは出なかった。Free プランの 10 ms は、この範囲では打ち切りに使われていない（保証はない。設計は余裕のある側に倒しておく）。
  - 意外な点: 単純な `GET /api/items`（セッション認証と一覧）が p50 10 ms で、MCP の `tools/call`（4 ms）より重い。認証の問い合わせ（セッション → 世帯・利用者の結合）に原因がありそう。最適化の候補（未調査）。
  - 同意（`/api/oauth/authorize`）はセッション認証 + クライアント参照 + コード発行で、同じ理由で重い。
  - 原因（2026-10-17 に判明）: 認証のミドルウェアが `GET /items` で 2 回動いていた（Hono の `/items/*` は `/items` にも一致するため、`/items` との両方に付けていた）。セッション認証も 2 問い合わせ（セッション → 人物）だった。同意はクリーンアップが 3 回の別往復だった。
  - 対応: ミドルウェアを 1 回に、セッション認証を結合 1 問い合わせに、同意のクリーンアップとコード発行を 1 回の `batch` にした。`GET /api/items` は 5 → 2 文、同意は約 8 → 約 5 文。D1 は 1 往復ごとに CPU を使うので、`src/http/cost.test.ts` が代表的な要求の文数を固定している（増えたらテストが落ちる）。
  - 修正後の実機の数値は未測定。

## データモデル

世帯ごとに完全に分離する。全ての業務テーブルに `household_id` を持つ。ID は ULID（26 文字、時刻順に並ぶ）。時刻は Unix 秒の整数。

### アイテム（`items`）

| 列 | 内容 |
|---|---|
| `id` | ULID |
| `household_id` | 世帯 |
| `list` | `shopping` または `fridge` |
| `status` | リストごとの状態名（下表） |
| `name` | 品名（1〜500 文字） |
| `note` | 自由テキスト（任意）。レシピ名や URL の一言メモは、ここから始める |
| `added_by` | 追加した利用者 |
| `created_at`, `updated_at` | 時刻 |

プロトタイプの `checked`（リストごとに意味が変わる真偽値）はやめて、状態名にする。`(list, status)` の組み合わせは CHECK 制約で縛る。

| list | status | 意味 |
|---|---|---|
| `shopping` | `to_buy` | 買う物 |
| `shopping` | `bought` | 買った（スーパーで、残りと見分けるために残す） |
| `fridge` | `in_stock` | 在庫あり |
| `fridge` | `used_up` | 使い切り |

### 状態の変更と移動

- **状態の変更はリストを移動しない。** 買い物でチェックしても冷蔵庫には入らない。使い切りにしても買い物リストには出ない。
- リスト間の移動は、明示の操作（`move_item`）だけ。同じ行の `list` と `status` を変えるので、履歴は引き継がれる。移動先の状態は、買い物へは `to_buy`、冷蔵庫へは `in_stock`。
- 数量と期限は持たない。

### 変更履歴（`item_events`）

追記専用。仮説検証（繰り返し買う物、調理の頻度）と、Claude が「何をよく買い足すか」を提案する材料にする。アイテムが削除されても残すので、`item_id` に外部キーは付けず、品名のスナップショットを持つ。

- `type`: `created`、`renamed`、`status_changed`、`note_changed`、`moved`、`deleted`
- `data`: 変更の内容（JSON。例: `{"from":"in_stock","to":"used_up"}`）
- `source`: `web` または `mcp`、`client_id`（MCP のとき）

### 世帯と認証

`households`、`users`、`memberships`（役割は `admin` / `member`。多対多にしておき、最初の UI は 1 利用者 1 世帯）、`passkeys`、`sessions`、`invites`、`challenges`（WebAuthn のチャレンジ）、`app_meta`、`oauth_clients`、`oauth_codes`、`oauth_tokens`。詳しくは `src/db/schema.ts`。

## MCP ツール

最新の仕様（2026-07-28: セッションなし、リクエストごとの `_meta` とヘッダーの照合、`server/discover`）と、旧版（`initialize` を受けるがセッションは発行しない）の両方に対応する。実機の claude.ai は最新の仕様で接続した。

| ツール | 内容 | スコープ |
|---|---|---|
| `list_items` | リストと状態で絞り込んで一覧 | `items:read` |
| `get_item` | 1 件取得 | `items:read` |
| `create_item` | 追加（初期状態は `to_buy` / `in_stock`） | `items:write` |
| `update_item` | 品名、状態、メモの更新 | `items:write` |
| `delete_item` | 削除 | `items:write` |
| `move_item` | 別のリストへ移動 | `items:write` |
| `list_events` | 変更履歴の取得 | `items:read` |

`tools/list` の中身は、ビルド時に JSON へ直列化しておく（`pnpm gen` で `src/mcp/tools.generated.ts` を作り直す。ツールを変えて生成し忘れると、テストが失敗する）。実行時に zod のスキーマを変換すると、アイソレートの最初の 1 回に 3〜10 ms の CPU がかかり、Workers Free の 10 ms の大半を使うため。説明文には、状態名の意味と「状態の変更は移動しない」ことを書く。読み取り専用のツールには `readOnlyHint` を付け、削除には `destructiveHint` を付ける。

## テスト方針

- **モックはほとんど使わない。** 自前のコード（サービス、認証、OAuth）は本物を使う。
- **単体テストでは、DB のモックを認める。** 結合テストでは DB も本物を使う（実際の SQLite〔`node:sqlite`〕に本物のマイグレーションを当てる）。DB を使う処理は制約やトランザクションの挙動が結果を左右するので、本物を使う結合テストで確かめる。
- DB 以外でモックを認めるのは、どうしても必要な外部依存だけ（例: 外部のネットワーク、ブラウザの認証器）。使うときは、なぜ必要かをテストの近くにコメントで書く。
- 時刻と ID の生成は、モックではなく注入する引数（`now`、`newId`）で固定する。
- 層ごとの役割:
  - 単体: 純粋なロジック（ハッシュ、PKCE、`redirect_uri` の照合、スコープの絞り込み）。
  - 結合: Hono のアプリを `app.request()` で呼び、実際の SQLite をつなぐ。OAuth の流れ、世帯の分離、最初の管理者の競合を確認する。
  - E2E（HTTP）: `pnpm e2e`。MCP の流れ（DCR から `tools/call` まで）を HTTP 越しに通す。
  - E2E（ブラウザ）: `pnpm test:browser`。Playwright と Chrome の仮想認証器で、セットアップ、リスト操作、ログアウトと再ログイン、招待、アシスタントの接続（同意、トークン、MCP、解除）、インストール要素を本物のブラウザで通す。ビルド済みのアプリと Node 版を、使い捨ての DB で起動する。
  - 実際の claude.ai との接続確認は手で行う。
- D1 固有の挙動（`batch`、外部キー、CPU 10 ms）は、D1 向けの `wrangler dev` と実機の計測で確認する。

## 未決事項

- アイテムの並び順: 手動の並べ替えが必要か（プロトタイプは `sort_order` を持っていたが、実際の使われ方は不明）。当面は作成順。
- プロダクト名（リポジトリ名は仮）。
- README とドキュメントの言語。
- ChatGPT など、DCR のみ対応のクライアントでの動作確認（コード上は DCR に対応）。
- レシピの保管: 段階的に検証する（0: 既存の記録から繰り返し調理率を測る、1: アイテムに名前と URL のメモ、2: 自由テキストのメモ、3: 構造化）。外部レシピの取り込みは、出典リンク必須、個人利用、サーバー側で取得しない設計とする。
- CIMD への対応。
