-- Run this in your Cloudflare D1 console or via wrangler d1 execute

-- Users table (should already exist, included for reference)
CREATE TABLE IF NOT EXISTS users (
  token          TEXT PRIMARY KEY,
  streak         INTEGER NOT NULL DEFAULT 0,
  last_completed TEXT
);

-- Puzzle progress table (new)
CREATE TABLE IF NOT EXISTS puzzles (
  token       TEXT    NOT NULL,
  date        TEXT    NOT NULL,  -- YYYY-MM-DD
  found_words TEXT    NOT NULL DEFAULT '[]',  -- JSON array of found word strings
  complete    INTEGER NOT NULL DEFAULT 0,     -- 0 or 1
  PRIMARY KEY (token, date),
  FOREIGN KEY (token) REFERENCES users(token)
);
