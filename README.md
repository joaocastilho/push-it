# Push It

End-to-end encrypted (E2EE) link and text relay between **Android** and **Windows**, powered by a **SolidJS 2.0 + Vite 8 + Bun** PWA, a **Cloudflare Workers + Durable Objects** backend, and a **Manifest V3 Chromium/Helium extension**.

## What It Does

- **Client-Side E2EE (`AES-GCM` 256-bit):** Encrypts and decrypts links and text locally using the Web Crypto API. The symmetric key is shared via a QR code / URL fragment (`#key=...`) and never leaves your devices.
- **Zero-Knowledge Routing:** Derives a one-way `SHA-256` room ID from the key so Cloudflare Workers only route opaque room hashes and ciphertext.
- **Android PWA + Share Sheet:** Installable PWA with Web Share Target (`/share`) so links can be shared directly from any Android app, plus background Web Push notifications decrypted inside the Service Worker (`public/sw.js`).
- **Helium / Chromium Extension (`extension/`):** Connects to the room over WebSocket in the background, automatically opens incoming links in new tabs via `chrome.tabs.create`, displays native OS notifications without Google FCM, and sends the active tab or right-clicked links/text to Android.
- **Auto-Generated VAPID Keys:** The Durable Object (`worker/room-do.ts`) automatically generates and persists a P-256 VAPID keypair in Durable Object storage on first use.

## Project Structure

- `src/` — SolidJS 2.0 PWA frontend (`crypto.ts`, `db.ts`, `push.ts`, `App.tsx`)
- `public/` — PWA manifest (`manifest.webmanifest`), Service Worker (`sw.js`), and icons
- `worker/` — Cloudflare Worker (`index.ts`) and Durable Object (`room-do.ts`) with WebSocket Hibernation and RFC 8291 Web Push fan-out
- `extension/` — Unpacked Manifest V3 extension for Helium / Chromium browsers

## Deploy to Cloudflare Workers

1. Connect this repository in **Cloudflare Dashboard → Workers & Pages → Create → Import a repository**.
2. Set **Build command** to `bun install && bun run build` and **Deploy command** to `bunx wrangler deploy`.
3. Deploy.

## Install the Helium Extension

1. Open `chrome://extensions` in Helium.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder from this repository.
4. Open your deployed Push It URL, click **Pair Device → Copy Pair Link**, then click the **Push It** extension icon in Helium, paste the pair link, and click **Save & Connect**.
