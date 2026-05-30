#!/usr/bin/env node
/**
 * TSLA Brief — 가격 정보 페처 (Yahoo Finance)
 *
 *   node scripts/fetch-price.mjs
 *
 * Yahoo Finance v8/chart 무료 endpoint 호출 → data/kpi.json 갱신.
 * 의존성 0. Node 22+ 권장. cron 으로 1분~5분 주기 실행 가정.
 *
 * 출력 스키마 (data/kpi.json):
 *   {
 *     asOf: "2026-05-30 13:50 UTC",
 *     price: 435.79,            // 정규장 마지막 가격 (USD)
 *     prevClose: 442.10,        // 직전 정규장 종가
 *     change: -6.31,            // price - prevClose
 *     changePct: -1.4274,       // change / prevClose * 100
 *     dayHigh: 441.07,
 *     dayLow: 428.20,
 *     range52WHigh: 498.83,
 *     range52WLow: 273.21,
 *     marketState: "CLOSED",    // PRE | REG | POST | CLOSED
 *     marketStateLabel: "장 마감",  // 한국어 라벨
 *     currency: "USD",
 *     exchangeName: "NMS",
 *     marketTime: 1780084800    // Unix sec
 *   }
 *
 * 네트워크 실패 시 기존 kpi.json 보존 (덮어쓰기 안 함).
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_PATH = path.join(ROOT, "data", "kpi.json");

const SYMBOL = "TSLA";
// query1/query2 둘 다 같은 데이터. 어느 한쪽이 rate limit (429) 걸리면 다른 쪽으로 폴백.
const URLS = [
  `https://query2.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=1d&range=1d`,
  `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=1d&range=1d`,
];

// ─────────────────────────────────────────────────────────
// 시장 상태 판정 — currentTradingPeriod + 현재 시각으로 계산.
//  Yahoo 응답에 marketState 키가 없어서 직접 추론.
// ─────────────────────────────────────────────────────────

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
  // 정규장 종료 후 ~ post 시작 전, 또는 post 끝 후, 또는 주말/휴장
  return { state: "CLOSED", label: "장 마감", short: "CLOSED" };
}

// ─────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────

async function fetchYahoo() {
  // Node fetch (undici) 가 자동으로 추가하는 Accept-Encoding · sec-fetch 헤더가
  // Yahoo CDN 에서 봇으로 분류되는 케이스가 있어, 헤더를 curl 수준으로 단순화.
  let lastErr = null;
  for (const url of URLS) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return res.json();
      lastErr = new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all endpoints failed");
}

async function main() {
  console.log(`[fetch-price] ${SYMBOL} via Yahoo Finance`);

  let data;
  try {
    data = await fetchYahoo();
  } catch (e) {
    console.error(`[fetch-price] FAIL · ${e.message} — 기존 kpi.json 유지`);
    process.exit(0);  // exit 0 — cron 실패 시 사이트는 이전 데이터 계속 사용
  }

  const result = data?.chart?.result?.[0];
  if (!result || !result.meta) {
    console.error(`[fetch-price] 응답 구조 이상 — 기존 kpi.json 유지`);
    process.exit(0);
  }

  const m = result.meta;
  const price = m.regularMarketPrice;
  const prevClose = m.chartPreviousClose ?? m.previousClose;
  if (typeof price !== "number" || typeof prevClose !== "number") {
    console.error(`[fetch-price] 가격 필드 누락 — 기존 kpi.json 유지`);
    process.exit(0);
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

  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  const arrow = out.change >= 0 ? "▲" : "▼";
  console.log(
    `[fetch-price] OK · $${out.price} ${arrow}${out.change >= 0 ? "+" : ""}${out.change} (${out.changePct >= 0 ? "+" : ""}${out.changePct}%) · ${out.marketStateLabel} · D ${out.dayLow}–${out.dayHigh}`,
  );
}

function round2(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

main().catch((err) => {
  console.error(`[fetch-price] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
