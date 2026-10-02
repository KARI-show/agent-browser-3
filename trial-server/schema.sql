CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,   -- sha-256 of the trial token; the token itself is never stored
  rec        TEXT NOT NULL,      -- JSON: { createdAt, ip, revoked? }
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  k TEXT PRIMARY KEY,            -- tok:<hash>:<day> | tok:<hash>:total | ip:<ip>:<day> | glob:<day> | reg:<ip>:<day>
  v INTEGER NOT NULL             -- micro-USD (or a count for reg:)
);
