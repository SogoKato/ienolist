import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { api, type Cook, type Recipe } from "../api";
import { localDate, shortDate } from "../dates";
import { MainHeader, MainTabs } from "../nav";
import { describeError } from "../passkeys";
import { ErrorText, Page } from "../ui";

const cookedText = (r: Recipe) => (r.cookCount === 0 ? "まだ作っていません" : `${r.cookCount}回 ・ 最後は ${shortDate(r.lastCookedOn!)}`);

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// --- the collection --------------------------------------------------------------------

export function Recipes() {
  const [query, setQuery] = useState("");
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [error, setError] = useState("");

  // Searches as the person types, a moment after they stop.
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const q = query.trim();
        const found = (await api.get<{ recipes: Recipe[] }>(`/api/recipes${q ? `?q=${encodeURIComponent(q)}` : ""}`)).recipes;
        if (!stale) setRecipes(found);
      } catch (e) {
        if (!stale) setError(describeError(e));
      }
    }, query ? 250 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <main className="page">
      <MainHeader />
      <MainTabs active="recipes" />

      <div className="add">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="料理名や材料で探す" aria-label="レシピを探す" maxLength={200} />
        <Link href="/recipes/new" className="button primary">
          追加
        </Link>
      </div>
      <ErrorText>{error}</ErrorText>

      {recipes === null && !error && <p className="muted center">読み込み中…</p>}
      {recipes !== null && recipes.length === 0 && <p className="muted center">{query.trim() ? "見つかりませんでした。" : "まだレシピがありません。"}</p>}

      <ul className="items">
        {(recipes ?? []).map((r) => (
          <li key={r.id} className="item">
            <Link href={`/recipes/${r.id}`} className="recipe-link">
              <span className="name">{r.title}</span>
              <span className="note">
                {cookedText(r)}
                {r.url && ` ・ ${hostOf(r.url)}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

// --- adding and editing ------------------------------------------------------------------

type Fields = { title: string; url: string; body: string };

function RecipeForm({ initial, submitLabel, onSubmit, onCancel }: { initial: Fields; submitLabel: string; onSubmit(fields: Fields): Promise<void>; onCancel(): void }) {
  const [fields, setFields] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof Fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit(fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        料理名
        <input value={fields.title} onChange={set("title")} maxLength={200} required />
      </label>
      <label>
        レシピの URL（任意）
        <input type="url" value={fields.url} onChange={set("url")} placeholder="https://" maxLength={2000} />
      </label>
      <label>
        メモ（材料、手順、変えたところなど。任意）
        <textarea value={fields.body} onChange={set("body")} rows={10} maxLength={20000} />
      </label>
      <div className="row-actions">
        <button className="primary" disabled={busy || !fields.title.trim()}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

const payload = (f: Fields) => ({ title: f.title, url: f.url.trim() || null, body: f.body.trim() || null });

export function NewRecipe() {
  const [, navigate] = useLocation();
  const [error, setError] = useState("");
  return (
    <Page title="レシピを追加" actions={<Link href="/recipes">レシピへ</Link>}>
      <ErrorText>{error}</ErrorText>
      <RecipeForm
        initial={{ title: "", url: "", body: "" }}
        submitLabel="追加"
        onCancel={() => navigate("/recipes")}
        onSubmit={async (fields) => {
          setError("");
          try {
            const created = await api.post<Recipe>("/api/recipes", payload(fields));
            navigate(`/recipes/${created.id}`, { replace: true });
          } catch (e) {
            setError(describeError(e));
          }
        }}
      />
    </Page>
  );
}

// --- one recipe ------------------------------------------------------------------------------

export function RecipeDetail({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [cooks, setCooks] = useState<Cook[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([api.get<Recipe>(`/api/recipes/${id}`), api.get<{ cooks: Cook[] }>(`/api/recipes/${id}/cooks`)]);
      setRecipe(r);
      setCooks(c.cooks);
    } catch (e) {
      if (e instanceof Error && "status" in e && e.status === 404) setMissing(true);
      else setError(describeError(e));
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    }
  }

  if (missing) {
    return (
      <Page title="レシピが見つかりません" actions={<Link href="/recipes">レシピへ</Link>}>
        <p className="muted">削除されたか、別の家のレシピです。</p>
      </Page>
    );
  }
  if (!recipe) return error ? <ErrorText>{error}</ErrorText> : <p className="muted center">読み込み中…</p>;

  if (editing) {
    return (
      <Page title="レシピを編集" actions={<Link href="/recipes">レシピへ</Link>}>
        <ErrorText>{error}</ErrorText>
        <RecipeForm
          initial={{ title: recipe.title, url: recipe.url ?? "", body: recipe.body ?? "" }}
          submitLabel="保存"
          onCancel={() => setEditing(false)}
          onSubmit={(fields) =>
            run(async () => {
              await api.patch<Recipe>(`/api/recipes/${id}`, payload(fields));
              await load();
              setEditing(false);
            })
          }
        />
      </Page>
    );
  }

  return (
    <Page title={recipe.title} actions={<Link href="/recipes">レシピへ</Link>}>
      {recipe.url && (
        <p>
          <a href={recipe.url} target="_blank" rel="noopener noreferrer">
            {hostOf(recipe.url)} で開く ↗
          </a>
        </p>
      )}
      {recipe.body ? <p className="body-text">{recipe.body}</p> : <p className="muted">メモはありません。</p>}
      <ErrorText>{error}</ErrorText>

      <CookForm onRecord={(cookedOn, note) => run(async () => {
        await api.post<Cook>(`/api/recipes/${id}/cooks`, { cookedOn, note: note.trim() || null });
        await load();
      })} />

      <section aria-label="作った記録">
        <h2>作った記録</h2>
        {cooks.length === 0 ? (
          <p className="muted">まだ記録がありません。</p>
        ) : (
          <ul className="plain rows">
            {cooks.map((c) => (
              <li key={c.id}>
                <span>
                  {shortDate(c.cookedOn)}
                  {c.note && <span className="muted"> ・ {c.note}</span>}
                </span>
                <button
                  aria-label={`${shortDate(c.cookedOn)} の記録を削除`}
                  onClick={() => {
                    if (!confirm(`${shortDate(c.cookedOn)} の記録を削除しますか？`)) return;
                    run(async () => {
                      await api.delete(`/api/cooks/${c.id}`);
                      await load();
                    });
                  }}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="row-actions">
        <button onClick={() => setEditing(true)}>編集</button>
        <button
          className="danger"
          onClick={() => {
            if (!confirm(`「${recipe.title}」を削除しますか？作った記録は残ります。`)) return;
            run(async () => {
              await api.delete(`/api/recipes/${id}`);
              navigate("/recipes", { replace: true });
            });
          }}
        >
          削除
        </button>
      </section>
    </Page>
  );
}

function CookForm({ onRecord }: { onRecord(cookedOn: string, note: string): Promise<void> }) {
  const [day, setDay] = useState(localDate());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="cook stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        await onRecord(day, note);
        setNote("");
        setBusy(false);
      }}
    >
      <div className="add">
        <input type="date" value={day} max={localDate()} onChange={(e) => setDay(e.target.value)} aria-label="作った日" required />
        <button className="primary" disabled={busy || !day}>
          作った
        </button>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="ひとこと（任意）" aria-label="作った記録のひとこと" maxLength={2000} />
    </form>
  );
}
