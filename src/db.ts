import Database from "better-sqlite3";
import path from "node:path";

export type WatchedToken = {
  chat_id: number;
  address: string;
  name: string;
  symbol: string;
  price_usd: number | null;
  fdv_usd: number | null;
  prev_price_usd: number | null;
  prev_fdv_usd: number | null;
};

const DB_PATH = path.join(process.cwd(), "tracker.db");

export function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      chat_id INTEGER PRIMARY KEY,
      alert_percent REAL NOT NULL DEFAULT 5,
      paused INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS watched_tokens (
      chat_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price_usd REAL,
      fdv_usd REAL,
      prev_price_usd REAL,
      prev_fdv_usd REAL,
      PRIMARY KEY (chat_id, address)
    );
  `);
  return db;
}

export function getSettings(db: Database.Database, chatId: number) {
  const row = db
    .prepare(
      `SELECT chat_id, alert_percent, paused FROM settings WHERE chat_id = ?`
    )
    .get(chatId) as
    | { chat_id: number; alert_percent: number; paused: number }
    | undefined;
  if (!row) {
    db.prepare(
      `INSERT INTO settings (chat_id, alert_percent, paused) VALUES (?, 5, 0)`
    ).run(chatId);
    return { chat_id: chatId, alert_percent: 5, paused: 0 };
  }
  return row;
}

export function setAlertPercent(
  db: Database.Database,
  chatId: number,
  pct: number
) {
  getSettings(db, chatId);
  db.prepare(`UPDATE settings SET alert_percent = ? WHERE chat_id = ?`).run(
    pct,
    chatId
  );
}

export function setPaused(db: Database.Database, chatId: number, paused: boolean) {
  getSettings(db, chatId);
  db.prepare(`UPDATE settings SET paused = ? WHERE chat_id = ?`).run(
    paused ? 1 : 0,
    chatId
  );
}

export function isPaused(db: Database.Database, chatId: number): boolean {
  return getSettings(db, chatId).paused === 1;
}

export function listWatched(db: Database.Database, chatId: number): WatchedToken[] {
  return db
    .prepare(
      `SELECT chat_id, address, name, symbol, price_usd, fdv_usd, prev_price_usd, prev_fdv_usd
       FROM watched_tokens WHERE chat_id = ? ORDER BY address`
    )
    .all(chatId) as WatchedToken[];
}

export function addWatched(
  db: Database.Database,
  row: Omit<WatchedToken, "price_usd" | "fdv_usd" | "prev_price_usd" | "prev_fdv_usd">
) {
  db.prepare(
    `INSERT INTO watched_tokens (chat_id, address, name, symbol, price_usd, fdv_usd, prev_price_usd, prev_fdv_usd)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)`
  ).run(row.chat_id, row.address, row.name, row.symbol);
}

export function removeWatched(
  db: Database.Database,
  chatId: number,
  addressLower: string
): boolean {
  const r = db
    .prepare(
      `DELETE FROM watched_tokens WHERE chat_id = ? AND lower(address) = ?`
    )
    .run(chatId, addressLower);
  return r.changes > 0;
}

export function hasWatched(
  db: Database.Database,
  chatId: number,
  addressLower: string
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM watched_tokens WHERE chat_id = ? AND lower(address) = ?`
    )
    .get(chatId, addressLower);
  return !!row;
}

/** İlk başarılı poll: önceki yok, değişim %0 göster */
export function initTokenSnapshot(
  db: Database.Database,
  chatId: number,
  addressLower: string,
  price: number,
  fdv: number
) {
  db.prepare(
    `UPDATE watched_tokens SET
      price_usd = ?, fdv_usd = ?, prev_price_usd = ?, prev_fdv_usd = ?
     WHERE chat_id = ? AND lower(address) = ?`
  ).run(price, fdv, price, fdv, chatId, addressLower);
}

export function advanceTokenSnapshot(
  db: Database.Database,
  chatId: number,
  addressLower: string,
  next: { price: number; fdv: number }
) {
  db.prepare(
    `UPDATE watched_tokens SET
      prev_price_usd = price_usd,
      prev_fdv_usd = fdv_usd,
      price_usd = ?,
      fdv_usd = ?
     WHERE chat_id = ? AND lower(address) = ?`
  ).run(next.price, next.fdv, chatId, addressLower);
}

export function allChatIdsWithTokens(db: Database.Database): number[] {
  const rows = db
    .prepare(`SELECT DISTINCT chat_id FROM watched_tokens`)
    .all() as { chat_id: number }[];
  return rows.map((r) => r.chat_id);
}
