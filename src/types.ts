export interface Env {
  // D1 Database
  TEMPMAIL_DB: D1Database;
  // KV Namespace (real-time polling & session store)
  TEMPMAIL_KV: KVNamespace;
  // R2 Bucket (attachment storage)
  TEMPMAIL_ATTACHMENTS: R2Bucket;
  // Allowed domains (comma-separated)
  ALLOWED_DOMAINS: string; // "drkingbd.cc,mail.drkingbd.cc"
  // Inbox TTL in seconds (default 600 = 10 min)
  INBOX_TTL_SECONDS: string;
}

// ── KV schemas ────────────────────────────────────────────────

export interface SessionKV {
  email: string;
  token: string;
  domain: string;
  created_at: number;
  expires_at: number;
}

export interface NotifyKV {
  count: number;
  last_id: string;
  updated_at: number;
}

// ── D1 row types ──────────────────────────────────────────────

export interface SessionRow {
  id: string;
  email: string;
  token: string;
  domain: string;
  created_at: number;
  expires_at: number;
}

export interface EmailRow {
  id: string;
  inbox_email: string;
  from_address: string;
  from_name: string;
  reply_to: string;
  subject: string;
  body_text: string;
  body_html: string;
  raw_headers: string;
  received_at: number;
  is_read: number;
  size: number;
}

export interface AttachmentRow {
  id: string;
  email_id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
}

// ── API response types ────────────────────────────────────────

export interface CreateInboxResponse {
  success: true;
  token: string;
  email: string;
  domain: string;
  created_at: number;
  expires_at: number;
  ttl_seconds: number;
}

export interface InboxResponse {
  success: true;
  token: string;
  email: string;
  expires_at: number;
  ttl_remaining: number;
  emails: EmailSummary[];
  total: number;
}

export interface EmailSummary {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  received_at: number;
  is_read: boolean;
  size: number;
  has_attachments: boolean;
  snippet: string;
}

export interface EmailDetail {
  id: string;
  inbox_email: string;
  from_address: string;
  from_name: string;
  reply_to: string;
  subject: string;
  body_text: string;
  body_html: string;
  received_at: number;
  is_read: boolean;
  size: number;
  attachments: AttachmentMeta[];
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  download_url: string;
}

export interface PollResponse {
  has_new: boolean;
  count: number;
  last_id: string | null;
  updated_at: number | null;
  expires_at: number;
  ttl_remaining: number;
}

export interface ErrorResponse {
  success: false;
  error: string;
  code: number;
}
