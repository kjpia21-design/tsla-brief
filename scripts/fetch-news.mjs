#!/usr/bin/env node
/**
 * TSLA Brief — RSS → data/cards.json 페처
 *
 *   node scripts/fetch-news.mjs
 *
 * - 카테고리별 RSS 1~2개 fetch → 카테고리당 최신 1건 선정
 * - 도메인 기반 출처 4단계 라벨링 (sec / official / press / rumor)
 * - 네트워크 실패 시 기존 cards.json 유지 (덮어쓰기 안 함)
 *
 * 의존성 0. Node 20+ 권장.
 *
 * 한계 (1단계):
 *  - LLM 정제 없음 — 제목·요약은 RSS 원문 그대로
 *  - <em> 강조 자동 부여 안 됨
 *  - 출처 카운트는 카드별 "참여한 소스 수" 로 단순화 (같은 사건 다중 매체 클러스터링은 다음 단계)
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_PATH = path.join(ROOT, "data", "cards.json");

// ─────────────────────────────────────────────────────────
// RSS 소스 정의
// ─────────────────────────────────────────────────────────

// Google News RSS 는 hl=en-US&gl=US&ceid=US:en 로 영어 결과 받음
const GN = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const SOURCES = [
  // STOCK ─────────────────────────────
  { category: "stock",   url: GN("Tesla TSLA stock when:1d"), defaultLabel: "press" },
  { category: "stock",   url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=TSLA&region=US&lang=en-US", defaultLabel: "press" },

  // PRODUCT ───────────────────────────
  { category: "product", url: "https://electrek.co/guides/tesla/feed/", defaultLabel: "press" },
  { category: "product", url: "https://www.teslarati.com/category/news/feed/", defaultLabel: "press" },

  // FSD ───────────────────────────────
  { category: "fsd",     url: "https://electrek.co/guides/tesla-autopilot/feed/", defaultLabel: "press" },
  { category: "fsd",     url: GN("Tesla FSD OR \"Full Self-Driving\" OR robotaxi when:2d"), defaultLabel: "press" },

  // MUSK ──────────────────────────────
  { category: "musk",    url: GN("Elon Musk Tesla when:1d"), defaultLabel: "press" },
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
// 카테고리 자동 추론 (Google News 등 일반 소스에서)
// ─────────────────────────────────────────────────────────

const KEYWORDS = {
  fsd:     [/\bFSD\b/i, /full[\s-]?self[\s-]?driving/i, /autopilot/i, /robotaxi/i, /\bv1[3-5]\b/i, /autonom/i],
  musk:    [/\bElon\b/i, /\bMusk\b/i],
  stock:   [/\bstock\b/i, /\bshares?\b/i, /\bvaluation\b/i, /\bearnings?\b/i, /\bdeliveries\b/i, /\b(Q[1-4]|quarter)\b/i, /\banalyst/i, /\bprice target/i, /\bmarket cap/i],
  product: [/\bModel [SX3Y]\b/i, /\bCybertruck\b/i, /\bRoadster\b/i, /\bOptimus\b/i, /\bPowerwall\b/i, /\bMegapack\b/i, /\b(price cut|trim|refresh|juniper)\b/i],
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
  product: "PRODUCT · 신차·제품",
  fsd:     "FSD · 자율주행",
  musk:    "MUSK · 일론 동향",
};

async function fetchRss(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "TSLA-Brief/0.1 (+https://github.com/)" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function main() {
  console.log(`[fetch-news] starting · ${SOURCES.length} sources`);

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
        const cat = inferCategory(title, it.description, src.category);
        buckets[cat].push({
          title,
          link: it.link,
          description: it.description,
          pubDate: it.pubDate,
          ts: Date.parse(it.pubDate) || 0,
          label,
          host,
          sourceName: it.sourceName,
        });
      }
      console.log(`[fetch-news] ${src.category.padEnd(8)} ← ${items.length.toString().padStart(3)} items · ${new URL(src.url).hostname}`);
    } catch (e) {
      console.warn(`[fetch-news] ${src.category.padEnd(8)} ← FAIL · ${e.message} · ${src.url}`);
    }
  }));

  // 카테고리당 최신 1건 + 같은 사건에 모인 소스 수로 카운트
  const cards = [];
  for (const [cat, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    items.sort((a, b) => b.ts - a.ts);
    const top = items[0];

    // 카테고리 내에서 같은 host 또는 유사 제목 카운트 — 단순화: top.host 외 다른 host 가 등장한 횟수
    const sources = { sec: 0, official: 0, press: 0, rumor: 0 };
    sources[top.label] = 1;
    // 같은 카테고리 내 다른 매체가 같은 사건을 다뤘다면 추가 카운트
    // (간이 클러스터링: 첫 4단어 공유 시 같은 사건으로 간주)
    const topPrefix = top.title.split(/\s+/).slice(0, 4).join(" ").toLowerCase();
    for (const it of items.slice(1)) {
      if (!topPrefix) break;
      const pref = it.title.split(/\s+/).slice(0, 4).join(" ").toLowerCase();
      if (pref === topPrefix && it.host !== top.host) {
        sources[it.label] = (sources[it.label] || 0) + 1;
      }
    }

    cards.push({
      category: cat,
      categoryLabel: CATEGORY_LABELS[cat],
      time: timeAgo(top.pubDate),
      title: top.title,
      body: top.description.slice(0, 220) + (top.description.length > 220 ? "…" : ""),
      sources,
      href: top.link,
      _debug: { host: top.host, pubDate: top.pubDate },
    });
  }

  if (cards.length === 0) {
    console.warn("[fetch-news] 카드를 한 건도 못 가져왔습니다. 기존 cards.json 유지.");
    process.exit(0);
  }

  // 디버그 필드 제거
  const clean = cards.map(({ _debug, ...rest }) => rest);

  // 카테고리 표시 순서 보장: stock → product → fsd → musk
  const ORDER = ["stock", "product", "fsd", "musk"];
  clean.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));

  const out = {
    asOf: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC 기준 · 카테고리당 핵심 1건`,
    items: clean,
  };

  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`[fetch-news] OK → ${path.relative(ROOT, OUT_PATH)} · ${clean.length} cards`);
  for (const c of clean) {
    console.log(`  · ${c.category.padEnd(8)} ${c.sources.sec}/${c.sources.official}/${c.sources.press}/${c.sources.rumor}  ${c.title.slice(0, 70)}`);
  }
}

main().catch((err) => {
  console.error(`[fetch-news] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
