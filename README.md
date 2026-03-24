# Virtuals Price Tracker

Base ağındaki tokenleri takip eden Telegram botu (Codex GraphQL, SQLite).

## Gereksinimler

- **Node.js** 20 veya üzeri ([nodejs.org](https://nodejs.org/) veya `nvm`)
- **npm** (Node ile gelir)
- **`better-sqlite3`** yerel derleme gerektirir:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Windows:** “Desktop development with C++” (Visual Studio Build Tools) veya [windows-build-tools](https://github.com/nodejs/node-gyp#on-windows)
  - **Linux:** `build-essential`, `python3` (ör. `sudo apt install build-essential python3`)

## Kurulum (başka bilgisayar)

```bash
git clone git@github.com:omegapexist/virtuals-price-tracker.git
cd virtuals-price-tracker
npm install
cp .env.example .env
# .env içine TELEGRAM_BOT_TOKEN ve CODEX_API_KEY yaz
npm run build
npm start
```

Geliştirme (kaynak TS, otomatik yenileme):

```bash
npm run dev
```

## Ortam değişkenleri

| Değişken | Açıklama |
|----------|----------|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) |
| `CODEX_API_KEY` | [Codex dashboard](https://dashboard.codex.io) |
| `CODEX_GRAPHQL_URL` | İsteğe bağlı; varsayılan `https://graph.codex.io/graphql` |

`.env` repoda yok; sadece `.env.example` şablonu var.

## Komutlar (Telegram)

`/add`, `/remove`, `/list`, `/alert`, `/pause`, `/resume`, `/start`
