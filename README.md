# 🚀 Push It

Send links, notes, photos, and files privately between **any phone and any computer** — end-to-end encrypted, instant, and hosted 100% on **Cloudflare Workers**.

No accounts, no local server, and works smoothly across Windows, macOS, Linux, Android, and iOS/iPadOS.

---

## 🧩 Browser Extensions

Click your browser family below to download the ready-to-add extension:

<p>
  <a href="https://github.com/joaocastilho/push-it/releases/latest/download/push-it-chromium.zip">
    <img src="docs/banner-chromium.svg" alt="Get Push It for Chromium-based browsers" width="360" />
  </a>
  &nbsp;
  <a href="https://github.com/joaocastilho/push-it/releases/latest/download/push-it-firefox.xpi">
    <img src="docs/banner-firefox.svg" alt="Get Push It for Firefox-based browsers" width="360" />
  </a>
</p>

- **Chromium-based browsers:** Unzip `push-it-chromium.zip` → open your extensions page → turn on **Developer mode** → **Load unpacked**.
- **Firefox-based browsers:** Open `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select `push-it-firefox.xpi`.

---

## 📱 How to Use

### 1. Create Your Room
1. Open your Push It link on your first device and give it a name (like `Phone` or `Laptop`).
2. *(Optional)* Turn on **Protect room with a 6-digit PIN** if you want an extra code required whenever adding future devices.
3. Click **Create New Room**.

### 2. Pair Your Other Devices
1. On your first device, open **Settings → + Add Device** (or **+ Invite** in the extension).
2. You'll see a **single-use 6-digit code** (valid for 5 minutes) and a **QR code**.
3. On your other device, simply **type the 6 digits** or **scan the QR code** — and enter your Room PIN if you set one.

### 3. Share Anywhere
- **From your phone (Android):** Install Push It as an app, then share any link, note, photo, or file via **Share → Push It**.
  - With **1 other device**, it sends right away and shows a quick confirmation toast.
  - With **multiple devices**, it asks which device (or **All Devices**) to send to, then confirms with a toast.
- **From iPhone / iPad:** Add Push It to your Home Screen for notifications, and use the 2-step **iOS Share Sheet** card in Settings to get the same share picker and toast.
- **From your computer:** Click **Push This Tab**, paste text or screenshots (`Ctrl+V`), attach files (up to **7.5 MB**, with inline photo previews), or right-click any page/link → **Push It**.
- **Auto-burn timer:** Pick a timer right above the message box (`30 sec`, `1 min`, `5 min`, or `10 min`) when sending sensitive notes or codes so they wipe automatically.
- **Easy chat management:**
  - Every device keeps its own consistent bubble color so you can tell who sent what at a glance.
  - Tap the **search icon** to find past links, notes, or files instantly.
  - Tap the **copy icon** (or tap a bubble on mobile) to copy to clipboard, and **press and hold** on text to select specific words.
  - Tap the **bin icon** (or **swipe left** on mobile) to delete any message with a quick confirmation.

---

## 🔐 Security

Only devices you explicitly pair together can join or send data in your room — knowing the website URL alone is not enough.

- **Private by default:** Every message, device name, photo, and file is encrypted on your device before it is sent. The server only ever passes along scrambled data it cannot read.
- **Per-device access:** Every paired device gets its own private credential. Every request checks who sent it so no one can impersonate another device or peek into your room.
- **Single-use 6-digit pairing:** Once a room is created, it locks. Adding a new device requires a fresh 6-digit code or QR invite that expires in 5 minutes, works only once, and blocks repeated wrong guesses.
- **Optional 6-digit Room PIN:** Add an extra 6-digit PIN during setup (or anytime in Settings) so even someone who sees your QR code cannot join without your PIN.
- **Instant device removal & activity check:** Settings shows when each device was last active. Removing a device disconnects it immediately and blocks it permanently until re-invited.
- **Optional server access code:** Set an `ACCESS_KEY` numeric code on Cloudflare so strangers who discover your URL cannot even create rooms on your instance.
- **Zero lingering data:** Online pushes deliver straight through; offline messages and files delete automatically once every recipient receives them (or when their burn timer expires).

---

## 🌐 Compatibility

| Platform | Web App / PWA | Offline Notifications | Share Sheet | Browser Extension |
| --- | --- | --- | --- | --- |
| **Android** (Chromium-based) | ✅ | ✅ | ✅ Links, text, photos & files | — |
| **Android** (Firefox-based) | ✅ | ✅ | Copy / Paste | — |
| **iOS / iPadOS** | ✅ Home Screen | ✅ | ✅ 2-step Shortcut | — |
| **Desktop** (Chromium-based) | ✅ | ✅ | ✅ Right-click & Tab push | ✅ `.zip` |
| **Desktop** (Firefox-based) | ✅ | ✅ | ✅ Right-click & Tab push | ✅ `.xpi` |
| **macOS** (built-in browser) | ✅ Web App | ✅ | Copy / Paste | — |

---

## 🛠️ Tech Stack

| Layer | Technology |
| --- | --- |
| **Frontend PWA** | [SolidJS 2.0](https://www.solidjs.com/), [Vite 8](https://vite.dev/), [Bun](https://bun.sh/) |
| **Browser Extensions** | Manifest V3 for Chromium-based & Firefox-based browsers (`bun run build:extensions`) |
| **Backend & Hosting** | [Cloudflare Workers](https://workers.cloudflare.com/) Static Assets + SQLite-backed **Durable Objects** |
| **Encryption & Push** | Native Web Crypto API + Standard Web Push (`@block65/webcrypto-web-push`) |
| **Local Storage** | IndexedDB (PWA + Service Worker) & Extension local storage |

---

## ☁️ Self-Host on Cloudflare Workers

1. Open **Cloudflare Dashboard → Workers & Pages → Create → Import a repository** and select this repo.
2. Set **Build command:** `bun install && bun run build` and **Deploy command:** `bunx wrangler deploy`.
3. *(Optional, recommended)* Add a Worker secret named `ACCESS_KEY` (for example, a 6-digit code) so only you can create new rooms on your instance.
4. Click **Save and Deploy**.
