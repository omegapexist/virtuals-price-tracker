const DEFAULT_CODEX_URL = "https://graph.codex.io/graphql";
export const BASE_NETWORK_ID = 8453;
const BATCH = 25;

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

async function gql<T>(
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
    throw new Error(
      `Codex HTTP ${res.status} (${ct || "bilinmeyen içerik türü"}).${hint} İlk karakterler: ${text.slice(0, 120).replace(/\s+/g, " ")}`
    );
  }

  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
  } catch {
    throw new Error(
      `Codex yanıtı JSON değil (${res.status}). Başlangıç: ${text.slice(0, 160).replace(/\s+/g, " ")}`
    );
  }

  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data) throw new Error("Codex: boş yanıt");
  return body.data;
}

/** filterTokens: fiyat + marketCap (FDV gösterimi için) */
export async function fetchTokenSnapshots(
  apiKey: string,
  addresses: string[]
): Promise<Map<string, TokenSnapshot>> {
  const out = new Map<string, TokenSnapshot>();
  const addrs = [...new Set(addresses.map((a) => a.toLowerCase()))];

  const query = `query FilterTokens($tokens: [String!]!, $limit: Int!) {
    filterTokens(tokens: $tokens, limit: $limit) {
      results {
        token { address name symbol }
        priceUSD
        marketCap
      }
    }
  }`;

  for (let i = 0; i < addrs.length; i += BATCH) {
    const chunk = addrs.slice(i, i + BATCH).map((a) => `${a}:${BASE_NETWORK_ID}`);
    const data = await gql<{
      filterTokens: {
        results: {
          token: { address: string; name: string; symbol: string };
          priceUSD: string;
          marketCap: string;
        }[];
      };
    }>(apiKey, query, { tokens: chunk, limit: chunk.length });

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

export async function fetchTokenMeta(
  apiKey: string,
  address: string
): Promise<{ name: string; symbol: string } | null> {
  const q = `query T($input: TokenInput!) {
    token(input: $input) { name symbol address }
  }`;
  const data = await gql<{
    token: { name: string; symbol: string; address: string } | null;
  }>(apiKey, q, {
    input: { address: address.toLowerCase(), networkId: BASE_NETWORK_ID },
  });
  if (!data.token) return null;
  return { name: data.token.name ?? "—", symbol: data.token.symbol ?? "—" };
}

/** filterTokens boş dönerse (henüz indeks yok) meta + getTokenPrices ile dene */
export async function fetchTokenForAdd(
  apiKey: string,
  address: string
): Promise<TokenSnapshot | null> {
  const addr = address.toLowerCase();
  const batch = await fetchTokenSnapshots(apiKey, [addr]);
  const hit = batch.get(addr);
  if (hit) return hit;

  const meta = await fetchTokenMeta(apiKey, addr);
  if (!meta) return null;

  const pq = `query P($inputs: [GetPriceInput!]!) {
    getTokenPrices(inputs: $inputs) { priceUsd }
  }`;
  const pdata = await gql<{
    getTokenPrices: { priceUsd: number }[];
  }>(apiKey, pq, {
    inputs: [{ address: addr, networkId: BASE_NETWORK_ID }],
  });
  const priceUsd = pdata.getTokenPrices[0]?.priceUsd ?? 0;
  return {
    address: addr,
    name: meta.name,
    symbol: meta.symbol,
    priceUsd,
    fdvUsd: 0,
  };
}
