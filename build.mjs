#!/usr/bin/env node
/**
 * TSLA Brief — JSON → home.html 빌드 스크립트
 *
 *   node build.mjs
 *
 * 입력: home-v1.html (템플릿, BLOCK 마커 포함) + data/*.json
 * 출력: dist/home.html (마커 영역 치환됨)
 *
 * 의존성 0. Node 20+ 권장.
 */

import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 활성 템플릿: home.html (mobile-first 정착본). home-v1/v2 는 디자인 보존용 백업.
const TEMPLATE_PATH = path.join(ROOT, "home.html");
const DATA_DIR = path.join(ROOT, "data");
const ASSETS_DIR = path.join(ROOT, "assets");
const OUT_DIR = path.join(ROOT, "dist");
// GitHub Pages 호환을 위해 index.html 로 출력. 템플릿은 home-v1.html 그대로.
const OUT_PATH = path.join(OUT_DIR, "index.html");
const OUT_ASSETS = path.join(OUT_DIR, "assets");

const CATEGORY_CLASS = {
  stock: "is-stock",
  product: "is-product",
  fsd: "is-fsd",
  musk: "is-musk",
};

const VIDEO_THUMB_CLASS = {
  stock: "v-stock",
  product: "v-product",
  fsd: "v-fsd",
  musk: "v-musk",
};

// 영어 빌드용 카테고리 라벨 (raw-cards.json 의 한국어 categoryLabel 영문 대체)
const CATEGORY_LABEL_EN = {
  stock:   "STOCK · Stock & Earnings",
  product: "PRODUCT · Vehicles, Energy & Optimus",
  fsd:     "FSD · Autonomy & Robotaxi",
  musk:    "ELON · Elon News",
};

// 4단계 출처 표시 순서: 1차(green) → 공식(blue) → 외신(orange) → 추측(grey)
const SOURCE_ORDER = [
  { key: "sec",      dot: "d-sec",    label: "1차"  },
  { key: "official", dot: "d-off",    label: "공식" },
  { key: "press",    dot: "d-press",  label: "외신" },
  { key: "rumor",    dot: "d-rumor",  label: "추측" },
];

/**
 * BLOCK 마커 영역 치환.
 *  - 기본: 마커 보존 (idempotent — 두 번째 빌드에서도 다시 치환 가능)
 *  - keepMarkers=false: 마커까지 제거 (URL/attribute 안에 들어가는 값에 사용 — 주석이 속성을 깨뜨림)
 */
function replaceBlock(html, name, replacement, opts = {}) {
  const re = new RegExp(
    `<!--\\s*BLOCK:${name}\\s*-->[\\s\\S]*?<!--\\s*/BLOCK:${name}\\s*-->`,
    "g"
  );
  if (!re.test(html)) {
    throw new Error(`[build] BLOCK:${name} 마커가 템플릿에 없습니다.`);
  }
  const out = opts.keepMarkers === false
    ? replacement
    : `<!-- BLOCK:${name} -->${replacement}<!-- /BLOCK:${name} -->`;
  return html.replace(
    new RegExp(
      `<!--\\s*BLOCK:${name}\\s*-->[\\s\\S]*?<!--\\s*/BLOCK:${name}\\s*-->`,
      "g"
    ),
    out
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 제목·바디에는 <em> 강조 마크업이 들어 있으므로 그대로 살림(이미 콘텐츠 작성자가 의도한 것).
// 나머지 텍스트 필드는 escapeHtml 적용.

/**
 * 가격 박스 한 줄 렌더링.
 * data/kpi.json 스키마(fetch-price.mjs 산출):
 *   { price, change, changePct, dayHigh, dayLow, marketState, marketStateLabel, marketStateShort, asOf, ... }
 * SSR 산출은 첫 페인트 fallback. 클라이언트 폴링(1분)이 이후 갱신.
 */
function renderKpi(kpi) {
  // 옛 5칸 스키마 (items 배열) → 빈 placeholder
  if (Array.isArray(kpi.items)) {
    return emptyPriceBar();
  }
  const up = (kpi.change || 0) >= 0;
  const dir = up ? "up" : "down";
  const arrow = up ? "▲" : "▼";
  const sign = up ? "+" : "";
  const price = typeof kpi.price === "number" ? `$${kpi.price.toFixed(2)}` : "$—";
  const changeFull = typeof kpi.change === "number"
    ? `${arrow} ${sign}${kpi.change.toFixed(2)} (${sign}${kpi.changePct.toFixed(2)}%)`
    : "—";
  // 모바일은 % 만 (절대값 생략)
  const changeShort = typeof kpi.changePct === "number"
    ? `${arrow} ${sign}${kpi.changePct.toFixed(2)}%`
    : "—";
  const rangeFull = (typeof kpi.dayLow === "number" && typeof kpi.dayHigh === "number")
    ? `${kpi.dayLow.toFixed(2)} – ${kpi.dayHigh.toFixed(2)}`
    : "— – —";
  // 모바일은 정수
  const rangeShort = (typeof kpi.dayLow === "number" && typeof kpi.dayHigh === "number")
    ? `${Math.round(kpi.dayLow)}–${Math.round(kpi.dayHigh)}`
    : "—–—";
  const stateShort = (kpi.marketStateShort || kpi.marketState || "").toLowerCase();
  const stateLabel = kpi.marketStateLabel || kpi.marketState || "—";
  return `
      <span class="price-bar__price"><small>TSLA</small><span data-pb-price>${escapeHtml(price)}</span></span>
      <span class="price-bar__change ${dir}">
        <span class="pb-full" data-pb-change-full>${escapeHtml(changeFull)}</span>
        <span class="pb-short" data-pb-change-short>${escapeHtml(changeShort)}</span>
      </span>
      <span class="price-bar__meta">
        <span class="price-bar__pill is-${escapeHtml(stateShort)}" data-pb-state>${escapeHtml(stateLabel)}</span>
        <span class="price-bar__range">
          <b>오늘</b>
          <span class="pb-full" data-pb-range-full>${escapeHtml(rangeFull)}</span>
          <span class="pb-short" data-pb-range-short>${escapeHtml(rangeShort)}</span>
        </span>
        <span class="price-bar__asof" data-pb-asof>${escapeHtml(kpi.asOf || "")}</span>
      </span>
      `;
}

function emptyPriceBar() {
  return `
      <span class="price-bar__price"><small>TSLA</small><span data-pb-price>$—</span></span>
      <span class="price-bar__change">
        <span class="pb-full" data-pb-change-full>—</span>
        <span class="pb-short" data-pb-change-short>—</span>
      </span>
      <span class="price-bar__meta">
        <span class="price-bar__pill" data-pb-state>—</span>
        <span class="price-bar__range">
          <b>오늘</b>
          <span class="pb-full" data-pb-range-full>— – —</span>
          <span class="pb-short" data-pb-range-short>— – —</span>
        </span>
        <span class="price-bar__asof" data-pb-asof>—</span>
      </span>
      `;
}

// 옛 스키마(`sources` 카운트 객체) 호환용. 신 스키마는 sourceName 단일.
function renderSources(sources) {
  const parts = SOURCE_ORDER
    .map(({ key, dot, label }) => {
      const n = sources[key] || 0;
      if (n <= 0) return null;
      return `<span><i class="d ${dot}"></i> ${label} ${n}</span>`;
    })
    .filter(Boolean)
    .join("\n            ");
  return parts;
}

const SOURCE_LABEL_DOT = {
  sec: "d-sec", official: "d-off", press: "d-press", rumor: "d-rumor",
};

/** 카드 메타: 신 스키마(sourceName) 우선, 없으면 옛 sources 카운트 폴백. */
function renderCardMeta(c) {
  if (c.sourceName) {
    const dot = SOURCE_LABEL_DOT[c.sourceLabel || "press"] || "d-press";
    return `<span class="src-name"><i class="d ${dot}"></i>${escapeHtml(c.sourceName)}</span>`;
  }
  if (c.sources) return renderSources(c.sources);
  return "";
}

/** 카테고리 짧은 라벨 (핫 뉴스용) — STOCK/PRODUCT/FSD/ELON */
const CATEGORY_SHORT = {
  stock: "STOCK", product: "PRODUCT", fsd: "FSD", musk: "ELON",
};

/**
 * 핫 뉴스 — 제목 5건만 stack.
 * cards.items 의 첫 5개. 각 항목 클릭 시 상세 페이지로.
 */
/**
 * 핫뉴스 — hot 점수 (0~10) 기준 정렬, top 5.
 * - 1차 정렬: hot 점수 desc (LLM 정성 판단, Routine 이 부여)
 * - 2차 정렬 (동률): pubDate desc — 같은 hot 이면 최신 우선
 * - 폴백: hot 필드 없으면 기본 5 → 사실상 시간순
 */
function renderHotNews(cards) {
  const ranked = [...cards.items].sort((a, b) => {
    const hotA = typeof a.hot === "number" ? a.hot : 5;
    const hotB = typeof b.hot === "number" ? b.hot : 5;
    if (hotA !== hotB) return hotB - hotA;
    return Date.parse(b.pubDate || 0) - Date.parse(a.pubDate || 0);
  });
  const top = ranked.slice(0, 5);
  const items = top.map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    return `      <li><a class="hot-news__item ${cls}" href="${escapeHtml(href)}">
        <span class="hot-news__title">${c.title}</span>
        <span class="hot-news__arrow">→</span>
      </a></li>`;
  }).join("\n");
  return `\n${items}\n      `;
}

/**
 * 메인 카드 그리드 — cards.items 의 첫 5개 (최신순).
 * 전체 보기는 news.html 로 이동.
 */
function renderCards(cards, { lang = "ko" } = {}) {
  const ctaLabel = lang === "en" ? "More" : "자세히";
  const items = cards.items.slice(0, 5).map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const pubAttr = c.pubDate ? ` data-pubdate="${escapeHtml(c.pubDate)}"` : "";
    const catLabel = lang === "en" ? (CATEGORY_LABEL_EN[c.category] || c.categoryLabel) : c.categoryLabel;
    return `      <a class="ccard ${cls}" href="${escapeHtml(href)}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(catLabel)}</span>
          <span class="ccard__time"${pubAttr}>${escapeHtml(c.time)}</span>
        </div>
        <h3>${c.title}</h3>
        <p class="ccard__body">${escapeHtml(c.body)}</p>
        <div class="ccard__meta">
          <div class="src">${renderCardMeta(c)}</div>
          <span class="ccard__cta">${ctaLabel}</span>
        </div>
      </a>`;
  }).join("\n");
  return `\n${items}\n      `;
}

/** 전체 카드 (news.html 용) — 시간순으로 전부. */
function renderAllCards(cards, { lang = "ko" } = {}) {
  const ctaLabel = lang === "en" ? "More" : "자세히";
  const items = cards.items.map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const pubAttr = c.pubDate ? ` data-pubdate="${escapeHtml(c.pubDate)}"` : "";
    const catLabel = lang === "en" ? (CATEGORY_LABEL_EN[c.category] || c.categoryLabel) : c.categoryLabel;
    return `      <a class="ccard ${cls}" href="${escapeHtml(href)}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(catLabel)}</span>
          <span class="ccard__time"${pubAttr}>${escapeHtml(c.time)}</span>
        </div>
        <h3>${c.title}</h3>
        <p class="ccard__body">${escapeHtml(c.body)}</p>
        <div class="ccard__meta">
          <div class="src">${renderCardMeta(c)}</div>
          <span class="ccard__cta">${ctaLabel}</span>
        </div>
      </a>`;
  }).join("\n");
  return items;
}

function renderVideos(videos) {
  // 메인 페이지에는 최신 영상 1개만 노출 (채널 CTA 박스로 유도).
  const items = videos.items.slice(0, 1).map((v, idx) => {
    const thumbCls = VIDEO_THUMB_CLASS[v.category] || "v-stock";
    return `      <a class="vcard" href="${escapeHtml(v.href || "#")}" aria-label="영상 ${idx + 1}">
        <div class="vthumb ${thumbCls}">
          <span class="vthumb__series">${escapeHtml(v.series)}</span>
          <span class="vthumb__num">${escapeHtml(v.thumbnailLabel)}</span>
          <span class="vthumb__dur">${escapeHtml(v.duration)}</span>
        </div>
        <div class="vbody">
          <h4>${escapeHtml(v.title)}</h4>
          <div class="vmeta"><span>${escapeHtml(v.date)}</span><span>· ${escapeHtml(v.views)}</span></div>
        </div>
      </a>`;
  }).join("\n");
  return `\n${items}\n      `;
}

async function readJson(name) {
  const p = path.join(DATA_DIR, name);
  const raw = await readFile(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`[build] ${name} 파싱 실패: ${e.message}`);
  }
}

const SOURCE_LABEL_KR = {
  sec: "1차 자료", official: "공식", press: "외신", rumor: "추측",
};

/**
 * cards.items 의 카드 하나 → 상세 페이지 HTML 1개 생성.
 * article-template.html 의 BLOCK 마커를 카드 데이터로 치환.
 */
function renderArticle(template, card) {
  const catCls = CATEGORY_CLASS[card.category] || "is-stock";
  const srcLabel = card.sourceLabel || "press";
  const srcDot = SOURCE_LABEL_DOT[srcLabel] || "d-press";
  const srcKr = SOURCE_LABEL_KR[srcLabel] || "외신";
  const sourceName = card.sourceName || "외신";

  // summary 단락 분리: \n\n+ 으로 split. 빈 단락 제거.
  const summaryHtml = (card.summary || card.body || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("\n    ");

  const titleTxt = card.title.replace(/<\/?em>/g, "");
  const desc = (card.summary || card.body || "").slice(0, 120).replace(/\n+/g, " ").trim() + "…";

  // article 은 카드 데이터에서 매번 새로 생성되므로 idempotent 필요 없음 →
  // 모든 마커를 keepMarkers: false 로 제거 (attribute 값 안에 들어가도 안전).
  const opts = { keepMarkers: false };
  let out = template;
  out = replaceBlock(out, "A_TITLE_TXT",    escapeHtml(titleTxt + " — Tesla Briefing"), opts);
  out = replaceBlock(out, "A_DESC",         escapeHtml(desc), opts);
  out = replaceBlock(out, "A_CAT_CLASS",    catCls, opts);
  out = replaceBlock(out, "A_CAT_LABEL",    escapeHtml(card.categoryLabel), opts);
  out = replaceBlock(out, "A_TITLE",        card.title, opts);  // <em> 살림
  out = replaceBlock(out, "A_TIME",         escapeHtml(card.time || ""), opts);
  out = replaceBlock(out, "A_SRC_DOT",      srcDot, opts);
  out = replaceBlock(out, "A_SRC_DOT2",     srcDot, opts);
  out = replaceBlock(out, "A_SRC_NAME",     escapeHtml(sourceName), opts);
  out = replaceBlock(out, "A_SRC_NAME2",    escapeHtml(sourceName), opts);
  out = replaceBlock(out, "A_SRC_LABEL_KR", escapeHtml(srcKr), opts);
  out = replaceBlock(out, "A_LEAD",         escapeHtml(card.body || ""), opts);
  out = replaceBlock(out, "A_SUMMARY",      summaryHtml || `<p>${escapeHtml(card.body || "")}</p>`, opts);
  out = replaceBlock(out, "A_HREF",         escapeHtml(card.href || "#"), opts);
  return out;
}

/** {outDir}/news.html — 모든 카드 최신순 그리드. lang 으로 한국어/영어 라벨 분기. */
async function generateNewsPage(cards, { newsTemplateName = "news-template.html", outDir = OUT_DIR, lang = "ko" } = {}) {
  const tplPath = path.join(ROOT, newsTemplateName);
  let template;
  try {
    template = await readFile(tplPath, "utf8");
  } catch {
    console.warn(`[build] ${newsTemplateName} 없음 — news.html 생성 건너뜀`);
    return false;
  }
  const totalLabel = lang === "en" ? `total ${cards.items.length} items` : `총 ${cards.items.length}건`;
  const freshLabel = lang === "en" ? "calculating freshness…" : "갱신 시각 계산 중…";
  // 영어 빌드 시 cards.asOf 의 한국어 텍스트 영문화 (raw 폴백 호환)
  const hasKorean = /[가-힯]/.test(cards.asOf || "");
  const localizedAsOf = (lang === "en" && hasKorean)
    ? `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · sorted by latest`
    : cards.asOf;
  let out = template;
  const freshSince = cards.items[0]?.pubDate || "";
  const newsAsOf = freshSince
    ? `${escapeHtml(`${localizedAsOf} · ${totalLabel}`)} · <span class="cats__fresh" data-fresh-since="${escapeHtml(freshSince)}">${freshLabel}</span>`
    : escapeHtml(`${localizedAsOf} · ${totalLabel}`);
  out = replaceBlock(out, "NEWS_TIME", newsAsOf);
  out = replaceBlock(out, "NEWS_GRID", `\n      ${renderAllCards(cards, { lang })}\n      `);
  await writeFile(path.join(outDir, "news.html"), out, "utf8");
  return true;
}

async function generateArticles(cards, { outDir = OUT_DIR } = {}) {
  const tplPath = path.join(ROOT, "article-template.html");
  let template;
  try {
    template = await readFile(tplPath, "utf8");
  } catch (e) {
    console.warn(`[build] article-template.html 없음 — 상세 페이지 생성 건너뜀`);
    return 0;
  }
  const articlesDir = path.join(outDir, "articles");
  await mkdir(articlesDir, { recursive: true });
  let generated = 0;
  for (const card of cards.items) {
    if (!card.slug) continue;
    const html = renderArticle(template, card);
    await writeFile(path.join(articlesDir, `${card.slug}.html`), html, "utf8");
    generated++;
  }
  return generated;
}

/**
 * 한 언어 빌드. 한국어/영어 각각 호출.
 * @param {Object} opts
 * @param {string} opts.templateName - "home.html" or "home-en.html"
 * @param {string} opts.cardsName    - "cards.json" or "cards-en.json"
 * @param {string} opts.archiveName  - "archive.json" or "archive-en.json"
 * @param {string} opts.newsTemplateName - "news-template.html" or "news-template-en.html"
 * @param {string} opts.outDir
 * @param {string} opts.lang         - "ko" or "en"
 * @param {string} opts.cardsFallback - 폴백 데이터 파일명 (영어가 cards-en.json 없을 때)
 */
async function buildOneLang(opts) {
  const { templateName, cardsName, archiveName, newsTemplateName, outDir, lang, cardsFallback } = opts;
  const templatePath = path.join(ROOT, templateName);

  // 데이터 읽기. cards-en.json 없으면 폴백 (raw-cards.json).
  const template = await readFile(templatePath, "utf8");
  const kpi = await readJson("kpi.json");
  const videos = await readJson("videos.json");
  let cards;
  try {
    cards = await readJson(cardsName);
  } catch {
    if (!cardsFallback) throw new Error(`${cardsName} not found`);
    cards = await readJson(cardsFallback);
    console.log(`[build:${lang}] ${cardsName} 없음 → ${cardsFallback} 폴백`);
  }
  let archive;
  try {
    archive = await readJson(archiveName);
    if (!archive.items || archive.items.length === 0) {
      archive = { ...cards, asOf: cards.asOf };
    }
  } catch {
    archive = { ...cards, asOf: cards.asOf };
  }

  const now = new Date();
  const buildIso = now.toISOString();

  // 라벨 lang 분기
  const hotCountLabel = lang === "en"
    ? `${Math.min(5, cards.items.length)} items`
    : `총 ${Math.min(5, cards.items.length)}건`;
  const freshLabel = lang === "en" ? "calculating freshness…" : "갱신 시각 계산 중…";

  // 영어 빌드에서 cards.asOf 에 한글이 섞여 있으면 (raw 폴백 등) 영문으로 재생성.
  // raw-cards.json 의 asOf 는 한국어("...UTC 기준 · 카테고리당 top 5건") 이라 영어 사이트에 어색.
  const hasKorean = /[가-힯]/.test(cards.asOf || "");
  const localizedCardsAsOf = (lang === "en" && hasKorean)
    ? `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · sorted by latest`
    : cards.asOf;

  let out = template;
  out = replaceBlock(out, "KPI_GRID",    renderKpi(kpi));
  out = replaceBlock(out, "HOT_NEWS",    renderHotNews(cards));
  out = replaceBlock(out, "HOT_COUNT",   hotCountLabel);
  const cardsFreshSince = cards.items[0]?.pubDate || "";
  const cardsAsOf = cardsFreshSince
    ? `${escapeHtml(localizedCardsAsOf)} · <span class="cats__fresh" data-fresh-since="${escapeHtml(cardsFreshSince)}">${freshLabel}</span>`
    : escapeHtml(localizedCardsAsOf);
  out = replaceBlock(out, "CARDS_TIME",  cardsAsOf);
  out = replaceBlock(out, "CARDS_GRID",  renderCards(cards, { lang }));
  out = replaceBlock(out, "VIDEOS_GRID", renderVideos(videos));
  out = replaceBlock(out, "BUILD_INFO",  `<!-- build: ${buildIso} -->`);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "index.html"), out, "utf8");

  const numArticles = await generateArticles(archive, { outDir });
  await generateNewsPage(archive, { newsTemplateName, outDir, lang });

  return { numCards: cards.items.length, numArchive: archive.items.length, numArticles, bytes: out.length };
}

async function main() {
  // ─── Korean (메인) ─────────────────────────────────────────
  const ko = await buildOneLang({
    templateName: "home.html",
    cardsName: "cards.json",
    archiveName: "archive.json",
    newsTemplateName: "news-template.html",
    outDir: OUT_DIR,
    lang: "ko",
  });

  // 정적 자원/페이지/JSON 데이터 — 한 번만 복사 (한·영 공유)
  await cp(ASSETS_DIR, OUT_ASSETS, { recursive: true });
  for (const name of ["article-sample.html", "privacy.html"]) {
    try { await cp(path.join(ROOT, name), path.join(OUT_DIR, name)); }
    catch (e) { console.warn(`[build] skip ${name}: ${e.message}`); }
  }
  await mkdir(path.join(OUT_DIR, "data"), { recursive: true });
  for (const name of ["kpi.json", "musk-live.json"]) {
    try { await cp(path.join(DATA_DIR, name), path.join(OUT_DIR, "data", name)); }
    catch (e) { console.warn(`[build] skip data/${name}: ${e.message}`); }
  }

  // ─── English (옵션) ──────────────────────────────────────
  // home-en.html 이 있으면 영어 빌드 → dist/en/
  let en = null;
  try {
    en = await buildOneLang({
      templateName: "home-en.html",
      cardsName: "cards-en.json",
      cardsFallback: "raw-cards.json",   // cards-en 없으면 raw 영문 그대로
      archiveName: "archive-en.json",
      newsTemplateName: "news-template-en.html",
      outDir: path.join(OUT_DIR, "en"),
      lang: "en",
    });
  } catch (e) {
    console.warn(`[build] English skipped: ${e.message}`);
  }

  // 출력 요약
  const kpiData = await readJson("kpi.json");
  const priceStr = typeof kpiData.price === "number"
    ? `$${kpiData.price.toFixed(2)} (${kpiData.marketStateLabel || kpiData.marketState || "?"})`
    : "(no price)";
  console.log(`[build] OK · price ${priceStr}`);
  console.log(`[build] KO: ${ko.numCards} cards · ${ko.numArchive} archive · ${ko.numArticles} articles · ${ko.bytes} bytes`);
  if (en) console.log(`[build] EN: ${en.numCards} cards · ${en.numArchive} archive · ${en.numArticles} articles · ${en.bytes} bytes`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
