#!/usr/bin/env node
/**
 * TSLA Brief — RSS → data/raw-cards.json 페처 (v2)
 *
 *   node scripts/fetch-news.mjs
 *
 * v2 변경 (vs v1)
 *  - 카테고리당 1건 → top 5건 (총 ~20건 후보) — 한국어 정제 시 선택 폭 ↑
 *  - href 자동 변환: news.google.com/rss/articles/... → 매체 홈 (sourceUrl 기반)
 *  - 출력 스키마를 cards.json 과 통일 — 정제 단계에서 slug/summary/title `<em>` 만 채우면 됨
 *  - 중복 제거 (같은 host + 같은 prefix 4단어)
 *  - sources 카운트 필드 제거 (build.mjs 가 안 씀, sourceLabel 단일 값으로 충분)
 *
 * 의존성 0. Node 22+ 권장.
 *
 * 한계
 *  - 한국어 정제 없음 — 제목·요약은 RSS 영문 원문 그대로 (다음 단계에서 처리)
 *  - href 는 매체 홈 (개별 기사 URL 풀이는 별도 작업 — Google News redirect 추적 필요)
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// raw 영문 RSS 출력 — 매일 cron 으로 덮어씌워짐.
// 한국어 정제분(data/cards.json)은 별도 흐름으로 갱신 (Claude 구독 내 수동 정제).
// 환경변수 SEED_OUT 으로 다른 출력 파일 지정 가능 (수동 시드용).
const OUT_PATH = path.join(ROOT, "data", process.env.SEED_OUT || "raw-cards.json");

// ─────────────────────────────────────────────────────────
// RSS 소스 정의
// ─────────────────────────────────────────────────────────

// Google News RSS 는 hl=en-US&gl=US&ceid=US:en 로 영어 결과 받음
const GN = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const SOURCES = [
  // STOCK ─────────────────────────────
  { category: "stock",   url: GN(`Tesla TSLA stock when:${process.env.SEED_WINDOW || "1d"}`), defaultLabel: "press" },
  { category: "stock",   url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=TSLA&region=US&lang=en-US", defaultLabel: "press" },

  // PRODUCT ───────────────────────────
  { category: "product", url: "https://electrek.co/guides/tesla/feed/", defaultLabel: "press" },
  { category: "product", url: "https://www.teslarati.com/category/news/feed/", defaultLabel: "press" },

  // FSD ───────────────────────────────
  { category: "fsd",     url: "https://electrek.co/guides/tesla-autopilot/feed/", defaultLabel: "press" },
  { category: "fsd",     url: GN(`Tesla FSD OR "Full Self-Driving" OR robotaxi when:${process.env.SEED_WINDOW || "2d"}`), defaultLabel: "press" },

  // MUSK ──────────────────────────────
  { category: "musk",    url: GN(`Elon Musk Tesla when:${process.env.SEED_WINDOW || "1d"}`), defaultLabel: "press" },
];

// ─────────────────────────────────────────────────────────
// 도메인 → 출처 4단계 라벨링
// ─────────────────────────────────────────────────────────

const DOMAIN_LABEL = [
  // sec — 1차 자료 (정부·증권·테슬라 IR)
  [/(^|\.)sec\.gov$/i,           "sec"],
  [/(^|\.)ir\.tesla\.com$/i,     "sec"],
  [/finance\.yahoo\.com/i,       "sec"],   // Yahoo Finance 는 1차 fee data 간주
  [/(^|\.)nasdaq\.com$/i,        "sec"],

  // official — 공식 발언·테슬라 PR·일론 X
  [/(^|\.)tesla\.com$/i,         "official"],
  [/(^|\.)x\.com$/i,             "official"],
  [/(^|\.)twitter\.com$/i,       "official"],

  // press — 외신·전문매체
  [/(^|\.)reuters\.com$/i,       "press"],
  [/(^|\.)bloomberg\.com$/i,     "press"],
  [/(^|\.)cnbc\.com$/i,          "press"],
  [/(^|\.)wsj\.com$/i,           "press"],
  [/(^|\.)ft\.com$/i,            "press"],
  [/(^|\.)nytimes\.com$/i,       "press"],
  [/(^|\.)theverge\.com$/i,      "press"],
  [/(^|\.)electrek\.co$/i,       "press"],
  [/(^|\.)teslarati\.com$/i,     "press"],
  [/(^|\.)insideevs\.com$/i,     "press"],
  [/(^|\.)cnet\.com$/i,          "press"],
  [/(^|\.)engadget\.com$/i,      "press"],
  [/(^|\.)barrons\.com$/i,       "press"],

  // rumor — 커뮤니티·익명·블로그
  [/(^|\.)reddit\.com$/i,        "rumor"],
  [/(^|\.)medium\.com$/i,        "rumor"],
  [/(^|\.)substack\.com$/i,      "rumor"],
];

function labelForUrl(link) {
  try {
    const host = new URL(link).hostname.toLowerCase();
    for (const [re, label] of DOMAIN_LABEL) {
      if (re.test(host)) return label;
    }
  } catch {}
  return null; // 분류 안 됨 — defaultLabel 로 폴백
}

// ─────────────────────────────────────────────────────────
// 화이트리스트 (가산점 방식)
//   하드 제외가 아니라 "선별 순위"만 조정한다. 카드가 부족해지는 일이 없도록
//   모든 후보를 남기되, 신뢰도 높은 출처를 위로 끌어올린다.
//   최종 점수 = 신선도 점수(recency) + 출처 가산점(tier).
//   (노출 순서는 선별 후 다시 시간순으로 정렬되므로 여기 점수는 "어떤 카드를 고르냐"에만 영향)
// ─────────────────────────────────────────────────────────

// 도메인 → tier 가산점. 위에서부터 먼저 매칭. 미분류는 DEFAULT_TIER 로 폴백.
const DOMAIN_TIER = [
  // 1차·공식 자료 — 가장 신뢰
  [/(^|\.)sec\.gov$/i,        7],
  [/(^|\.)ir\.tesla\.com$/i,  7],
  [/(^|\.)tesla\.com$/i,      7],
  [/finance\.yahoo\.com/i,    6],
  [/(^|\.)nasdaq\.com$/i,     6],

  // tier-1 통신사·주요 경제지
  [/(^|\.)reuters\.com$/i,    8],
  [/(^|\.)bloomberg\.com$/i,  8],
  [/(^|\.)cnbc\.com$/i,       8],
  [/(^|\.)wsj\.com$/i,        8],
  [/(^|\.)ft\.com$/i,         8],
  [/(^|\.)nytimes\.com$/i,    7],
  [/(^|\.)barrons\.com$/i,    7],

  // tier-2 전문·트레이드 매체
  [/(^|\.)electrek\.co$/i,    4],
  [/(^|\.)teslarati\.com$/i,  4],
  [/(^|\.)insideevs\.com$/i,  4],
  [/(^|\.)theverge\.com$/i,   4],
  [/(^|\.)cnet\.com$/i,       3],
  [/(^|\.)engadget\.com$/i,   3],

  // 일론 직접 발언(소셜) — 가치 있지만 검증 약함
  [/(^|\.)x\.com$/i,          3],
  [/(^|\.)twitter\.com$/i,    3],

  // rumor — 커뮤니티·블로그. 강한 감점
  [/(^|\.)reddit\.com$/i,    -8],
  [/(^|\.)medium\.com$/i,    -8],
  [/(^|\.)substack\.com$/i,  -8],
];
const DEFAULT_TIER = -3; // 분류 안 된 도메인 (비영어권·무명 매체 포함) — 약한 감점

function tierBonus(host) {
  if (!host) return DEFAULT_TIER;
  for (const [re, score] of DOMAIN_TIER) {
    if (re.test(host)) return score;
  }
  return DEFAULT_TIER;
}

// 신선도 점수 — 일일 브리핑이라 24시간 내는 거의 동급으로 본다.
function recencyBonus(ts) {
  if (!ts) return -2;
  const ageHr = (Date.now() - ts) / 3_600_000;
  if (ageHr < 3)  return 10;
  if (ageHr < 6)  return 8;
  if (ageHr < 12) return 6;
  if (ageHr < 24) return 4;
  if (ageHr < 48) return 1;
  return -2;
}

// 선별용 종합 점수 (높을수록 우선 채택)
function selectionScore(it) {
  return recencyBonus(it.ts) + tierBonus(it.host);
}

// ─────────────────────────────────────────────────────────
// 카테고리 자동 추론 (Google News 등 일반 소스에서)
// ─────────────────────────────────────────────────────────

const KEYWORDS = {
  fsd:     [/\bFSD\b/i, /full[\s-]?self[\s-]?driving/i, /autopilot/i, /robotaxi\b/i, /robo[\s-]?taxi/i, /cybercab/i, /\bv1[3-5]\b/i, /autonom/i],
  // ELON 카테고리 — Musk 직접 발언 + SpaceX/X/xAI/Neuralink/Boring Co 등 타사 + 경영 관련 발언
  musk:    [/\bElon\b/i, /\bMusk\b/i, /\bSpaceX\b/i, /\bStarship\b/i, /\bStarlink\b/i, /\bxAI\b/i, /\bGrok\b/i, /\bNeuralink\b/i, /\bBoring (Co|Company)\b/i, /@elonmusk/i],
  stock:   [/\bstock\b/i, /\bshares?\b/i, /\bvaluation\b/i, /\bearnings?\b/i, /\bdeliveries\b/i, /\b(Q[1-4]|quarter)\b/i, /\banalyst/i, /\bprice target/i, /\bmarket cap/i, /\bdividend/i, /\bbuyback/i],
  // PRODUCT — 차량 + 에너지(Powerwall/Megapack/Solar) + 옵티머스
  product: [/\bModel [SX3Y]\b/i, /\bCybertruck\b/i, /\bRoadster\b/i, /\bSemi\b/i, /\bOptimus\b/i, /\bPowerwall\b/i, /\bMegapack\b/i, /\bSolar Roof\b/i, /\bsupercharger/i, /\b(price cut|trim|refresh|juniper|highland)\b/i, /\bbattery (factory|plant|cell)/i],
};

function inferCategory(title, summary, fallback) {
  const text = `${title} ${summary || ""}`;
  // FSD > musk > stock > product 우선순위 — FSD 키워드가 강하게 식별됨
  for (const cat of ["fsd", "musk", "stock", "product"]) {
    if (KEYWORDS[cat].some((re) => re.test(text))) return cat;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────
// RSS 파싱 (의존성 0, 단순 정규식)
// ─────────────────────────────────────────────────────────

function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extract(tag, xml) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  return m ? decodeEntities(m[1]).trim() : "";
}

function parseRss(xml) {
  // <item> 블록 추출 (RSS 2.0)
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    // Google News RSS 는 <source url="https://realdomain.com">매체명</source> 으로 원본 매체 URL 을 별도로 줌
    const sourceUrlMatch = /<source[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i.exec(block);
    items.push({
      title:       stripHtml(extract("title", block)),
      link:        extract("link", block).replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
      description: stripHtml(extract("description", block)),
      pubDate:     extract("pubDate", block),
      sourceUrl:   sourceUrlMatch ? sourceUrlMatch[1] : "",
      sourceName:  sourceUrlMatch ? stripHtml(sourceUrlMatch[2]) : stripHtml(extract("source", block)),
    });
  }
  // Atom <entry> 도 시도
  if (items.length === 0) {
    const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[1];
      const linkMatch = /<link[^>]*href="([^"]+)"/i.exec(block);
      items.push({
        title:       stripHtml(extract("title", block)),
        link:        linkMatch ? linkMatch[1] : "",
        description: stripHtml(extract("summary", block) || extract("content", block)),
        pubDate:     extract("updated", block) || extract("published", block),
        source:      "",
      });
    }
  }
  return items;
}

// 출처 라벨링용 호스트 결정.
//  - Google News 의 <source url="..."> 가 있으면 그 도메인 사용 (실제 매체)
//  - 없으면 link 의 도메인
// 사용자 클릭 시 link 는 그대로 사용 (Google News 가 자동 redirect 처리)
function hostForLabel(item) {
  try {
    if (item.sourceUrl) return new URL(item.sourceUrl).hostname.toLowerCase();
    return new URL(item.link).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// 제목 끝 " - 매체명" 제거 (Google News RSS 자동 부가)
function cleanTitle(title, sourceName) {
  if (!title) return title;
  if (sourceName) {
    const re = new RegExp(`\\s*[-–—]\\s*${sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    title = title.replace(re, "");
  }
  // 일반화: 마지막 " - 단어" 패턴 — 보수적으로 1~3 단어만
  title = title.replace(/\s+[-–—]\s+([A-Za-z][\w&.'\s]{0,30})$/, (full, tail) => {
    const words = tail.trim().split(/\s+/);
    return words.length <= 3 ? "" : full;
  });
  return title.trim();
}

// ─────────────────────────────────────────────────────────
// 시간 표시 ("3h ago")
// ─────────────────────────────────────────────────────────

function timeAgo(pubDateStr) {
  if (!pubDateStr) return "";
  const t = Date.parse(pubDateStr);
  if (Number.isNaN(t)) return "";
  const diffMin = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (diffMin < 60)      return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24)       return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

// ─────────────────────────────────────────────────────────
// 메인 페치 루프
// ─────────────────────────────────────────────────────────

const CATEGORY_LABELS = {
  stock:   "STOCK · 주가·실적",
  product: "PRODUCT · 차량·에너지·옵티머스",
  fsd:     "FSD · 자율·로보택시",
  musk:    "ELON · 일론 소식",
};

// 일반 브라우저로 위장 — Anthropic Cloud Routine IP 가 봇으로 차단되는 케이스 회피용.
// (로컬 macOS 환경에서는 어떤 UA 든 통과하지만, 클라우드 IP 차단을 우회하려면 가장 일반적인 UA 가 안전.)
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/rss+xml, application/xml, application/atom+xml, text/xml, */*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

async function fetchRss(url) {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ─────────────────────────────────────────────────────────
// href 정규화 — 직접 피드는 link 가 곧 원문, Google News 만 토큰 해석
// ─────────────────────────────────────────────────────────

// 매체 홈 fallback (토큰 해석 실패 시).
function mediaHome(it) {
  const link = it.link || "";
  try {
    const u = new URL(it.sourceUrl || link);
    return `${u.protocol}//${u.hostname}/`;
  } catch {
    return link;
  }
}

// Google News /rss/articles/<TOKEN> 를 실제 원문 URL 로 2-step 해석.
//  1) 기사 페이지 GET → data-n-a-sg (서명) + data-n-a-ts (타임스탬프) 추출
//  2) batchexecute POST (garturlreq) → 응답에서 원문 URL 추출
// 실패하면 null 반환 → 호출부가 mediaHome 으로 fallback.
async function decodeGoogleNews(link) {
  const m = /\/rss\/articles\/([^?/]+)/.exec(link);
  if (!m) return null;
  const tok = m[1];

  const page = await fetch(link, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  }).then((r) => (r.ok ? r.text() : ""));
  if (!page) return null;

  const sg = /data-n-a-sg="([^"]+)"/.exec(page)?.[1];
  const ts = /data-n-a-ts="([^"]+)"/.exec(page)?.[1];
  if (!sg || !ts) return null;

  const inner = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "en-US", "US", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    tok, Number(ts), sg,
  ]);
  const freq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);

  const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "f.req=" + encodeURIComponent(freq),
    signal: AbortSignal.timeout(15000),
  }).then((r) => (r.ok ? r.text() : ""));
  if (!res) return null;

  const url = /https?:\/\/(?!news\.google|www\.google)[^\s"'\\]+/.exec(res)?.[0];
  return url || null;
}

// 카드 1건의 최종 href 결정. 직접 피드면 link 그대로, Google News 면 해석.
async function resolveArticleUrl(it) {
  const link = it.link || "";
  if (!/news\.google\.com\/rss/i.test(link)) return link;
  try {
    const real = await decodeGoogleNews(link);
    if (real) return real;
  } catch { /* 아래 fallback */ }
  return mediaHome(it);
}

// 재발행된 옛 기사 차단 목록.
// RSS 매체가 오래된 글을 새 pubDate 로 재발행하면 날짜만으로는 구분 불가 →
// link / sourceUrl / title 에 아래 문자열이 포함되면 수집 단계에서 제외한다.
// (예: Teslarati 가 2014년 'Model E'(모델3 옛 코드명) 기사를 2026 날짜로 재발행한 사고)
// 주의: Google News RSS 경유 시 수집 시점의 link 는 토큰 URL 이고 실제 원문 URL 은
// 선별 후에야 해석된다(resolveArticleUrl). 따라서 URL 뿐 아니라 **제목** 으로도 막는다.
const BLOCKLIST = [
  "tuned-third-generation-tesla-model-e-will-utilize-steel-construction", // 원문 URL slug
  "will utilize steel construction",                                       // 제목 (수집 시점에도 매칭됨)
];
function isBlocked(it) {
  const hay = `${it.link || ""} ${it.sourceUrl || ""} ${it.title || ""} ${it.href || ""}`.toLowerCase();
  return BLOCKLIST.some((b) => hay.includes(b.toLowerCase()));
}

// 카테고리당 최대 N건 (한국어 정제 시 선택 폭). 환경변수 SEED_N 으로 override.
const N_PER_CATEGORY = Number(process.env.SEED_N || 5);

async function main() {
  console.log(`[fetch-news] starting · ${SOURCES.length} sources · top ${N_PER_CATEGORY} per category`);

  // 카테고리별로 후보 모음
  const buckets = { stock: [], product: [], fsd: [], musk: [] };

  await Promise.all(SOURCES.map(async (src) => {
    try {
      const xml = await fetchRss(src.url);
      const items = parseRss(xml);
      for (const it of items) {
        const host = hostForLabel(it);
        const label = (host && labelForUrl(`https://${host}/`)) || src.defaultLabel;
        const title = cleanTitle(it.title, it.sourceName);
        if (!title) continue;
        if (isBlocked({ link: it.link, sourceUrl: it.sourceUrl, title })) {
          console.log(`  · BLOCKED ${it.link || title}`);
          continue;
        }
        const cat = inferCategory(title, it.description, src.category);
        buckets[cat].push({
          title,
          link: it.link,
          sourceUrl: it.sourceUrl,
          description: it.description,
          pubDate: it.pubDate,
          ts: Date.parse(it.pubDate) || 0,
          label,
          host,
          sourceName: it.sourceName || host,
        });
      }
      console.log(`[fetch-news] ${src.category.padEnd(8)} ← ${items.length.toString().padStart(3)} items · ${new URL(src.url).hostname}`);
    } catch (e) {
      console.warn(`[fetch-news] ${src.category.padEnd(8)} ← FAIL · ${e.message} · ${src.url}`);
    }
  }));

  // 카테고리당 top N건 + 중복 제거 (같은 host + 같은 prefix 4단어)
  const picks = [];
  for (const [cat, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    // 선별 정렬: 신선도 + 출처 가산점 (동점이면 최신 우선)
    items.sort((a, b) => (selectionScore(b) - selectionScore(a)) || (b.ts - a.ts));
    const seen = new Set();
    let picked = 0;
    for (const it of items) {
      if (picked >= N_PER_CATEGORY) break;
      const prefKey = `${it.host}|${it.title.split(/\s+/).slice(0, 4).join(" ").toLowerCase()}`;
      if (seen.has(prefKey)) continue;
      seen.add(prefKey);
      picked += 1;
      console.log(`  · pick ${cat.padEnd(8)} score ${String(selectionScore(it)).padStart(3)} (tier ${String(tierBonus(it.host)).padStart(2)}) ${it.host || "?"}`);
      picks.push({ cat, it });
    }
  }

  // 원문 URL 해석 (Google News 토큰 → 실제 기사). 동시 4건 제한.
  const cards = new Array(picks.length);
  let resolved = 0, gnews = 0, gnewsOk = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (true) {
        const i = resolved++;
        if (i >= picks.length) break;
        const { cat, it } = picks[i];
        const isGnews = /news\.google\.com\/rss/i.test(it.link || "");
        if (isGnews) gnews += 1;
        const href = await resolveArticleUrl(it);
        if (isGnews && !/news\.google\.com/i.test(href) && !href.endsWith("/")) gnewsOk += 1;
        // 해석된 실제 URL 기준 최종 차단 (Google News 토큰이 풀린 뒤). cards[i] 미할당 → 뒤에서 filter.
        if (isBlocked({ href, title: it.title, link: it.link })) {
          console.log(`  · BLOCKED(url) ${href}`);
          continue;
        }
        const pubIso = it.ts ? new Date(it.ts).toISOString() : "";
        cards[i] = {
          category: cat,
          categoryLabel: CATEGORY_LABELS[cat],
          time: timeAgo(it.pubDate),
          pubDate: pubIso,
          title: it.title,
          body: it.description.slice(0, 220) + (it.description.length > 220 ? "…" : ""),
          sourceName: it.sourceName,
          sourceLabel: it.label,
          slug: "",         // 정제 단계에서 채움
          summary: "",      // 정제 단계에서 채움
          href,
        };
      }
    })
  );
  console.log(`[fetch-news] href 해석 · Google News ${gnews}건 중 ${gnewsOk}건 원문 연결 성공`);

  // 차단되어 미할당된 슬롯(undefined) 제거.
  const liveCards = cards.filter(Boolean);
  if (liveCards.length === 0) {
    console.warn("[fetch-news] 카드를 한 건도 못 가져왔습니다. 기존 raw-cards.json 유지.");
    process.exit(0);
  }

  // 정렬: 최신순 (라이브 사이트 표시 순)
  liveCards.sort((a, b) => Date.parse(b.pubDate || 0) - Date.parse(a.pubDate || 0));

  const out = {
    asOf: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC 기준 · 카테고리당 top ${N_PER_CATEGORY}건`,
    items: liveCards,
  };

  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`[fetch-news] OK → ${path.relative(ROOT, OUT_PATH)} · ${liveCards.length} cards`);
  // 카테고리별 요약 로그
  const byCat = liveCards.reduce((acc, c) => ((acc[c.category] = (acc[c.category] || 0) + 1), acc), {});
  for (const cat of ["stock", "product", "fsd", "musk"]) {
    console.log(`  · ${cat.padEnd(8)} ${(byCat[cat] || 0).toString().padStart(2)}건`);
  }
}

main().catch((err) => {
  console.error(`[fetch-news] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
