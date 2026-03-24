import type { Telegraf } from "telegraf";
import type Database from "better-sqlite3";
import { fetchTokenSnapshots, type TokenSnapshot } from "./codex.js";
import {
  advanceTokenSnapshot,
  allChatIdsWithTokens,
  getSettings,
  initTokenSnapshot,
  isPaused,
  listWatched,
} from "./db.js";
import {
  escapeHtml,
  formatAlertDelta,
  formatFdvUsd,
  formatUsdPrice,
} from "./format.js";

const INTERVAL_MS = 30_000;

export function startPoller(
  bot: Telegraf,
  db: Database.Database,
  codexKey: string
) {
  const tick = async () => {
    const chatIds = allChatIdsWithTokens(db);
    for (const chatId of chatIds) {
      if (isPaused(db, chatId)) continue;
      const tokens = listWatched(db, chatId);
      if (!tokens.length) continue;

      let snapshots: Map<string, TokenSnapshot>;
      try {
        snapshots = await fetchTokenSnapshots(
          codexKey,
          tokens.map((t) => t.address)
        );
      } catch (e) {
        console.error("Poller Codex:", e);
        continue;
      }

      const { alert_percent } = getSettings(db, chatId);

      for (const t of tokens) {
        const addr = t.address.toLowerCase();
        const s = snapshots.get(addr);
        if (!s) continue;

        const oldP = t.price_usd;
        const oldF = t.fdv_usd;

        if (oldP === null || oldP <= 0) {
          initTokenSnapshot(db, chatId, addr, s.priceUsd, s.fdvUsd);
          continue;
        }

        if (oldP > 0) {
          const pct = ((s.priceUsd - oldP) / oldP) * 100;
          if (Math.abs(pct) >= alert_percent) {
            const icon = pct > 0 ? "🚀" : "📉";
            const title = `🚨 ${escapeHtml(s.name)} (${escapeHtml(s.symbol)}) Hareketliliği! ${icon}`;
            const oldFdvStr =
              oldF != null && oldF > 0 ? formatFdvUsd(oldF) : "—";
            const newFdvStr = formatFdvUsd(s.fdvUsd);
            const body = [
              title,
              "",
              `Eski FDV: ${oldFdvStr}`,
              `Yeni FDV: ${newFdvStr}`,
              `Değişim: ${formatAlertDelta(pct)}`,
              `Güncel Fiyat: ${formatUsdPrice(s.priceUsd)}`,
              "",
              `<code>${addr}</code>`,
            ].join("\n");
            try {
              await bot.telegram.sendMessage(chatId, body, {
                parse_mode: "HTML",
              });
            } catch (err) {
              console.error("Telegram bildirim:", err);
            }
          }
        }

        advanceTokenSnapshot(db, chatId, addr, {
          price: s.priceUsd,
          fdv: s.fdvUsd,
        });
      }
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, INTERVAL_MS);
}
