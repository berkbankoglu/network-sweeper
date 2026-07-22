# Network Sweeper 🧹

A small Chrome extension (Manifest V3) that bulk-removes **your own** connections on LinkedIn — built because doing it by hand, three clicks at a time, was not an option for a network of hundreds.

> **⚠️ Disclaimer — read before using**
>
> This is a personal-use tool published for educational purposes. Automating actions on LinkedIn violates LinkedIn's User Agreement. Using it may get your account temporarily restricted or banned, and **removed connections cannot be restored**. This project is not affiliated with, endorsed by, or connected to LinkedIn in any way. Use entirely at your own risk.

## What it does

Open your connections page and the extension takes over: it opens each connection's overflow menu, chooses *Remove connection*, confirms the dialog, and moves on to the next one — until the list is empty or you tell it to stop.

- **Floating control panel** (bottom-right) with live counters, Start/Stop, and a 5-second countdown before auto-start
- **Adaptive selectors** — finds UI elements by role and accessible text rather than brittle class names (LinkedIn's obfuscated classes change constantly); falls back to a heuristic that locates the overflow button from each profile link's row
- **Smart waits** — polls for elements at 100 ms intervals instead of fixed sleeps, so it runs as fast as the UI responds
- **Record mode 🎬** — click *Start Recording*, remove one connection by hand, and the extension captures every element you clicked (tag, roles, aria-labels, CSS path, ancestor chain) to the clipboard. This is how the selectors were reverse-engineered, and how you can fix them when LinkedIn changes its UI again
- **Error reporting 📋** — one button copies a structured JSON report (errors with timestamps, page structure summary) for easy debugging
- Works with **Turkish and English** LinkedIn UI; persistent total counter via `chrome.storage`

## Install

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `extension/` folder

## Use

1. Log in to LinkedIn and open `https://www.linkedin.com/mynetwork/invite-connect/connections/`
2. The panel appears and starts automatically after a 5-second countdown — press **Durdur/Stop** to cancel
3. Leave the tab open; it stops when the list is empty, when you press Stop, or when you navigate away

### Configuration

Edit `AYARLAR` at the top of [`extension/content.js`](extension/content.js):

| Setting | Default | Meaning |
|---|---|---|
| `maksKaldirma` | `Infinity` | Max removals per session (set a number, e.g. `75`, to throttle) |
| `minBeklemeMs` / `maksBeklemeMs` | `250` / `700` | Random delay between removals, in ms |
| `geriSayimSn` | `5` | Auto-start countdown, in seconds |

**Recommended:** set `maksKaldirma` to ~75 and the delays to `1500`–`3000` ms if you care about your account. The fast, unlimited defaults are the most bot-looking configuration possible.

## How it works

The interesting part is surviving LinkedIn's UI churn. The extension tries, in order:

1. Known-good selectors captured from the current UI (e.g. the connections list container, `button[aria-label*="…"]` overflow triggers, `div[role="menuitem"]` entries, the native `<dialog>` confirmation)
2. Text matching by accessible name in both supported languages
3. A structural heuristic: walk up from each profile link to its row, then pick the icon-only button that is *not* Message/Follow/Connect

Clicks are dispatched as full pointer-event sequences (`pointerdown → mousedown → pointerup → mouseup → click`) because the current React-based UI ignores bare `.click()` calls. Failed targets are blacklisted so one broken row can't stall the loop.

## License

[MIT](LICENSE)

---

### Türkçe özet

Kendi LinkedIn bağlantılarını toplu kaldıran Chrome eklentisi. Kurulum: `chrome://extensions` → Geliştirici modu → Paketlenmemiş öğe yükle → `extension/` klasörü. Bağlantılar sayfasına girince sağ alttaki panel 5 saniye sonra otomatik başlar. **Kaldırılan bağlantılar geri alınamaz** ve bu tür otomasyon LinkedIn kullanım koşullarına aykırıdır; hesabın kısıtlanabilir. Kendi sorumluluğunda kullan.
