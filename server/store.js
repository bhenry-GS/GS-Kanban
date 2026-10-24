// Document store on SQLite. Mirrors the collections the board page uses:
// each document is a JSON object addressed by (collection, id).
const Database = require("better-sqlite3");

const COLLECTIONS = ["members", "projects", "tasks", "templates", "config"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Nested objects merge recursively; anything else (arrays included) replaces the field.
function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function openStore(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS docs (
    col TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (col, id)
  )`);
  const qAll = db.prepare("SELECT col, id, data FROM docs");
  const qGet = db.prepare("SELECT data FROM docs WHERE col = ? AND id = ?");
  const qPut = db.prepare("INSERT INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
  const qDel = db.prepare("DELETE FROM docs WHERE col = ? AND id = ?");
  const listeners = new Set();
  const emit = (ev) => listeners.forEach((fn) => fn(ev));

  return {
    all() {
      const out = {};
      COLLECTIONS.forEach((c) => (out[c] = {}));
      for (const row of qAll.all()) if (out[row.col]) out[row.col][row.id] = JSON.parse(row.data);
      return out;
    },
    get(col, id) {
      const row = qGet.get(col, id);
      return row ? JSON.parse(row.data) : null;
    },
    set(col, id, data) {
      qPut.run(col, id, JSON.stringify(data), new Date().toISOString());
      emit({ col, id, data });
      return data;
    },
    update(col, id, patch) {
      const cur = this.get(col, id);
      if (!cur) return null;
      return this.set(col, id, deepMerge(cur, patch));
    },
    delete(col, id) {
      qDel.run(col, id);
      emit({ col, id, data: null });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() { db.close(); },
  };
}

module.exports = { openStore, COLLECTIONS, deepMerge };
