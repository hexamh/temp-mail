<div align="center">
<h1>✉️ TempMail Serverless API</h1>
<p>A high-performance, fully serverless temporary email service built on Cloudflare's Edge infrastructure.</p>
</div>

## 🚀 Overview

TempMail is a production-ready, highly scalable temporary email backend. Leveraging Cloudflare's ecosystem, it processes incoming emails at the edge, stores data globally, and delivers real-time updates to clients without the need for traditional servers.

### ⚡ Key Features

  * **Instant Inbox Creation:** Generate unique, disposable email addresses with customizable TTLs (default 10 minutes).
  * **Real-Time Delivery:** Edge-optimized Server-Sent Events (SSE) stream for instant incoming email notifications.
  * **MIME Parsing & Attachments:** Robust email parsing (via `postal-mime`) with secure, scalable attachment storage.
  * **Edge Caching:** Attachments are streamed directly from R2 and cached at the edge via the Cache API for lightning-fast retrieval.
  * **Automated Lifecycle Management:** Scheduled cron triggers (`cleanup.ts`) automatically purge expired sessions, emails, and R2 objects to maintain a zero-maintenance footprint.
  * **CORS Ready:** Pre-configured headers for seamless integration with frontend applications (React, Vue, etc.).

## 🛠 Architecture & Tech Stack

This project is built exclusively on the **Cloudflare Workers** ecosystem:

  * **Compute:** Cloudflare Workers (TypeScript)
  * **Ingress:** Cloudflare Email Routing (Catch-all forwarding to Worker)
  * **Relational Data:** Cloudflare D1 (SQLite for sessions, emails, and attachment metadata)
  * **High-Speed State:** Cloudflare KV (Real-time polling state and session lookups)
  * **Object Storage:** Cloudflare R2 (Email attachments)

## 📦 Prerequisites

  * [Node.js](https://nodejs.org/) (v18+)
  * [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
  * A Cloudflare account with a registered domain.

## ⚙️ Setup & Deployment

### 1\. Install Dependencies

```bash
npm install
```

### 2\. Provision Cloudflare Resources

You will need to create the required bindings in your Cloudflare dashboard or via Wrangler:

```bash
# Create D1 Database
wrangler d1 create temp

# Create KV Namespace
wrangler kv:namespace create TEMPMAIL_KV

# Create R2 Bucket
wrangler r2 bucket create mail-storage
```

Update your `wrangler.toml` with the generated IDs for your D1 database and KV namespace.

### 3\. Initialize the Database

Create a `schema.sql` file in your project root with the following structure, then execute it against your D1 database:

```sql
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
  r2_key TEXT,
  FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
);
```

Apply the schema:

```bash
wrangler d1 execute temp --file=./schema.sql --remote
```

### 4\. Configure Environment Variables

In `wrangler.toml`, ensure your target domains are correctly set in the `[vars]` section:

```toml
[vars]
ALLOWED_DOMAINS = "mail.yourdomain.com,yourdomain.com"
INBOX_TTL_SECONDS = "600"
```

### 5\. Deploy the Worker

```bash
npm run deploy
```

### 6\. Enable Email Routing

1.  Go to your Cloudflare Dashboard -\> **Email Routing**.
2.  Enable Email Routing for your target domain.
3.  Under **Routing Rules**, create a **Catch-all address** rule.
4.  Set the action to **Send to a Worker** and select your deployed `tempmail` worker.

## 📡 API Reference

All endpoints return standard JSON responses and include permissive CORS headers for frontend consumption.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/domains` | List available domains for inbox creation. |
| `POST` | `/inbox/create` | Generate a new temporary email address and secure token. |
| `GET` | `/inbox/:token` | List all emails for the active session. |
| `GET` | `/inbox/:token/check` | Lightweight polling endpoint to check for new messages. |
| `GET` | `/inbox/:token/stream` | Establish an SSE connection for real-time inbox updates. |
| `GET` | `/inbox/:token/email/:id` | Retrieve full email content (HTML/Text) and attachment metadata. |
| `DELETE` | `/inbox/:token/email/:id` | Delete a specific email and its associated R2 attachments. |
| `GET` | `/inbox/:token/attachment/:id` | Download a file attachment (Streamed from R2 via Edge Cache). |
| `POST` | `/inbox/:token/extend` | Reset the session expiration timer. |
| `DELETE` | `/inbox/:token` | Immediately purge the inbox, all emails, and all attachments. |

## 🛡️ Security & Limits

  * **Attachment Limits:** Emails exceeding 15MB are pre-emptively rejected to prevent Worker memory exhaustion.
  * **Token Authentication:** All inbox operations require the secure, cryptographically generated UUID `token` provided upon inbox creation.
  * **Garbage Collection:** A CRON trigger (`cleanup.ts`) runs every 5 minutes to sweep and destroy expired sessions, cascading deletions across D1 and R2 to minimize storage costs.
