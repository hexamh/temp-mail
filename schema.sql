DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS emails;
DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  token TEXT,
  domain TEXT,
  created_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  inbox_email TEXT,
  from_address TEXT,
  from_name TEXT,
  reply_to TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  raw_headers TEXT,
  received_at INTEGER,
  is_read INTEGER DEFAULT 0,
  size INTEGER,
  FOREIGN KEY(inbox_email) REFERENCES sessions(email) ON DELETE CASCADE
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT,
  filename TEXT,
  content_type TEXT,
  size INTEGER,
  kv_key TEXT,
  FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_emails_inbox ON emails(inbox_email);
