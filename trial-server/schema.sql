CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,   -- sha-256 of the trial token; the token itself is never stored
  rec        TEXT NOT NULL,      -- JSON: { createdAt, ip, userId?, email?, revoked? }
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  k TEXT PRIMARY KEY,            -- usr:<id>:<day> | usr:<id>:total | tok:<hash>:… (older tokens) | ip:<ip>:<day> | glob:<day>
                                 -- | authip:<ip>:<day> | authmail:<email>:<day> | authtry:<email>:<sent>:<day>
  v INTEGER NOT NULL             -- micro-USD (or a count for auth*:)
);
CREATE TABLE IF NOT EXISTS users (   -- the customer list: one row per signed-in email address
  email      TEXT PRIMARY KEY,   -- lower-cased
  rec        TEXT NOT NULL,      -- JSON: { id, email, createdAt, lastLoginAt, logins, ip, lastIp, blocked? }
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (   -- pending sign-in codes (hash only), one per address
  email      TEXT PRIMARY KEY,
  rec        TEXT NOT NULL,      -- JSON: { hash, sentAt, expiresAt }
  expires_at INTEGER NOT NULL
);
