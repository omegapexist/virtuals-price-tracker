import type { Telegraf } from "telegraf";
import type Database from "better-sqlite3";
import { getCommandDbChatId } from "./telegramScope.js";
import {
  addWatched,
  getSettings,
  hasWatched,
  listWatched,
  removeWatched,
  setAlertPercent,
  setPaused,
  isPaused,
} from "./db.js";
import {
  fetchTokenForAdd,
  fetchTokenSnapshots,
  type TokenSnapshot,
} from "./codex.js";
import {
  escapeHtml,
  formatFdvUsd,
  formatListDeltaPercent,
  formatUsdPrice,
  pctChangeEmoji,
} from "./format.js";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const ADDR_FIND_RE = /0x[a-fA-F0-9]{40}/gi;
const MAX_BULK_ADD = 80;

function parseAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!ADDR_RE.test(t)) return null;
  return t.toLowerCase();
}

/** /add veya /add@Bot sonrası metindeki tüm Base benzeri adresler */
function parseAddressesFromAddCommand(fullText: string): string[] {
  const rest = fullText.replace(/^\/add(?:@\w+)?\s*/i, "");
  const m = rest.match(ADDR_FIND_RE) ?? [];
  return [...new Set(m.map((x) => x.toLowerCase()))];
}

export function registerCommands(bot: Telegraf, db: Database.Database) {
  bot.command("add", async (ctx) => {
    const scope = getCommandDbChatId(ctx);
    if (!scope.ok) {
      await ctx.reply(scope.message);
      return;
    }
    const chatId = scope.dbChatId;
    const rawText = ctx.message?.text ?? "";
    const addrs = parseAddressesFromAddCommand(rawText);

    if (addrs.length === 0) {
      await ctx.reply(
        [
          "Kullanım:",
          "<code>/add 0x...</code> — tek adres",
          "veya aynı mesajda birden çok <code>0x</code> (boşluk / satır fark etmez), en fazla",
          `${MAX_BULK_ADD} adres.`,
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (addrs.length > MAX_BULK_ADD) {
      await ctx.reply(
        `En fazla ${MAX_BULK_ADD} adres. Şu an: ${addrs.length}.`
      );
      return;
    }

    let batchSnaps: Map<string, TokenSnapshot>;
    try {
      batchSnaps = await fetchTokenSnapshots(addrs);
    } catch (e) {
      await ctx.reply(`Codex hatası: ${escapeHtml((e as Error).message)}`, {
        parse_mode: "HTML",
      });
      return;
    }

    let added = 0;
    let duplicate = 0;
    const failLines: string[] = [];
    const addedItems: { addr: string; snap: TokenSnapshot }[] = [];

    for (const addr of addrs) {
      if (hasWatched(db, chatId, addr)) {
        duplicate++;
        continue;
      }

      let snap: TokenSnapshot | null | undefined = batchSnaps.get(addr);
      if (!snap) {
        try {
          snap = await fetchTokenForAdd(addr);
        } catch (err) {
          failLines.push(
            `<code>${addr}</code> — ${escapeHtml((err as Error).message)}`
          );
          continue;
        }
      }

      if (!snap) {
        const b = `https://basescan.org/token/${addr}`;
        failLines.push(
          `<code>${addr}</code> — Codex Base (8453) veri yok (yanlış ağ / henüz takas indeksi yok / çok yeni). <a href="${b}">BaseScan</a>`
        );
        continue;
      }

      addWatched(db, {
        chat_id: chatId,
        address: addr,
        name: snap.name,
        symbol: snap.symbol,
      });
      added++;
      addedItems.push({ addr, snap });
    }

    if (addedItems.length > 0) {
      const blocks = addedItems.map(
        ({ addr, snap }) =>
          [
            `✅ ${escapeHtml(snap.name)} (${escapeHtml(snap.symbol)})`,
            `💰 ${formatUsdPrice(snap.priceUsd)} | 📈 FDV: ${formatFdvUsd(snap.fdvUsd)}`,
            `<code>${addr}</code>`,
          ].join("\n")
      );
      const footer: string[] = [];
      if (duplicate > 0) footer.push(`ℹ️ Zaten listede: ${duplicate}`);
      if (failLines.length) {
        footer.push("", "<b>Hatalar</b>", ...failLines.slice(0, 12));
        if (failLines.length > 12) {
          footer.push(`… +${failLines.length - 12}`);
        }
      }
      let msg = ["🟢 <b>Eklenen Tokenler:</b>", "", ...blocks].join("\n\n");
      if (footer.length) msg += "\n\n" + footer.join("\n");
      if (msg.length > 4000) msg = msg.slice(0, 3990) + "\n…";
      await ctx.reply(msg, { parse_mode: "HTML" });
      return;
    }

    if (
      added === 0 &&
      duplicate === addrs.length &&
      failLines.length === 0
    ) {
      if (addrs.length === 1) {
        await ctx.reply(
          [
            "ℹ️ Bu adres <b>zaten takip listende</b>.",
            `<code>${addrs[0]}</code>`,
            "/list ile doğrulayabilirsin.",
          ].join("\n"),
          { parse_mode: "HTML" }
        );
        return;
      }
      await ctx.reply(
        `ℹ️ Yazdığın <b>tüm adresler</b> zaten listede (${duplicate} adet). /list`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const parts = [
      "Hiç token eklenmedi.",
      `Zaten listede: ${duplicate}`,
      `Başarısız: ${failLines.length}`,
    ];
    if (failLines.length) {
      parts.push("", "<b>Hatalar</b>", ...failLines.slice(0, 15));
      if (failLines.length > 15) parts.push(`… +${failLines.length - 15}`);
    }
    await ctx.reply(parts.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("remove", async (ctx) => {
    const scope = getCommandDbChatId(ctx);
    if (!scope.ok) {
      await ctx.reply(scope.message);
      return;
    }
    const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const addr = parseAddress(parts[0]);
    if (!addr) {
      await ctx.reply("Kullanım: <code>/remove 0x...</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    const ok = removeWatched(db, scope.dbChatId, addr);
    await ctx.reply(ok ? "Silindi." : "Listede yok.");
  });

  bot.command("list", async (ctx) => {
    const scope = getCommandDbChatId(ctx);
    if (!scope.ok) {
      await ctx.reply(scope.message);
      return;
    }
    const rows = listWatched(db, scope.dbChatId);
    if (!rows.length) {
      await ctx.reply("Liste boş. <code>/add 0x...</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    const lines: string[] = ["📋 <b>Token Listesi</b>", ""];
    for (const t of rows) {
      const pct =
        t.prev_price_usd != null &&
        t.prev_price_usd > 0 &&
        t.price_usd != null
          ? ((t.price_usd - t.prev_price_usd) / t.prev_price_usd) * 100
          : 0;
      const emoji = pctChangeEmoji(pct);
      const deltaStr = formatListDeltaPercent(pct);
      const priceStr =
        t.price_usd != null ? formatUsdPrice(t.price_usd) : "—";
      const fdvStr = t.fdv_usd != null ? formatFdvUsd(t.fdv_usd) : "—";
      lines.push(
        `🔹 ${escapeHtml(t.name)} (${escapeHtml(t.symbol)})`,
        `<code>${t.address}</code>`,
        `💰 Fiyat: ${priceStr}`,
        `📊 Değişim: ${emoji} ${deltaStr}`,
        `📈 FDV: ${fdvStr}`,
        ""
      );
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("alert", async (ctx) => {
    const scope = getCommandDbChatId(ctx);
    if (!scope.ok) {
      await ctx.reply(scope.message);
      return;
    }
    const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const n = parseFloat(parts[0]);
    if (!Number.isFinite(n) || n <= 0) {
      await ctx.reply("Kullanım: <code>/alert 5</code> (pozitif yüzde)", {
        parse_mode: "HTML",
      });
      return;
    }
    setAlertPercent(db, scope.dbChatId, n);
    await ctx.reply(`Uyarı eşiği: %${n} (fiyat değişimi, mutlak değer).`);
  });

  bot.command("pause", async (ctx) => {
    const scope = getCommandDbChatId(ctx);
    if (!scope.ok) {
      await ctx.reply(scope.message);
      return;
    }
    setPaused(db, scope.dbChatId, true);
    await ctx.reply("Takip durduruldu. /resume ile devam.");
  });

  bot.command("resume", async (ctx) => {
    const scope = getCommandDbChatId(ctx);
    if (!scope.ok) {
      await ctx.reply(scope.message);
      return;
    }
    setPaused(db, scope.dbChatId, false);
    await ctx.reply("Takip devam ediyor.");
  });

  bot.command("start", async (ctx) => {
    const scope = getCommandDbChatId(ctx);
    if (!scope.ok) {
      await ctx.reply(scope.message);
      return;
    }
    getSettings(db, scope.dbChatId);
    const p = isPaused(db, scope.dbChatId);
    await ctx.reply(
      [
        "Virtuals Token Tracker (Base)",
        "",
        "<code>/add &lt;address&gt;</code> — tek veya aynı mesajda birden çok 0x adresi",
        "<code>/remove &lt;address&gt;</code> — sil",
        "<code>/list</code> — liste",
        "<code>/alert &lt;n&gt;</code> — uyarı %",
        "<code>/pause</code> / <code>/resume</code>",
        "",
        p ? "Durum: duraklatıldı" : "Durum: aktif",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  });
}
