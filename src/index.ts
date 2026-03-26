import "dotenv/config";
import { Telegraf } from "telegraf";
import { openDb } from "./db.js";
import { registerCommands } from "./bot.js";
import { startPoller } from "./poller.js";
import { initCodexKeyPool } from "./codex.js";

function trimEnv(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let v = s.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v || undefined;
}

const token = trimEnv(process.env.TELEGRAM_BOT_TOKEN);
const codexKeyRaw = trimEnv(process.env.CODEX_API_KEY);

if (!token || !codexKeyRaw) {
  console.error(
    "Eksik ortam değişkeni: TELEGRAM_BOT_TOKEN ve CODEX_API_KEY gerekli."
  );
  process.exit(1);
}

try {
  initCodexKeyPool(codexKeyRaw);
} catch (e) {
  console.error(e);
  process.exit(1);
}

const db = openDb();
const bot = new Telegraf(token);

registerCommands(bot, db);
startPoller(bot, db);

function isConflict409(e: unknown): boolean {
  const err = e as { response?: { error_code?: number } };
  return err?.response?.error_code === 409;
}

const BOT_COMMANDS = [
  { command: "start", description: "Yardım ve bot durumu" },
  {
    command: "add",
    description: "Token ekle: /add 0x… veya aynı mesajda birden çok adres",
  },
  { command: "remove", description: "Listeden sil: /remove 0x…" },
  { command: "list", description: "Takip listesi ve son fiyatlar" },
  {
    command: "alert",
    description: "Fiyat uyarı eşiği %: /alert 5",
  },
  { command: "pause", description: "Takibi ve bildirimleri duraklat" },
  { command: "resume", description: "Takibi sürdür" },
] as const;

async function launchBot(): Promise<void> {
  const maxAttempts = 24;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.telegram.setMyCommands([...BOT_COMMANDS]);
      await bot.launch({ dropPendingUpdates: true });
      console.log("Bot çalışıyor (long polling).");
      return;
    } catch (e) {
      if (isConflict409(e) && attempt < maxAttempts) {
        const waitSec = Math.min(60, 5 + attempt * 5);
        console.warn(
          `409: başka bir getUpdates oturumu var. ${waitSec}s sonra tekrar (${attempt}/${maxAttempts})…`
        );
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      console.error(e);
      process.exit(1);
    }
  }
}

void launchBot();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
