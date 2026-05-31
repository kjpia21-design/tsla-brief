/**
 * Tesla Brief!ng — TSLA price worker
 *
 * Cloudflare Workers (standalone) — 5분 cron + HTTP GET endpoint.
 *
 *   Cron (*/5 * * * *)        → Yahoo Finance fetch → KV put (key: "tsla:kpi")
 *   GET /  또는 /kpi          → KV get → JSON 반환 (CORS 허용)
 *
 * KV namespace binding: PRICE_KV (wrangler.toml 에서 설정)
 * Cron trigger:         wrangler.toml [triggers] crons = ["*/5 * * * *"]
 *
 * 출력 스키마: 기존 data/kpi.json 과 동일 (클라이언트 폴링 변경 최소화)
 */

const SYMBOL = "TSLA";
const KV_KEY = "tsla:kpi";

// Yahoo Finance 두 호스트 폴백 (rate-limit 회피)
const URLS = [
  `https://query2.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=1d&range=1d`,
  `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=1d&range=1d`,
];

// CORS — 라이브 도메인 + 미리보기 둘 다 허용
const ALLOWED_ORIGINS = [
  "https://teslabriefing.com",
  "https://www.teslabriefing.com",
  "https://tesla-briefing.pages.dev",
];

export default {
  /** Scheduled cron trigger — 5분마다 Yahoo Finance 갱신 → KV */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStore(env).catch((e) => {
      console.error("[scheduled] fail:", e.message);
    }));
  },

  /** HTTP GET — KV 에서 읽어 JSON 반환. 없으면 즉시 fetch 후 저장. */
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(corsOrigin),
      });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      let cached = await env.PRICE_KV.get(KV_KEY);
      if (!cached) {
        // 첫 호출 또는 KV 비어있음 → 즉시 fetch
        const fresh = await fetchAndStore(env);
        cached = JSON.stringify(fresh);
      }
      return new Response(cached, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60", // 클라이언트·CDN 1분 캐시
          ...corsHeaders(corsOrigin),
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders(corsOrigin),
        },
      });
    }
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/** Yahoo Finance fetch + 파싱 + KV 저장. data/kpi.json 과 동일 스키마. */
async function fetchAndStore(env) {
  const data = await fetchYahoo();
  const result = data?.chart?.result?.[0];
  if (!result?.meta) throw new Error("invalid yahoo response shape");

  const m = result.meta;
  const price = m.regularMarketPrice;
  const prevClose = m.chartPreviousClose ?? m.previousClose;
  if (typeof price !== "number" || typeof prevClose !== "number") {
    throw new Error("price fields missing");
  }
  const change = price - prevClose;
  const changePct = (change / prevClose) * 100;
  const ms = deriveMarketState(m);

  const out = {
    asOf: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    symbol: m.symbol || SYMBOL,
    price: round2(price),
    prevClose: round2(prevClose),
    change: round2(change),
    changePct: round2(changePct),
    dayHigh: round2(m.regularMarketDayHigh),
    dayLow: round2(m.regularMarketDayLow),
    range52WHigh: round2(m.fiftyTwoWeekHigh),
    range52WLow: round2(m.fiftyTwoWeekLow),
    marketState: ms.state,
    marketStateLabel: ms.label,
    marketStateShort: ms.short,
    currency: m.currency || "USD",
    exchangeName: m.exchangeName || "",
    marketTime: m.regularMarketTime,
  };

  await env.PRICE_KV.put(KV_KEY, JSON.stringify(out), {
    expirationTtl: 3600, // 1시간 후 TTL (cron 이 매 5분 갱신하므로 안전)
  });
  return out;
}

async function fetchYahoo() {
  let lastErr = null;
  for (const url of URLS) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        cf: { cacheTtl: 60, cacheEverything: true }, // Cloudflare 자체 캐시
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all endpoints failed");
}

// 시장 상태 판정 — Yahoo currentTradingPeriod + 현재 시각
function deriveMarketState(meta) {
  const now = Math.floor(Date.now() / 1000);
  const ctp = meta?.currentTradingPeriod || {};
  const pre = ctp.pre || {};
  const reg = ctp.regular || {};
  const post = ctp.post || {};

  if (now >= reg.start && now < reg.end) {
    return { state: "REG", label: "정규장", short: "REG" };
  }
  if (now >= pre.start && now < pre.end) {
    return { state: "PRE", label: "프리장", short: "PRE" };
  }
  if (now >= post.start && now < post.end) {
    return { state: "POST", label: "애프터", short: "POST" };
  }
  return { state: "CLOSED", label: "장 마감", short: "CLOSED" };
}

function round2(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}
