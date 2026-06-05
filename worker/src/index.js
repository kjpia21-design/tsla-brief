/**
 * Tesla Brief!ng — TSLA price worker
 *
 * Cloudflare Workers (standalone) — 5분 cron + HTTP GET endpoint.
 *
 *   Cron (every 5 minutes)    -> Yahoo Finance fetch -> KV put (key: "tsla:kpi")
 *   GET /  또는 /kpi          -> KV get -> JSON 반환 (CORS 허용)
 *
 * KV namespace binding: PRICE_KV (wrangler.toml 에서 설정)
 * Cron trigger:         wrangler.toml [triggers] crons (every 5 minutes)
 *
 * 출력 스키마: 기존 data/kpi.json 과 동일 (클라이언트 폴링 변경 최소화)
 */

const SYMBOL = "TSLA";
const KV_KEY = "tsla:kpi";

// GitHub Actions RSS 페치 강제 트리거 — GitHub 무료 cron 이 새벽에 누락되는 문제 우회.
// 안정적인 5분 Worker cron 에서 KV 타임스탬프로 ~2시간마다 1회만 workflow_dispatch 발사.
const GH_OWNER = "kjpia21-design";
const GH_REPO = "tsla-brief";
const GH_WORKFLOW = "fetch-news.yml";
const GH_REF = "master";
const GH_DISPATCH_KEY = "gh:lastdispatch";
const GH_DISPATCH_INTERVAL_MS = 115 * 60 * 1000; // ~2h (5분 cron 단위라 115분이면 다음 tick 에 ~2h)

// Yahoo Finance 두 호스트 폴백 (rate-limit 회피).
// includePrePost=true + 2분봉 → 프리/애프터장 체결가까지 close 배열에 포함됨.
const URLS = [
  `https://query2.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=2m&range=1d&includePrePost=true`,
  `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=2m&range=1d&includePrePost=true`,
];

// CORS — 라이브 도메인 + 미리보기 둘 다 허용
const ALLOWED_ORIGINS = [
  "https://teslabriefing.com",
  "https://www.teslabriefing.com",
  "https://tesla-briefing.pages.dev",
];

export default {
  /** Scheduled cron trigger — 5분마다 Yahoo Finance 갱신 → KV (+ ~2h마다 RSS 페치 트리거) */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStore(env).catch((e) => {
      console.error("[scheduled] price fail:", e.message);
    }));
    ctx.waitUntil(maybeDispatchFetch(env).catch((e) => {
      console.error("[scheduled] gh dispatch fail:", e.message);
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
  const reg = m.regularMarketPrice;
  const prevClose = m.chartPreviousClose ?? m.previousClose;
  if (typeof reg !== "number" || typeof prevClose !== "number") {
    throw new Error("price fields missing");
  }
  const ms = deriveMarketState(m);

  // 연장거래 마지막 체결가 — includePrePost 배열의 마지막 유효 close.
  const closes = result?.indicators?.quote?.[0]?.close || [];
  let ext = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (typeof closes[i] === "number") { ext = closes[i]; break; }
  }

  // 시장 상태별 표시가 + 변동 기준:
  //  · 프리장  → 프리 체결가, 전일 종가 대비
  //  · 애프터  → 애프터 체결가, 당일 정규 종가 대비
  //  · 정규/마감 → 정규가, 전일 종가 대비
  let price = reg, base = prevClose;
  if (ms.short === "PRE" && ext != null) { price = ext; base = prevClose; }
  else if (ms.short === "POST" && ext != null) { price = ext; base = reg; }
  const change = price - base;
  const changePct = (change / base) * 100;

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

/**
 * GitHub Actions fetch-news 워크플로우를 workflow_dispatch 로 강제 트리거.
 * KV 에 마지막 발사 시각을 저장해 ~2시간마다 1회만 실행 (5분 cron 안에서 게이팅).
 * GH_DISPATCH_TOKEN secret 미설정 시 조용히 skip.
 */
async function maybeDispatchFetch(env) {
  const token = env.GH_DISPATCH_TOKEN;
  if (!token) return; // secret 미설정 → 비활성 (기존 동작 유지)

  const now = Date.now();
  const last = Number(await env.PRICE_KV.get(GH_DISPATCH_KEY)) || 0;
  if (now - last < GH_DISPATCH_INTERVAL_MS) return; // 아직 ~2h 안 지남

  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tesla-briefing-price-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: GH_REF }),
  });

  // workflow_dispatch 성공 = 204 No Content. 성공 시에만 타임스탬프 갱신 → 실패 시 다음 tick 재시도.
  if (res.status === 204) {
    await env.PRICE_KV.put(GH_DISPATCH_KEY, String(now));
    console.log("[gh dispatch] fetch-news 트리거 OK");
  } else {
    const body = await res.text().catch(() => "");
    throw new Error(`gh dispatch HTTP ${res.status} ${body.slice(0, 200)}`);
  }
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
