const DEFAULT_CODEX_URL = "https://graph.codex.io/graphql";
export const BASE_NETWORK_ID = 8453;
const BATCH = 25;

const keyPool: { keys: string[]; index: number } = { keys: [], index: 0 };

/** Virgül veya satır sonu ile birden fazla anahtar (kota dolunca sıradaki). */
export function parseCodexApiKeys(raw: string): string[] {
  return raw
    .split(/[,\n\r]+/)
    .map((s) => normalizeCodexApiKey(s.trim()))
    .filter((k) => k.length > 0);
}

export function initCodexKeyPool(raw: string): void {
  const keys = parseCodexApiKeys(raw);
  if (!keys.length) {
    throw new Error("CODEX_API_KEY boş veya geçersiz.");
  }
  keyPool.keys = keys;
  keyPool.index = 0;
}

export class CodexError extends Error {
  declare readonly name: "CodexError";
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly quotaLike: boolean
  ) {
    super(message);
    this.name = "CodexError";
  }
}

function quotaLikeFromMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return /limit|quota|exceed|rate|throttl|too many|credit|usage|429|capacity|monthly|denied.*plan/i.test(
    m
  );
}

function isQuotaLike(err: unknown): boolean {
  if (err instanceof CodexError) return err.quotaLike;
  if (err instanceof Error) return quotaLikeFromMessage(err.message);
  return false;
}

/** .env'den gelen tırnak/boşluk; JWT için Bearer */
export function normalizeCodexApiKey(raw: string): string {
  let k = raw.trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1).trim();
  }
  if (k.toLowerCase().startsWith("bearer ")) return k;
  if (k.startsWith("eyJ")) return `Bearer ${k}`;
  return k;
}

function codexGraphqlUrl(): string {
  return (process.env.CODEX_GRAPHQL_URL || DEFAULT_CODEX_URL).trim();
}

export type TokenSnapshot = {
  address: string;
  name: string;
  symbol: string;
  priceUsd: number;
  fdvUsd: number;
};

async function gqlOneKey<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const url = codexGraphqlUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: apiKey,
      "User-Agent": "virtuals-price-tracker/1.0",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  const ct = res.headers.get("content-type") || "";

  if (!text.trim() || text.trimStart().startsWith("<")) {
    const hint =
      text.includes("<html")
        ? " Sunucu HTML döndü (proxy, yanlış URL veya engel). CODEX_GRAPHQL_URL ve ağını kontrol et."
        : "";
    const ql = res.status === 429 || res.status === 402;
    throw new CodexError(
      `Codex HTTP ${res.status} (${ct || "bilinmeyen içerik türü"}).${hint} İlk karakterler: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
      res.status,
      ql
    );
  }

  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
  } catch {
    const ql = res.status === 429 || res.status === 402;
    throw new CodexError(
      `Codex yanıtı JSON değil (${res.status}). Başlangıç: ${text.slice(0, 160).replace(/\s+/g, " ")}`,
      res.status,
      ql
    );
  }

  if (!res.ok) {
    const msg =
      body.errors?.map((e) => e.message).join("; ") ||
      text.slice(0, 300).replace(/\s+/g, " ");
    const ql =
      res.status === 429 ||
      res.status === 402 ||
      quotaLikeFromMessage(msg);
    throw new CodexError(`Codex HTTP ${res.status}: ${msg}`, res.status, ql);
  }

  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("; ");
    throw new CodexError(msg, res.status, quotaLikeFromMessage(msg));
  }
  if (!body.data) throw new CodexError("Codex: boş yanıt", res.status, false);
  return body.data;
}

async function gqlPool<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const { keys } = keyPool;
  if (!keys.length) {
    throw new Error("Codex anahtar havuzu boş; initCodexKeyPool çağrılmadı.");
  }
  const start = keyPool.index;
  let last: unknown;
  for (let o = 0; o < keys.length; o++) {
    const i = (start + o) % keys.length;
    try {
      const data = await gqlOneKey<T>(keys[i], query, variables);
      keyPool.index = i;
      return data;
    } catch (e) {
      last = e;
      if (isQuotaLike(e)) {
        console.warn(
          `[Codex] Anahtar #${i + 1}/${keys.length} kota/limit; sıradaki deneniyor.`
        );
        continue;
      }
      throw e;
    }
  }
  throw last instanceof Error
    ? last
    : new Error("Tüm Codex anahtarları başarısız.");
}

const FILTER_TOKENS_RESULT = `results {
      token { address name symbol }
      priceUSD
      marketCap
    }`;

/** filterTokens: fiyat + marketCap (FDV gösterimi için) */
export async function fetchTokenSnapshots(
  addresses: string[]
): Promise<Map<string, TokenSnapshot>> {
  const addrs = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const query = `query FilterTokens($tokens: [String!]!, $limit: Int!) {
    filterTokens(tokens: $tokens, limit: $limit) {
      ${FILTER_TOKENS_RESULT}
    }
  }`;
  return runFilterTokensBatches(addrs, query, (chunk, lim) => ({
    tokens: chunk,
    limit: lim,
  }));
}

/** scam/markalı tokenler filterTokens’ta varsayılan filtreyle düşebilir */
async function fetchTokenSnapshotsIncludeScams(
  addresses: string[]
): Promise<Map<string, TokenSnapshot>> {
  const addrs = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const query = `query FilterTokensScam($tokens: [String!]!, $limit: Int!) {
    filterTokens(tokens: $tokens, limit: $limit, filters: { includeScams: true }) {
      ${FILTER_TOKENS_RESULT}
    }
  }`;
  try {
    return await runFilterTokensBatches(addrs, query, (chunk, lim) => ({
      tokens: chunk,
      limit: lim,
    }));
  } catch {
    return new Map();
  }
}

async function runFilterTokensBatches(
  addrs: string[],
  query: string,
  vars: (
    chunk: string[],
    limit: number
  ) => Record<string, unknown>
): Promise<Map<string, TokenSnapshot>> {
  const out = new Map<string, TokenSnapshot>();
  for (let i = 0; i < addrs.length; i += BATCH) {
    const chunk = addrs.slice(i, i + BATCH).map((a) => `${a}:${BASE_NETWORK_ID}`);
    const data = await gqlPool<{
      filterTokens: {
        results: {
          token: { address: string; name: string; symbol: string };
          priceUSD: string;
          marketCap: string;
        }[];
      };
    }>(query, vars(chunk, chunk.length));

    for (const r of data.filterTokens.results) {
      const addr = r.token.address.toLowerCase();
      out.set(addr, {
        address: addr,
        name: r.token.name ?? "—",
        symbol: r.token.symbol ?? "—",
        priceUsd: parseFloat(r.priceUSD) || 0,
        fdvUsd: parseFloat(r.marketCap) || 0,
      });
    }
  }
  return out;
}

async function fetchTokenPriceUsd(addressLower: string): Promise<number> {
  const pq = `query P($inputs: [GetPriceInput!]!) {
    getTokenPrices(inputs: $inputs) { priceUsd }
  }`;
  const pdata = await gqlPool<{
    getTokenPrices: { priceUsd: number }[];
  }>(pq, {
    inputs: [{ address: addressLower, networkId: BASE_NETWORK_ID }],
  });
  return pdata.getTokenPrices[0]?.priceUsd ?? 0;
}

export async function fetchTokenMeta(
  address: string
): Promise<{ name: string; symbol: string } | null> {
  const q = `query T($input: TokenInput!) {
    token(input: $input) { name symbol address }
  }`;
  const data = await gqlPool<{
    token: { name: string; symbol: string; address: string } | null;
  }>(q, {
    input: { address: address.toLowerCase(), networkId: BASE_NETWORK_ID },
  });
  if (!data.token) return null;
  return { name: data.token.name ?? "—", symbol: data.token.symbol ?? "—" };
}

/**
 * Ekleme: filterTokens → (yedek) includeScams → token + getTokenPrices paralel;
 * meta yok ama fiyat varsa sentetik isimle yine eklenir (Codex fiyat üretiyorsa).
 */
export async function fetchTokenForAdd(
  address: string
): Promise<TokenSnapshot | null> {
  const addr = address.toLowerCase();

  let hit = (await fetchTokenSnapshots([addr])).get(addr);
  if (hit) return hit;

  const scamHit = (await fetchTokenSnapshotsIncludeScams([addr])).get(addr);
  if (scamHit) return scamHit;

  const [meta, priceUsd] = await Promise.all([
    fetchTokenMeta(addr),
    fetchTokenPriceUsd(addr),
  ]);

  if (meta) {
    return {
      address: addr,
      name: meta.name,
      symbol: meta.symbol,
      priceUsd,
      fdvUsd: 0,
    };
  }

  if (priceUsd > 0) {
    const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    return {
      address: addr,
      name: `Token ${short}`,
      symbol: "—",
      priceUsd,
      fdvUsd: 0,
    };
  }

  return null;
}
