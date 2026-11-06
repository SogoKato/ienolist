import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";

// One household's story, in order, in a real browser: the first person sets up, uses the lists,
// signs out and in with the passkey, invites a family member, and connects an assistant.
test.describe.configure({ mode: "serial" });

// A browser profile with a software passkey in it (Chrome's virtual authenticator).
async function person(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { context, page };
}

// A finger dragging down from the top of the page and letting go. The session is left open:
// detaching it also took the page's virtual passkey away.
async function pullDown(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y?: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: y === undefined ? [] : [{ x: 200, y }] });
  await touch("touchStart", 200);
  for (let y = 220; y <= 400; y += 20) await touch("touchMove", y);
  await touch("touchEnd");
}

let aki: Page;
let ben: Page;
let inviteUrl = "";

const addItem = async (page: Page, placeholder: string, name: string) => {
  await page.getByLabel(placeholder).fill(name);
  await page.getByRole("button", { name: "追加", exact: true }).click();
};

test("the first visitor is sent to set the app up, and ends up signed in with a passkey", async ({ browser }) => {
  ({ page: aki } = await person(browser));
  await aki.goto("/");
  await expect(aki).toHaveURL(/\/setup$/);
  await aki.getByLabel("あなたの名前").fill("Aki");
  await aki.getByLabel("家の名前").fill("我が家");
  await aki.getByRole("button", { name: "パスキーを作って始める" }).click();
  await expect(aki.getByRole("heading", { name: "家のリスト" })).toBeVisible();
  await expect(aki).toHaveURL(/\/$/);
});

test("items can be added, ticked off and moved to the fridge, and they stay after a reload", async () => {
  await addItem(aki, "買うものを追加", "牛乳");
  await addItem(aki, "買うものを追加", "卵");
  await expect(aki.getByText("牛乳")).toBeVisible();
  await aki.getByLabel("牛乳 を買った").check();
  await expect(aki.getByRole("region", { name: "買った" }).getByText("牛乳")).toBeVisible();

  await aki.reload();
  await expect(aki.getByRole("region", { name: "買った" }).getByText("牛乳")).toBeVisible();
  await expect(aki.getByLabel("卵 を買った")).not.toBeChecked();

  await aki.getByRole("button", { name: "まとめて冷蔵庫へ移す" }).click();
  await expect(aki.getByRole("region", { name: "買った" })).toHaveCount(0);
  await aki.getByRole("tab", { name: /冷蔵庫/ }).click();
  await expect(aki.getByText("牛乳")).toBeVisible();
  await expect(aki.getByText("卵")).toHaveCount(0);
});

test("an item can be edited, moved back with the ticked ones and deleted", async () => {
  await addItem(aki, "冷蔵庫にあるものを追加", "ヨーグルト");
  await aki.getByRole("button", { name: "ヨーグルト を編集" }).click();
  await aki.getByLabel("メモ").fill("プレーン");
  await aki.getByRole("button", { name: "保存" }).click();
  await expect(aki.getByText("プレーン")).toBeVisible();

  await aki.getByLabel("ヨーグルト を使い切った").check();
  await expect(aki.getByRole("region", { name: "使い切った" }).getByText("ヨーグルト")).toBeVisible();
  await aki.getByRole("button", { name: "まとめて買い物リストへ移す" }).click();
  await expect(aki.getByText("ヨーグルト")).toHaveCount(0);
  await aki.getByRole("tab", { name: /買い物/ }).click();
  await expect(aki.getByText("ヨーグルト")).toBeVisible();

  await aki.getByRole("button", { name: "ヨーグルト を削除" }).click();
  await expect(aki.getByText("ヨーグルト")).toHaveCount(0);
});

test("signing out and back in with the passkey brings the lists back", async () => {
  await aki.getByRole("link", { name: "設定" }).click();
  await expect(aki.getByRole("heading", { name: "パスキー" })).toBeVisible();
  await aki.getByRole("button", { name: "ログアウト" }).click();
  await expect(aki).toHaveURL(/\/login$/);

  // A page that needs sign-in sends people to the login, and back afterwards.
  await aki.goto("/settings");
  await expect(aki).toHaveURL(/\/login\?next=%2Fsettings$/);
  await aki.getByRole("button", { name: "パスキーでログイン" }).click();
  await expect(aki).toHaveURL(/\/settings$/);
  await aki.getByRole("link", { name: "戻る" }).click();
  await expect(aki).toHaveURL(/\/$/);
  await aki.getByRole("tab", { name: /冷蔵庫/ }).click();
  await expect(aki.getByText("牛乳")).toBeVisible();
});

test("an invited family member joins on their own device and sees the same lists", async ({ browser }) => {
  await aki.getByRole("link", { name: "設定" }).click();
  await aki.getByRole("button", { name: "家族を招待するリンクを作る" }).click();
  inviteUrl = await aki.getByLabel("リンク").inputValue();
  expect(inviteUrl).toMatch(/\/join\/[A-Za-z0-9_-]+$/);

  ({ page: ben } = await person(browser));
  await ben.goto(inviteUrl);
  await expect(ben.getByRole("heading", { name: "我が家 に参加" })).toBeVisible();
  await ben.getByLabel("あなたの名前").fill("Ben");
  await ben.getByRole("button", { name: "パスキーを作る" }).click();
  await expect(ben.getByRole("heading", { name: "家のリスト" })).toBeVisible();
  await ben.getByRole("tab", { name: /冷蔵庫/ }).click();
  await expect(ben.getByText("牛乳")).toBeVisible();

  // The link works once.
  await ben.goto(inviteUrl);
  await expect(ben.getByRole("heading", { name: "招待リンクが無効です" })).toBeVisible();

  await aki.reload();
  await expect(aki.getByText("Ben")).toBeVisible();
  await expect(aki.getByRole("button", { name: "パスキー再登録のリンク" })).toHaveCount(1);
});

test("a change made on one device shows on the other after a tap on the current tab or a pull", async () => {
  // The settings were opened from the fridge tab, so going back returns there.
  await aki.getByRole("link", { name: "戻る" }).click();
  await expect(aki).toHaveURL(/\/\?list=fridge$/);
  await aki.getByRole("tab", { name: /買い物/ }).click();
  await expect(aki.getByText("読み込み中…")).toHaveCount(0);
  await ben.goto("/");
  await ben.getByRole("tab", { name: /買い物/ }).click();
  await addItem(ben, "買うものを追加", "パン");
  await expect(aki.getByText("パン")).toHaveCount(0);
  await aki.getByRole("tab", { name: /買い物/ }).click();
  await expect(aki.getByText("パン")).toBeVisible();
  await expect(aki).toHaveURL(/\/$/);

  await addItem(ben, "買うものを追加", "バター");
  await pullDown(aki);
  await expect(aki.getByText("バター")).toBeVisible();
});

test("a recipe is added with a link and notes, found by an ingredient, cooked today, and edited", async () => {
  await aki.goto("/");
  await aki.getByRole("tab", { name: "レシピ" }).click();
  await expect(aki).toHaveURL(/\/recipes$/);
  await expect(aki.getByText("まだレシピがありません。")).toBeVisible();

  await aki.getByRole("link", { name: "追加", exact: true }).click();
  await aki.getByLabel("料理名").fill("チキンカレー");
  await aki.getByLabel("レシピの URL（任意）").fill("https://example.com/curry");
  await aki.getByLabel(/^メモ/).fill("鶏もも肉 300g\n玉ねぎ 2個\nルーは半分");
  await aki.getByRole("button", { name: "追加", exact: true }).click();

  await expect(aki.getByRole("heading", { name: "チキンカレー" })).toBeVisible();
  await expect(aki.getByRole("link", { name: /example\.com で開く/ })).toHaveAttribute("href", "https://example.com/curry");
  await expect(aki.getByText("ルーは半分")).toBeVisible();
  await aki.getByLabel("作った記録のひとこと").fill("辛口にした");
  await aki.getByRole("button", { name: "作った", exact: true }).click();
  const today = new Date();
  await expect(aki.getByRole("region", { name: "作った記録" }).getByText(`${today.getMonth() + 1}/${today.getDate()}`)).toBeVisible();
  await expect(aki.getByRole("region", { name: "作った記録" }).getByText("辛口にした")).toBeVisible();

  await aki.getByRole("button", { name: "編集" }).click();
  await aki.getByLabel("料理名").fill("バターチキンカレー");
  await aki.getByRole("button", { name: "保存" }).click();
  await expect(aki.getByRole("heading", { name: "バターチキンカレー" })).toBeVisible();

  await aki.getByRole("link", { name: "戻る" }).click();
  await aki.getByLabel("レシピを探す").fill("玉ねぎ");
  await expect(aki.getByRole("link", { name: /バターチキンカレー.*1回/ })).toBeVisible();
  await aki.getByLabel("レシピを探す").fill("豚肉");
  await expect(aki.getByText("見つかりませんでした。")).toBeVisible();

  // The list tabs still work from here, and keep their place in the address.
  await aki.getByRole("tab", { name: /冷蔵庫/ }).click();
  await expect(aki).toHaveURL(/\/\?list=fridge$/);
  await expect(aki.getByText("牛乳")).toBeVisible();
  await aki.reload();
  await expect(aki.getByRole("tab", { name: /冷蔵庫/ })).toHaveAttribute("aria-selected", "true");
});

test("recipes from a book carry its page and tags, and the collection filters by tag and book", async () => {
  await aki.goto("/recipes/new");
  await aki.getByLabel("料理名").fill("唐揚げ");
  await aki.getByLabel("本・冊子（任意）").fill("茅乃舎 レシピ冊子");
  await aki.getByLabel("ページ").fill("12");
  await aki.getByLabel(/^タグ/).fill("主菜 揚げ物");
  await aki.getByRole("button", { name: "追加", exact: true }).click();
  await expect(aki.getByRole("heading", { name: "唐揚げ" })).toBeVisible();
  await expect(aki.getByText("p.12")).toBeVisible();

  // The second one reuses the book and a tag by picking them, not by retyping.
  await aki.goto("/recipes/new");
  await aki.getByLabel("料理名").fill("ラタトゥイユ");
  await aki.getByLabel("本・冊子（任意）").fill("茅乃舎 レシピ冊子");
  await aki.getByRole("group", { name: "使っているタグ" }).getByRole("button", { name: "主菜" }).click();
  await expect(aki.getByLabel(/^タグ/)).toHaveValue("主菜");
  await aki.getByRole("group", { name: "使っているタグ" }).getByRole("button", { name: "主菜" }).click();
  await aki.getByLabel(/^タグ/).fill("副菜、作り置き");
  await aki.getByRole("button", { name: "追加", exact: true }).click();
  await expect(aki.getByRole("heading", { name: "ラタトゥイユ" })).toBeVisible();

  // A tag on the recipe leads to the collection filtered by it.
  await aki.getByRole("link", { name: "作り置き" }).click();
  await expect(aki).toHaveURL(/\/recipes\?tag=/);
  const list = aki.getByRole("list").filter({ has: aki.getByRole("link") });
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list.getByRole("link", { name: /ラタトゥイユ/ })).toBeVisible();

  const tags = aki.getByRole("group", { name: "タグで絞る" });
  await tags.getByRole("button", { name: "作り置き" }).click();
  await expect(list.getByRole("link")).toHaveCount(3);
  await aki.getByLabel("本で絞る").selectOption({ label: "茅乃舎 レシピ冊子（2）" });
  await expect(list.getByRole("link")).toHaveCount(2);
  await tags.getByRole("button", { name: "主菜" }).click();
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list.getByRole("link", { name: /唐揚げ.*『茅乃舎 レシピ冊子』 p\.12/ })).toBeVisible();
  await aki.reload();
  await expect(tags.getByRole("button", { name: "主菜" })).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByRole("link")).toHaveCount(1);

  // Back from a recipe is back to the list as it was filtered.
  await list.getByRole("link", { name: /唐揚げ/ }).click();
  await expect(aki.getByRole("heading", { name: "唐揚げ" })).toBeVisible();
  await aki.getByRole("link", { name: "戻る" }).click();
  await expect(tags.getByRole("button", { name: "主菜" })).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByRole("link")).toHaveCount(1);
});

test.describe("connecting an assistant", () => {
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  let clientId = "";
  let accessToken = "";

  async function authorizeUrl(page: Page, state: string) {
    const registered = await page.request.post("/oauth/register", { data: { client_name: "E2E アシスタント", redirect_uris: [redirect] } });
    clientId = (await registered.json()).client_id;
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    });
    return { verifier, url: `/oauth/authorize?${query}` };
  }

  test("a signed-out person signs in, sees who is asking and where they go back to, and allows", async () => {
    // Claude's browser comes back to its own site; stand in for that site.
    await aki.route("https://claude.ai/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "callback" }));
    await aki.goto("/settings");
    await aki.getByRole("button", { name: "ログアウト" }).click();
    await expect(aki).toHaveURL(/\/login$/);

    const { verifier, url } = await authorizeUrl(aki, "state-1");
    await aki.goto(url);
    await expect(aki).toHaveURL(/\/login\?next=%2Fauthorize/);
    await aki.getByRole("button", { name: "パスキーでログイン" }).click();

    await expect(aki.getByRole("heading", { name: "接続を許可しますか？" })).toBeVisible();
    await expect(aki.getByText("E2E アシスタント")).toBeVisible();
    await expect(aki.getByText("claude.ai")).toBeVisible();
    await expect(aki.getByText("アイテムを追加・変更・削除・移動する")).toBeVisible();
    await expect(aki.getByText("レシピと作った記録を追加・変更・削除する")).toBeVisible();
    await aki.getByRole("button", { name: "許可する" }).click();

    await aki.waitForURL((url) => url.origin === "https://claude.ai");
    const back = new URL(aki.url());
    expect(back.searchParams.get("state")).toBe("state-1");
    expect(back.searchParams.get("iss")).toBe("http://localhost:18787");

    // The assistant trades the code for a token and uses the household's lists.
    const token = await aki.request.post("/oauth/token", {
      form: { grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: redirect },
    });
    expect(token.status()).toBe(200);
    const { access_token: access } = await token.json();
    const V = "2026-07-28";
    const call = await aki.request.post("/mcp", {
      headers: { authorization: `Bearer ${access}`, "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": "list_items" },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_items", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } },
      },
    });
    const items = JSON.parse((await call.json()).result.content[0].text).items.map((i: { name: string }) => i.name);
    expect(items).toEqual(expect.arrayContaining(["牛乳", "卵", "パン"]));

    // And the recipes added in the app, with how often they were cooked.
    const recipes = await aki.request.post("/mcp", {
      headers: { authorization: `Bearer ${access}`, "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": "list_recipes" },
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_recipes", arguments: { query: "玉ねぎ" }, _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } },
      },
    });
    const found = JSON.parse((await recipes.json()).result.content[0].text).recipes;
    expect(found.map((r: { title: string; cookCount: number }) => [r.title, r.cookCount])).toEqual([["バターチキンカレー", 1]]);
    accessToken = access;
  });

  test("the connection is listed in the settings, and disconnecting cuts it off", async () => {
    await aki.goto("/settings");
    await expect(aki.getByText("E2E アシスタント")).toBeVisible();
    await expect(aki.getByText("リスト: 閲覧と編集 ・ レシピ: 閲覧と編集")).toBeVisible();
    await aki.getByRole("button", { name: "解除" }).click();
    await expect(aki.getByText("接続はありません。")).toBeVisible();

    const V = "2026-07-28";
    const call = await aki.request.post("/mcp", {
      headers: { authorization: `Bearer ${accessToken}`, "mcp-protocol-version": V, "mcp-method": "tools/list" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(call.status()).toBe(401);
  });

  test("saying no sends the assistant back with access_denied", async () => {
    const { url } = await authorizeUrl(aki, "state-2");
    await aki.goto(url);
    await aki.getByRole("button", { name: "許可しない" }).click();
    await aki.waitForURL((url) => url.origin === "https://claude.ai");
    const back = new URL(aki.url());
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("state-2");
    expect(back.searchParams.get("code")).toBeNull();
  });

  test("a request for an unknown client is refused with a message, not redirected", async () => {
    await aki.goto(`/authorize?client_id=nobody&redirect_uri=${encodeURIComponent(redirect)}&response_type=code`);
    await expect(aki.getByRole("heading", { name: "接続できません" })).toBeVisible();
    await expect(aki.getByText("Unknown client.")).toBeVisible();
  });
});

test("the app can be installed: manifest, icons and service worker are in place", async () => {
  await aki.goto("/");
  const manifest = await (await aki.request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/" });
  for (const icon of manifest.icons) expect((await aki.request.get(icon.src)).status()).toBe(200);
  const registered = await aki.evaluate(async () => (await navigator.serviceWorker.ready).active?.state);
  expect(registered).toBe("activated");
});
