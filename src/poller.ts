import { Markup, type Telegraf } from "telegraf";
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
  formatFdvUsd,
  formatListDeltaPercent,
  formatUsdPrice,
  pctChangeEmoji,
} from "./format.js";
import {
  getAlertRecipientIds,
  getPollerPrimaryChatId,
} from "./telegramScope.js";

function definedFiBaseUrl(addressLower: string): string {
  return `https://www.defined.fi/base/${addressLower}`;
}

function virtualsPrototypeUrl(addressLower: string): string {
  return `https://app.virtuals.io/prototypes/${addressLower}`;
}

const INTERVAL_MS = 15_000;

export function startPoller(bot: Telegraf, db: Database.Database) {
  // tick() async olduğu için setInterval üst üste binerek çift bildirim üretebilir.
  // Bu kilit aynı anda yalnızca bir tick çalıştırır.
  let tickInFlight = false;

  const tick = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const allWithTokens = allChatIdsWithTokens(db);
      const primary = getPollerPrimaryChatId();
      const chatIds =
        primary !== undefined && allWithTokens.includes(primary)
          ? [primary]
          : allWithTokens;

      for (const chatId of chatIds) {
        if (isPaused(db, chatId)) continue;
        const tokens = listWatched(db, chatId);
        if (!tokens.length) continue;

        let snapshots: Map<string, TokenSnapshot>;
        try {
          snapshots = await fetchTokenSnapshots(tokens.map((t) => t.address));
        } catch (e) {
          console.error("Poller Codex:", e);
          continue;
        }

        const rawTh = getSettings(db, chatId).alert_percent;
        const alert_percent = Number(rawTh);
        const threshold =
          Number.isFinite(alert_percent) && alert_percent > 0 ? alert_percent : 5;

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
            // Son poll → şimdi (≈15 sn)
            const stepPct = ((s.priceUsd - oldP) / oldP) * 100;
            // Bir önceki poll referansı → şimdi (≈30 sn; yavaş sürmeleri kaçırmama)
            const prevP = t.prev_price_usd;
            const swingPct =
              prevP != null && prevP > 0 ? ((s.priceUsd - prevP) / prevP) * 100 : 0;
            const stepTrig = Math.abs(stepPct) >= threshold;
            const swingTrig = prevP != null && prevP > 0 && Math.abs(swingPct) >= threshold;

            let pct: number | null = null;
            let baselineP = oldP;
            let baselineF = oldF;
            if (stepTrig && swingTrig) {
              if (Math.abs(stepPct) >= Math.abs(swingPct)) {
                pct = stepPct;
                baselineP = oldP;
                baselineF = oldF;
              } else {
                pct = swingPct;
                baselineP = prevP as number;
                baselineF = t.prev_fdv_usd ?? oldF;
              }
            } else if (stepTrig) {
              pct = stepPct;
              baselineP = oldP;
              baselineF = oldF;
            } else if (swingTrig) {
              pct = swingPct;
              baselineP = prevP as number;
              baselineF = t.prev_fdv_usd ?? oldF;
            }

            if (pct != null) {
              const dirEmoji = pctChangeEmoji(pct);
              const title = `🚨 ${escapeHtml(s.name)} (${escapeHtml(s.symbol)})! ${dirEmoji}`;
              const oldPriceStr = formatUsdPrice(baselineP);
              const newPriceStr = formatUsdPrice(s.priceUsd);
              const oldFdvStr =
                baselineF != null && baselineF > 0 ? formatFdvUsd(baselineF) : "—";
              const newFdvStr = s.fdvUsd > 0 ? formatFdvUsd(s.fdvUsd) : "—";
              const defUrl = definedFiBaseUrl(addr);
              const vUrl = virtualsPrototypeUrl(addr);
              const body = [
                title,
                "",
                `📊 Değişim: ${dirEmoji} ${formatListDeltaPercent(pct)}`,
                `💰 Eski Fiyat: ${oldPriceStr}`,
                `💰 Yeni Fiyat: ${newPriceStr}`,
                `📈 Eski FDV: ${oldFdvStr}`,
                `📈 Yeni FDV: ${newFdvStr}`,
                "",
                "🔗 Contract:",
                `<code>${addr}</code>`,
              ].join("\n");
              const recipients = getAlertRecipientIds(chatId);
              for (const to of recipients) {
                try {
                  await bot.telegram.sendMessage(to, body, {
                    parse_mode: "HTML",
                    reply_markup: Markup.inlineKeyboard([
                      [
                        Markup.button.url("📊 Defined.fi'de aç", defUrl),
                        Markup.button.url("⚡ Virtuals", vUrl),
                      ],
                    ]).reply_markup,
                  });
                } catch (err) {
                  console.error("Telegram bildirim:", to, err);
                }
              }
            }
          }

          advanceTokenSnapshot(db, chatId, addr, {
            price: s.priceUsd,
            fdv: s.fdvUsd,
          });
        }
      }
    } finally {
      tickInFlight = false;
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, INTERVAL_MS);
}
