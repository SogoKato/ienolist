import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrate, openDatabase, readMigrations } from "./sqlite.ts";

test("migrations run once and are remembered across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "household-db-"));
  try {
    const path = join(dir, "app.db");
    const first = openDatabase(path);
    const names = readMigrations().map((m) => m.name);
    assert.ok(names.length > 0);
    assert.deepEqual(first.raw.prepare("SELECT name FROM _migrations").all().map((r) => r.name), names);
    first.raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0)");
    first.raw.close();

    // Opening again applies nothing and keeps the data.
    const second = openDatabase(path);
    assert.deepEqual(migrate(second.raw), []);
    assert.equal(second.raw.prepare("SELECT COUNT(*) AS n FROM households").get()!.n, 1);
    second.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an opened database enforces foreign keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "household-db-"));
  try {
    const { raw } = openDatabase(join(dir, "app.db"));
    assert.throws(() => raw.exec("INSERT INTO memberships (user_id, household_id, role, created_at) VALUES ('nobody', 'nothing', 'admin', 0)"), /FOREIGN KEY/);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
