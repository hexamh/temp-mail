<div align="center">
<h1>✉️ TempMail Serverless API</h1>
<p>A high-performance, fully serverless temporary email service built entirely on Cloudflare's Edge infrastructure.</p>
</div>

### [Join our Telegram channel](https://t.me/drkingbd)

## 🚀 Overview
TempMail is a production-ready, highly scalable temporary email backend. Leveraging the Cloudflare ecosystem, it processes incoming emails at the edge, stores data efficiently, and delivers real-time updates to clients.

### ⚡ Key Features
  * **Instant Inbox Creation:** Generate unique, disposable email addresses with customizable TTLs.
  * **Real-Time Delivery:** Edge-optimized Server-Sent Events (SSE) stream for instant incoming email notifications.
  * **MIME Parsing & Attachments:** Robust email parsing with secure, scalable KV attachment storage up to 15MB.
  * **O(1) Garbage Collection:** D1 and Edge KV independently handle TTL cleanup ensuring zero maintenance and zero orphaned bytes.
  * **Content Negotiation:** The root endpoint serves a styled HTML promo for browsers and a JSON spec for API clients.

## 🛠 Architecture & Tech Stack
This project runs 100% on **Cloudflare Workers**:
  * **Compute:** Cloudflare Workers (TypeScript)
  * **Ingress:** Cloudflare Email Routing (Catch-all Worker binding)
  * **Relational Data:** Cloudflare D1 (SQLite for sessions, emails, metadata)
  * **High-Speed State & Blobs:** Cloudflare KV (Real-time polling state, lookups, and auto-expiring physical attachment storage)

## ⚙️ Setup & Deployment

1. **Install Dependencies:** `npm install`
2. **Provision Cloudflare Resources:**
   ```bash
   wrangler d1 create temp
   wrangler kv:namespace create TEMPMAIL_KV
