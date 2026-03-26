import type { Context } from "telegraf";

/** Virgülle ayrılmış Telegram user id (özel sohbette chat.id = user id). Boş = herkes, kendi listesi. */
function parseBotUserIds(): number[] | undefined {
  const raw = process.env.TELEGRAM_BOT_USER_IDS?.trim();
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length ? ids : undefined;
}

/** Paylaşımlı SQLite chat_id; yoksa TELEGRAM_BOT_USER_IDS içindeki ilk id. */
function parseSharedStorageId(allowed: number[]): number | undefined {
  const raw = process.env.TELEGRAM_SHARED_STORAGE_ID?.trim();
  if (!raw) return allowed[0];
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) return allowed[0];
  if (!allowed.includes(id)) return allowed[0];
  return id;
}

export function getCommandDbChatId(ctx: Context):
  | { ok: true; dbChatId: number }
  | { ok: false; message: string } {
  const fromId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (fromId === undefined || chatId === undefined) {
    return { ok: false, message: "Oturum bilgisi alınamadı." };
  }

  const allowed = parseBotUserIds();
  if (allowed === undefined) {
    return { ok: true, dbChatId: chatId };
  }

  if (!allowed.includes(fromId)) {
    return { ok: false, message: "Bu botu kullanma yetkin yok." };
  }

  const dbChatId = parseSharedStorageId(allowed);
  if (dbChatId === undefined) {
    return { ok: true, dbChatId: chatId };
  }
  return { ok: true, dbChatId };
}

/**
 * Çoklu kullanıcı (beyaz liste) modunda poller yalnızca bu chat_id için çalışmalı;
 * aksi halde DB’de kalan eski chat_id satırlarıyla aynı uyarı birden fazla kez gider.
 */
export function getPollerPrimaryChatId(): number | undefined {
  const allowed = parseBotUserIds();
  if (!allowed?.length) return undefined;
  const id = parseSharedStorageId(allowed);
  return id;
}

/** Fiyat uyarısı: izin listesi varsa her üyeye DM; yoksa yalnızca depo chat_id. */
export function getAlertRecipientIds(storageChatId: number): number[] {
  const allowed = parseBotUserIds();
  if (!allowed?.length) return [storageChatId];
  return [...new Set(allowed)];
}
