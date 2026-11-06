import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearch } from "wouter";
import { api, type Item, type List } from "../api";
import { MainTop } from "../nav";
import { describeError } from "../passkeys";
import { ErrorText, PencilIcon, TrashIcon } from "../ui";

// Per list: which statuses mean "still to do" and "done", and the words for them.
const LISTS = {
  shopping: { label: "買い物", open: "to_buy", done: "bought", doneLabel: "買った", other: "fridge", moveLabel: "冷蔵庫へ移す", placeholder: "買うものを追加" },
  fridge: { label: "冷蔵庫", open: "in_stock", done: "used_up", doneLabel: "使い切った", other: "shopping", moveLabel: "買い物リストへ移す", placeholder: "冷蔵庫にあるものを追加" },
} as const;

const REFRESH_MS = 20_000;

export function Lists() {
  // The list is in the address (/ or /?list=fridge), so the tabs are plain links.
  const list: List = new URLSearchParams(useSearch()).get("list") === "fridge" ? "fridge" : "shopping";
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setItems((await api.get<{ items: Item[] }>("/api/items")).items);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  // Changes made elsewhere (another phone, an assistant) show up on their own.
  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const replace = (item: Item) => setItems((current) => current?.map((i) => (i.id === item.id ? item : i)) ?? null);
  const remove = (id: string) => setItems((current) => current?.filter((i) => i.id !== id) ?? null);
  async function run(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
      load();
    }
  }

  const config = LISTS[list];
  const mine = (items ?? []).filter((i) => i.list === list);
  const open = mine.filter((i) => i.status === config.open);
  const done = mine.filter((i) => i.status === config.done);

  return (
    <main className="page">
      <MainTop
        active={list}
        counts={Object.fromEntries((Object.keys(LISTS) as List[]).map((key) => [key, (items ?? []).filter((i) => i.list === key && i.status === LISTS[key].open).length]))}
        onRefresh={() => {
          setError("");
          return load();
        }}
      >
        <AddForm
          placeholder={config.placeholder}
          onAdd={(name) =>
            run(async () => {
              const created = await api.post<Item>("/api/items", { list, name });
              setItems((current) => [...(current ?? []), created]);
            })
          }
        />
      </MainTop>
      <ErrorText>{error}</ErrorText>

      {items === null && !error && <p className="muted center">読み込み中…</p>}
      {items !== null && mine.length === 0 && <p className="muted center">まだ何もありません。</p>}

      <ul className="items">
        {open.map((item) => (
          <Row key={item.id} item={item} list={list} onChange={replace} onRemove={remove} run={run} />
        ))}
      </ul>

      {done.length > 0 && (
        <section aria-label={config.doneLabel}>
          <div className="section-bar">
            <h2>{config.doneLabel}</h2>
            <button
              className="quiet"
              onClick={() =>
                run(async () => {
                  await Promise.all(done.map((item) => api.post<Item>(`/api/items/${item.id}/move`, { to: config.other })));
                  await load();
                })
              }
            >
              まとめて{config.moveLabel}
            </button>
          </div>
          <ul className="items done">
            {done.map((item) => (
              <Row key={item.id} item={item} list={list} onChange={replace} onRemove={remove} run={run} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function AddForm({ placeholder, onAdd }: { placeholder: string; onAdd(name: string): Promise<void> }) {
  const [name, setName] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    setName("");
    await onAdd(value);
  }
  return (
    <form onSubmit={submit} className="add">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} aria-label={placeholder} maxLength={200} />
      <button className="primary" disabled={!name.trim()}>
        追加
      </button>
    </form>
  );
}

type RowProps = {
  item: Item;
  list: List;
  onChange(item: Item): void;
  onRemove(id: string): void;
  run(action: () => Promise<void>): Promise<void>;
};

// Ticking is the everyday action; editing and deleting sit at the end of the row. Moving to the
// other list is done for all ticked items at once ("まとめて…へ移す").
function Row({ item, list, onChange, onRemove, run }: RowProps) {
  const config = LISTS[list];
  const isDone = item.status === config.done;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [note, setNote] = useState(item.note ?? "");

  if (editing) {
    return (
      <li className="item editing">
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              onChange(await api.patch<Item>(`/api/items/${item.id}`, { name, note: note.trim() === "" ? null : note }));
              setEditing(false);
            });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="名前" maxLength={200} required />
          <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="メモ" placeholder="メモ" maxLength={1000} />
          <div className="row-actions">
            <button className="primary">保存</button>
            <button type="button" onClick={() => setEditing(false)}>
              やめる
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="item">
      <label className="check">
        <input
          type="checkbox"
          checked={isDone}
          aria-label={`${item.name} を${config.doneLabel}`}
          onChange={() => {
            // The tick answers at once; the server's answer replaces it (or a reload undoes it if that failed).
            const status = isDone ? config.open : config.done;
            onChange({ ...item, status });
            run(async () => onChange(await api.patch<Item>(`/api/items/${item.id}`, { status })));
          }}
        />
        <span className="text">
          <span className="name">{item.name}</span>
          {item.note && <span className="note">{item.note}</span>}
        </span>
      </label>
      <button className="icon" aria-label={`${item.name} を編集`} onClick={() => setEditing(true)}>
        <PencilIcon />
      </button>
      <button
        className="icon"
        aria-label={`${item.name} を削除`}
        onClick={() => {
          if (!confirm(`「${item.name}」を削除しますか？`)) return;
          run(async () => {
            await api.delete(`/api/items/${item.id}`);
            onRemove(item.id);
          });
        }}
      >
        <TrashIcon />
      </button>
    </li>
  );
}
