# Push It

End-to-end encrypted (E2EE) link & text relay between **Android** and **Windows**, built as a **SolidJS 2.0 + Vite 8 + Bun** PWA hosted 100% on **Cloudflare Workers + Durable Objects**.

Nothing runs on your local machine—once deployed, both the PWA and the WebSocket/Web Push relay run on Cloudflare's edge.

## Features

- **Zero-Knowledge E2EE (`AES-GCM` 256-bit):** Uses the browser's native Web Crypto API. The symmetric key is shared via QR code in the URL fragment (`#key=...`), which is never sent to the server.
- **One-Way Room Routing:** The server only sees `SHA-256("push-it-room-v1:" + key)` as the room ID and opaque ciphertext envelopes.
- **Auto-Open Links on Windows:** While the PWA tab is open, incoming links arrive over a hibernating WebSocket and open immediately in a new tab (once you allow pop-ups for the site).
- **Background Web Push Notifications:** When the app is closed on Android or Windows, the Service Worker wakes up, reads the AES key from IndexedDB, decrypts the message locally, and shows a notification. Tapping a link notification opens the URL directly.
- **Android Share Sheet Integration:** Installing the PWA on Android registers it as a native Share Target (`/share`), letting you push links from any app in 2 taps.
- **Zero-Config VAPID Keys:** On first request, the Worker automatically generates and persists its own P-256 VAPID keypair in Durable Object storage (no local scripts or manual secrets required).

## Architecture

```text
Android (PWA / Share Sheet)
  ──[Encrypt with AES-GCM key in IndexedDB]──▶
Cloudflare Worker + Durable Object (sees only roomId hash + ciphertext)
  ├── Open tab (Windows)   ──▶ WebSocket (Hibernation API) ──▶ Decrypt ──▶ window.open(url)
  └── Closed / Background  ──▶ Web Push (RFC 8291) ──▶ Service Worker ──▶ Decrypt ──▶ Notification
```

## Tech Stack

- **Frontend:** SolidJS 2.0 (`solid-js`, `@solidjs/web`), Vite 8 (`@solidjs/vite-plugin`), Bun
- **Backend:** Cloudflare Workers Static Assets + Durable Objects (SQLite storage + WebSocket Hibernation)
- **Web Push:** `@block65/webcrypto-web-push` (pure Web Crypto, zero Node polyfills)

## Deploy to Cloudflare Workers

### Option 1: Zero-Local Git Auto-Deploy (Cloudflare Dashboard)

1. Push this repository to GitHub.
2. Open **Cloudflare Dashboard → Workers & Pages → Create → Import a repository**.
3. Configure:
   - **Build command:** `bun install && bun run build`
   - **Deploy command:** `bunx wrangler deploy`
4. Deploy! VAPID keys are generated automatically on Cloudflare on first boot.

### Option 2: Deploy via Wrangler CLI

```bash
bun install
bun run deploy
```

*(Optional)* If you prefer to supply your own VAPID keys instead of auto-generated ones, run `bun run gen:vapid` and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` as Worker secrets.

## Pairing Android & Windows

1. Open your deployed `https://push-it.<your-subdomain>.workers.dev` URL on Windows.
2. Click **Pair Device** and scan the QR code with your Android phone.
3. Click **Enable Push** on both devices to allow background notifications.
4. **Android:** Tap browser menu → **Add to Home screen / Install app** to enable the native Share menu target.
5. **Windows:** Allow **Pop-ups and redirects** for your Worker URL if you want incoming links to open automatically while the tab is open.
