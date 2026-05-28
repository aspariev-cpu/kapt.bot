const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'capts.db'));

db.serialize(() => {
  // Таблица: активные сборы
  db.run(`
    CREATE TABLE IF NOT EXISTS active_capts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT,
      message_id TEXT,
      start_time TEXT,
      enemy TEXT,
      created_by TEXT,
      created_at TEXT
    )
  `);

  // Таблица: участники сборов
  db.run(`
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capt_id INTEGER,
      user_id TEXT,
      username TEXT,
      player_name TEXT,
      static_info TEXT,
      type TEXT,
      joined_at TEXT,
      FOREIGN KEY(capt_id) REFERENCES active_capts(id)
    )
  `);

  // Таблица: пользователи (баллы, тир, статус обзвона)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      points INTEGER DEFAULT 0,
      tier TEXT DEFAULT 'none',
      pending_tier TEXT DEFAULT 'none',
      call_notified INTEGER DEFAULT 0,
      created_at TEXT
    )
  `);

  // Таблица: скрины игроков
  db.run(`
    CREATE TABLE IF NOT EXISTS game_screens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capt_id INTEGER,
      user_id TEXT,
      username TEXT,
      screen_url TEXT,
      screen_number INTEGER,
      submitted_at TEXT,
      status TEXT DEFAULT 'pending',
      FOREIGN KEY(capt_id) REFERENCES active_capts(id)
    )
  `);

  // Таблица: статус отправки скринов
  db.run(`
    CREATE TABLE IF NOT EXISTS player_screen_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capt_id INTEGER,
      user_id TEXT,
      screens_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'waiting',
      notified INTEGER DEFAULT 0,
      penalty_applied INTEGER DEFAULT 0,
      FOREIGN KEY(capt_id) REFERENCES active_capts(id)
    )
  `);
});

module.exports = db;