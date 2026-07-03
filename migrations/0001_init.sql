CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'link', 'file')),
  title TEXT NOT NULL,
  url TEXT,
  r2_key TEXT,
  file_name TEXT,
  file_type TEXT,
  file_size INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (
    (kind = 'link' AND url IS NOT NULL AND r2_key IS NULL)
    OR
    (kind IN ('note', 'file') AND r2_key IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_items_active_created
ON items (expires_at, created_at DESC);
