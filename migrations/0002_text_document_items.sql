DROP INDEX IF EXISTS idx_items_active_created;
DROP TABLE IF EXISTS items;

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'document')),
  r2_key TEXT NOT NULL,
  file_name TEXT,
  file_type TEXT,
  file_size INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (
    (kind = 'text' AND file_name IS NOT NULL AND file_type IS NOT NULL AND file_size IS NOT NULL)
    OR
    (kind = 'document' AND file_name IS NOT NULL AND file_size IS NOT NULL)
  )
);

CREATE INDEX idx_items_active_created
ON items (expires_at, created_at DESC);
