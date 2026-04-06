import Database from "better-sqlite3";
import { join } from "path";

const DB_PATH = join(process.cwd(), "agent-x.db");

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    author_username TEXT,
    author_name TEXT,
    author_followers INTEGER DEFAULT 0,
    text TEXT NOT NULL,
    created_at TEXT,
    quality TEXT CHECK(quality IN ('high', 'medium', 'low')),
    draft_reply TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'skipped', 'replied', 'error')),
    should_follow INTEGER DEFAULT 0,
    followed INTEGER DEFAULT 0,
    liked INTEGER DEFAULT 0,
    suggest_quote INTEGER DEFAULT 0,
    author_bio TEXT,
    thread_context TEXT,
    error TEXT,
    logged_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS engagements (
    author_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('reply', 'follow', 'like', 'quote')),
    post_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migrate: add columns if they don't exist
try { db.exec("ALTER TABLE posts ADD COLUMN liked INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE posts ADD COLUMN suggest_quote INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE posts ADD COLUMN author_bio TEXT"); } catch {}
try { db.exec("ALTER TABLE posts ADD COLUMN thread_context TEXT"); } catch {}
try { db.exec("ALTER TABLE posts ADD COLUMN reply_settings TEXT DEFAULT 'everyone'"); } catch {}

export const insertPost = db.prepare(`
  INSERT OR IGNORE INTO posts (id, author_id, author_username, author_name, author_followers, text, created_at, author_bio, thread_context, reply_settings)
  VALUES (@id, @author_id, @author_username, @author_name, @author_followers, @text, @created_at, @author_bio, @thread_context, @reply_settings)
`);

export const updateClassification = db.prepare(`
  UPDATE posts SET quality = @quality, draft_reply = @draft_reply, should_follow = @should_follow, suggest_quote = @suggest_quote
  WHERE id = @id
`);

export const getPending = db.prepare(`
  SELECT * FROM posts WHERE status = 'pending' AND draft_reply IS NOT NULL ORDER BY logged_at DESC
`);

export const setStatus = db.prepare(`
  UPDATE posts SET status = @status WHERE id = @id
`);

export const setReplied = db.prepare(`
  UPDATE posts SET status = 'replied' WHERE id = @id
`);

export const setFollowed = db.prepare(`
  UPDATE posts SET followed = 1 WHERE id = @id
`);

export const setLiked = db.prepare(`
  UPDATE posts SET liked = 1 WHERE id = @id
`);

export const setError = db.prepare(`
  UPDATE posts SET status = 'error', error = @error WHERE id = @id
`);

export const getStats = db.prepare(`
  SELECT status, COUNT(*) as count FROM posts GROUP BY status
`);

export const getAllPosts = db.prepare(`
  SELECT * FROM posts ORDER BY logged_at DESC
`);

export const getPostById = db.prepare(`
  SELECT * FROM posts WHERE id = @id
`);

// Rules
export const getRules = db.prepare(`
  SELECT * FROM rules WHERE active = 1 ORDER BY created_at DESC
`);

export const addRule = db.prepare(`
  INSERT INTO rules (keyword) VALUES (@keyword)
`);

export const deleteRule = db.prepare(`
  DELETE FROM rules WHERE id = @id
`);

// Engagements
export const logEngagement = db.prepare(`
  INSERT INTO engagements (author_id, action, post_id) VALUES (@author_id, @action, @post_id)
`);

export const getRecentEngagement = db.prepare(`
  SELECT * FROM engagements WHERE author_id = @author_id AND action = @action AND created_at > datetime('now', '-1 day')
`);

export const hasFollowed = db.prepare(`
  SELECT 1 FROM engagements WHERE author_id = @author_id AND action = 'follow' LIMIT 1
`);

// Watchlist
export const getWatchlist = db.prepare(`
  SELECT * FROM watchlist ORDER BY created_at DESC
`);

export const addWatchlistAccount = db.prepare(`
  INSERT OR IGNORE INTO watchlist (username) VALUES (@username)
`);

export const deleteWatchlistAccount = db.prepare(`
  DELETE FROM watchlist WHERE id = @id
`);

// Settings
export const getSetting = db.prepare(`
  SELECT value FROM settings WHERE key = @key
`);

export const setSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = @value
`);

export const getAllSettings = db.prepare(`
  SELECT * FROM settings
`);

export function getSettingValue(key: string, fallback: string = ""): string {
  const row = getSetting.get({ key }) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export default db;
