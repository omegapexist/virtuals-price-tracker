import type { Telegraf } from "telegraf";
import type Database from "better-sqlite3";
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
  formatListDelta,
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

export function registerCommands(
  bot: Telegraf,
  db: Database.Database,
  codexKey: string
) {
  bot.command("add", async (ctx) => {
    const chatId = ctx.chat!.id;
    const addrs = parseAddressesFromAddCommand(ctx.message.text);

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
      batchSnaps = await fetchTokenSnapshots(codexKey, addrs);
    } catch (e) {
      await ctx.reply(`Codex hatası: ${escapeHtml((e as Error).message)}`, {
        parse_mode: "HTML",
      });
      return;
    }

    let added = 0;
    let duplicate = 0;
    const failLines: string[] = [];
    let onlyAdded: { addr: string; snap: TokenSnapshot } | null = null;

    for (const addr of addrs) {
      if (hasWatched(db, chatId, addr)) {
        duplicate++;
        continue;
      }

      let snap: TokenSnapshot | null | undefined = batchSnaps.get(addr);
      if (!snap) {
        try {
          snap = await fetchTokenForAdd(codexKey, addr);
        } catch (err) {
          failLines.push(
            `<code>${addr}</code> — ${escapeHtml((err as Error).message)}`
          );
          continue;
        }
      }

      if (!snap) {
        failLines.push(
          `<code>${addr}</code> — bulunamadı / indeks yok`
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
      if (addrs.length === 1) onlyAdded = { addr, snap };
    }

    if (onlyAdded) {
      const { addr, snap } = onlyAdded;
      await ctx.reply(
        [
          "Eklendi:",
          `🔹 ${escapeHtml(snap.name)} (${escapeHtml(snap.symbol)})`,
          `<code>${addr}</code>`,
          `Fiyat: ${formatUsdPrice(snap.priceUsd)}`,
          `FDV: ${formatFdvUsd(snap.fdvUsd)}`,
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    const parts = [
      "<b>Toplu ekleme özeti</b>",
      `Eklendi: ${added}`,
      `Zaten listede: ${duplicate}`,
      `Başarısız: ${failLines.length}`,
    ];
    if (failLines.length) {
      parts.push("", "<b>Hatalar</b>", ...failLines.slice(0, 15));
      if (failLines.length > 15) {
        parts.push(`… +${failLines.length - 15} satır`);
      }
    }

    let msg = parts.join("\n");
    if (msg.length > 4000) {
      msg = msg.slice(0, 3990) + "\n…";
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  bot.command("remove", async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const addr = parseAddress(parts[0]);
    if (!addr) {
      await ctx.reply("Kullanım: <code>/remove 0x...</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    const ok = removeWatched(db, ctx.chat!.id, addr);
    await ctx.reply(ok ? "Silindi." : "Listede yok.");
  });

  bot.command("list", async (ctx) => {
    const rows = listWatched(db, ctx.chat!.id);
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
      const deltaStr = formatListDelta(pct);
      const priceStr =
        t.price_usd != null ? formatUsdPrice(t.price_usd) : "—";
      const fdvStr = t.fdv_usd != null ? formatFdvUsd(t.fdv_usd) : "—";
      lines.push(
        `🔹 ${escapeHtml(t.name)} (${escapeHtml(t.symbol)})`,
        `<code>${t.address}</code>`,
        `Fiyat: ${priceStr}`,
        `Değişim: ${deltaStr} ${emoji}`,
        `FDV: ${fdvStr}`,
        ""
      );
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("alert", async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const n = parseFloat(parts[0]);
    if (!Number.isFinite(n) || n <= 0) {
      await ctx.reply("Kullanım: <code>/alert 5</code> (pozitif yüzde)", {
        parse_mode: "HTML",
      });
      return;
    }
    setAlertPercent(db, ctx.chat!.id, n);
    await ctx.reply(`Uyarı eşiği: %${n} (fiyat değişimi, mutlak değer).`);
  });

  bot.command("pause", async (ctx) => {
    setPaused(db, ctx.chat!.id, true);
    await ctx.reply("Takip durduruldu. /resume ile devam.");
  });

  bot.command("resume", async (ctx) => {
    setPaused(db, ctx.chat!.id, false);
    await ctx.reply("Takip devam ediyor.");
  });

  bot.command("start", async (ctx) => {
    getSettings(db, ctx.chat!.id);
    const p = isPaused(db, ctx.chat!.id);
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
