import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { api, type Book, type Cook, type Recipe, type Tag } from "../api";
import { localDate, shortDate } from "../dates";
import { listPath, MainTop } from "../nav";
import { parseTags } from "../tags";
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

// 42 -> p.42; anything else (e.g. 巻末) as written.
const pageText = (page: string) => (/^\d/.test(page) ? `p.${page}` : page);
const bookText = (book: { title: string }, page: string | null) => `『${book.title}』${page ? ` ${pageText(page)}` : ""}`;
const sourceText = (r: Recipe) => (r.book ? bookText(r.book, r.page) : r.url ? hostOf(r.url) : null);

// The collection's filters live in the address (?tag=…&tag=…&book=…), so the back button keeps them.
function filterPath(tags: string[], book: string) {
  const params = new URLSearchParams();
  for (const tag of tags) params.append("tag", tag);
  if (book) params.set("book", book);
  const query = params.toString();
  return `/recipes${query ? `?${query}` : ""}`;
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="tags">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
        </span>
      ))}
    </span>
  );
}

// --- the collection --------------------------------------------------------------------

export function Recipes() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const selectedTags = params.getAll("tag");
  const bookId = params.get("book") ?? "";
  const [query, setQuery] = useState("");
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [error, setError] = useState("");
  // Bumped to fetch the list again with the same search and filters.
  const [version, setVersion] = useState(0);

  const loadGroups = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([api.get<{ tags: Tag[] }>("/api/tags"), api.get<{ books: Book[] }>("/api/books")]);
      setTags(t.tags);
      setBooks(b.books);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Searches as the person types, a moment after they stop; filters apply at once.
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const p = new URLSearchParams(search);
        const q = query.trim();
        if (q) p.set("q", q);
        const found = (await api.get<{ recipes: Recipe[] }>(`/api/recipes${p.size ? `?${p}` : ""}`)).recipes;
        if (!stale) setRecipes(found);
      } catch (e) {
        if (!stale) setError(describeError(e));
      }
    }, query ? 250 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, search, version]);

  const toggleTag = (tag: string) =>
    navigate(filterPath(selectedTags.includes(tag) ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag], bookId), { replace: true });
  const book = books.find((b) => b.id === bookId);
  // Tags in the address that no recipe has any more still show, so they can be switched off.
  const tagNames = [...tags.map((t) => t.tag), ...selectedTags.filter((t) => !tags.some((x) => x.tag === t))];
  const filtered = selectedTags.length > 0 || bookId !== "";

  async function renameBook(b: Book) {
    const title = prompt("本の名前", b.title)?.trim();
    if (!title || title === b.title) return;
    try {
      await api.patch(`/api/books/${b.id}`, { title });
      await loadGroups();
      navigate(filterPath(selectedTags, bookId), { replace: true });
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function deleteBook(b: Book) {
    if (!confirm(`「${b.title}」を削除しますか？レシピは残り、本とページの情報だけが消えます。`)) return;
    try {
      await api.delete(`/api/books/${b.id}`);
      await loadGroups();
      navigate(filterPath(selectedTags, ""), { replace: true });
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <main className="page">
      <MainTop
        active="recipes"
        onRefresh={() => {
          setError("");
          setVersion((v) => v + 1);
          return loadGroups();
        }}
      >
        <div className="add">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="料理名や材料で探す" aria-label="レシピを探す" maxLength={200} />
          <Link href="/recipes/new" className="button primary">
            追加
          </Link>
        </div>
      </MainTop>

      {books.length > 0 && (
        <div className="add">
          <select value={bookId} onChange={(e) => navigate(filterPath(selectedTags, e.target.value), { replace: true })} aria-label="本で絞る">
            <option value="">すべての本・サイト</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}（{b.recipeCount}）
              </option>
            ))}
          </select>
          {book && (
            <details className="menu">
              <summary aria-label="本の操作">⋯</summary>
              <div className="menu-items">
                <button onClick={() => renameBook(book)}>名前を変える</button>
                <button className="danger" onClick={() => deleteBook(book)}>
                  本を削除
                </button>
              </div>
            </details>
          )}
        </div>
      )}
      {tagNames.length > 0 && (
        <div className="chips filter" role="group" aria-label="タグで絞る">
          {tagNames.map((t) => (
            <button key={t} className="chip" aria-pressed={selectedTags.includes(t)} onClick={() => toggleTag(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <ErrorText>{error}</ErrorText>

      {recipes === null && !error && <p className="muted center">読み込み中…</p>}
      {recipes !== null && recipes.length === 0 && (
        <p className="muted center">{query.trim() || filtered ? "見つかりませんでした。" : "まだレシピがありません。"}</p>
      )}

      <ul className="items recipe-list">
        {(recipes ?? []).map((r) => {
          const source = sourceText(r);
          return (
            <li key={r.id} className="item">
              <Link href={`/recipes/${r.id}`} className="recipe-link">
                <span className="name">{r.title}</span>
                <span className="recipe-meta">
                  <span className="note">
                    {cookedText(r)}
                    {source && ` ・ ${source}`}
                  </span>
                  <Tags tags={r.tags} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

// --- adding and editing ------------------------------------------------------------------

type Fields = { title: string; url: string; body: string; book: string; page: string; tags: string };

function RecipeForm({ initial, submitLabel, onSubmit, onCancel }: { initial: Fields; submitLabel: string; onSubmit(fields: Fields): Promise<void>; onCancel(): void }) {
  const [fields, setFields] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [books, setBooks] = useState<Book[]>([]);
  const [known, setKnown] = useState<Tag[]>([]);
  const set = (key: keyof Fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [key]: e.target.value }));

  // Existing books and tags, to pick from rather than retype (and misspell).
  useEffect(() => {
    api.get<{ books: Book[] }>("/api/books").then((r) => setBooks(r.books), () => {});
    api.get<{ tags: Tag[] }>("/api/tags").then((r) => setKnown(r.tags), () => {});
  }, []);

  const chosen = parseTags(fields.tags);
  const toggle = (tag: string) =>
    setFields((f) => {
      const now = parseTags(f.tags);
      return { ...f, tags: (now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag]).join(" ") };
    });

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
      <div className="add">
        <label className="grow">
          本・冊子（任意）
          <input value={fields.book} onChange={set("book")} list="books" maxLength={200} autoComplete="off" />
          <datalist id="books">
            {books.map((b) => (
              <option key={b.id} value={b.title} />
            ))}
          </datalist>
        </label>
        <label className="page-field">
          ページ
          <input value={fields.page} onChange={set("page")} inputMode="numeric" maxLength={20} disabled={!fields.book.trim()} />
        </label>
      </div>
      <label>
        タグ（スペース区切り。任意）
        <input value={fields.tags} onChange={set("tags")} placeholder="主菜 時短 作り置き" autoComplete="off" />
      </label>
      {known.length > 0 && (
        <div className="chips" role="group" aria-label="使っているタグ">
          {known.map(({ tag }) => (
            <button type="button" key={tag} className="chip" aria-pressed={chosen.includes(tag)} onClick={() => toggle(tag)}>
              {tag}
            </button>
          ))}
        </div>
      )}
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

const payload = (f: Fields) => {
  const book = f.book.trim() || null;
  return { title: f.title, url: f.url.trim() || null, body: f.body.trim() || null, book, page: book ? f.page.trim() || null : null, tags: parseTags(f.tags) };
};
const EMPTY: Fields = { title: "", url: "", body: "", book: "", page: "", tags: "" };

export function NewRecipe() {
  const [, navigate] = useLocation();
  const [error, setError] = useState("");
  return (
    <Page title="レシピを追加" at="recipes">
      <ErrorText>{error}</ErrorText>
      <RecipeForm
        initial={EMPTY}
        submitLabel="追加"
        onCancel={() => navigate(listPath("recipes"))}
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
      <Page title="レシピが見つかりません" at="recipes">
        <p className="muted">削除されたか、別の家のレシピです。</p>
      </Page>
    );
  }
  if (!recipe) return <Page at="recipes">{error ? <ErrorText>{error}</ErrorText> : <p className="muted center">読み込み中…</p>}</Page>;

  if (editing) {
    return (
      <Page title="レシピを編集" at="recipes">
        <ErrorText>{error}</ErrorText>
        <RecipeForm
          initial={{ title: recipe.title, url: recipe.url ?? "", body: recipe.body ?? "", book: recipe.book?.title ?? "", page: recipe.page ?? "", tags: recipe.tags.join(" ") }}
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
    <Page title={recipe.title} at="recipes">
      {recipe.tags.length > 0 && (
        <p className="tags">
          {recipe.tags.map((t) => (
            <Link key={t} href={filterPath([t], "")} className="tag">
              {t}
            </Link>
          ))}
        </p>
      )}
      {recipe.book && (
        <p className="source">
          <Link href={filterPath([], recipe.book.id)}>『{recipe.book.title}』</Link>
          {recipe.page && ` ${pageText(recipe.page)}`}
        </p>
      )}
      {recipe.url && (
        <p className="source">
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
