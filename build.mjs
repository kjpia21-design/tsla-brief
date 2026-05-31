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
function renderHotNews(cards) {
  const top = cards.items.slice(0, 5);
  const items = top.map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const short = CATEGORY_SHORT[c.category] || "NEWS";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const pubAttr = c.pubDate ? ` data-pubdate="${escapeHtml(c.pubDate)}"` : "";
    // 제목에 <em> 마크업이 박혀있으니 escape 하지 않고 그대로 살림.
    return `      <li><a class="hot-news__item ${cls}" href="${escapeHtml(href)}">
        <span class="hot-news__cat">${escapeHtml(short)}</span>
        <span class="hot-news__time"${pubAttr}>${escapeHtml(c.time || "")}</span>
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
function renderCards(cards) {
  const items = cards.items.slice(0, 5).map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const pubAttr = c.pubDate ? ` data-pubdate="${escapeHtml(c.pubDate)}"` : "";
    return `      <a class="ccard ${cls}" href="${escapeHtml(href)}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(c.categoryLabel)}</span>
          <span class="ccard__time"${pubAttr}>${escapeHtml(c.time)}</span>
        </div>
        <h3>${c.title}</h3>
        <p class="ccard__body">${escapeHtml(c.body)}</p>
        <div class="ccard__meta">
          <div class="src">${renderCardMeta(c)}</div>
          <span class="ccard__cta">자세히</span>
        </div>
      </a>`;
  }).join("\n");
  return `\n${items}\n      `;
}

/** 전체 카드 (news.html 용) — 시간순으로 전부. */
function renderAllCards(cards) {
  const items = cards.items.map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const pubAttr = c.pubDate ? ` data-pubdate="${escapeHtml(c.pubDate)}"` : "";
    return `      <a class="ccard ${cls}" href="${escapeHtml(href)}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(c.categoryLabel)}</span>
          <span class="ccard__time"${pubAttr}>${escapeHtml(c.time)}</span>
        </div>
        <h3>${c.title}</h3>
        <p class="ccard__body">${escapeHtml(c.body)}</p>
        <div class="ccard__meta">
          <div class="src">${renderCardMeta(c)}</div>
          <span class="ccard__cta">자세히</span>
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

/** dist/news.html — 모든 카드 최신순 그리드. */
async function generateNewsPage(cards) {
  const tplPath = path.join(ROOT, "news-template.html");
  let template;
  try {
    template = await readFile(tplPath, "utf8");
  } catch {
    console.warn(`[build] news-template.html 없음 — news.html 생성 건너뜀`);
    return false;
  }
  let out = template;
  const freshSince = cards.items[0]?.pubDate || "";
  const newsAsOf = freshSince
    ? `${escapeHtml(`${cards.asOf} · 총 ${cards.items.length}건`)} · <span class="cats__fresh" data-fresh-since="${escapeHtml(freshSince)}">갱신 시각 계산 중…</span>`
    : escapeHtml(`${cards.asOf} · 총 ${cards.items.length}건`);
  out = replaceBlock(out, "NEWS_TIME", newsAsOf);
  out = replaceBlock(out, "NEWS_GRID", `\n      ${renderAllCards(cards)}\n      `);
  await writeFile(path.join(OUT_DIR, "news.html"), out, "utf8");
  return true;
}

async function generateArticles(cards) {
  const tplPath = path.join(ROOT, "article-template.html");
  let template;
  try {
    template = await readFile(tplPath, "utf8");
  } catch (e) {
    console.warn(`[build] article-template.html 없음 — 상세 페이지 생성 건너뜀`);
    return 0;
  }
  const outDir = path.join(OUT_DIR, "articles");
  await mkdir(outDir, { recursive: true });
  let generated = 0;
  for (const card of cards.items) {
    if (!card.slug) continue;
    const html = renderArticle(template, card);
    await writeFile(path.join(outDir, `${card.slug}.html`), html, "utf8");
    generated++;
  }
  return generated;
}

async function main() {
  const [template, kpi, cards, videos] = await Promise.all([
    readFile(TEMPLATE_PATH, "utf8"),
    readJson("kpi.json"),
    readJson("cards.json"),
    readJson("videos.json"),
  ]);

  const now = new Date();
  const buildIso = now.toISOString();

  let out = template;
  // KPI_TIME 마커는 가격 박스 안 data-pb-asof 로 흡수 — 더 이상 home.html 에 없음.
  out = replaceBlock(out, "KPI_GRID",    renderKpi(kpi));
  out = replaceBlock(out, "HOT_NEWS",    renderHotNews(cards));
  out = replaceBlock(out, "HOT_COUNT",   `총 ${Math.min(5, cards.items.length)}건`);
  const cardsFreshSince = cards.items[0]?.pubDate || "";
  const cardsAsOf = cardsFreshSince
    ? `${escapeHtml(cards.asOf)} · <span class="cats__fresh" data-fresh-since="${escapeHtml(cardsFreshSince)}">갱신 시각 계산 중…</span>`
    : escapeHtml(cards.asOf);
  out = replaceBlock(out, "CARDS_TIME",  cardsAsOf);
  out = replaceBlock(out, "CARDS_GRID",  renderCards(cards));
  out = replaceBlock(out, "VIDEOS_GRID", renderVideos(videos));
  out = replaceBlock(out, "BUILD_INFO",  `<!-- build: ${buildIso} -->`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, out, "utf8");
  await cp(ASSETS_DIR, OUT_ASSETS, { recursive: true });

  // 카드별 상세 페이지 — cards.json 의 slug 가 있는 각 카드마다 1개씩.
  const numArticles = await generateArticles(cards);
  // 전체 뉴스 목록 페이지 — 모든 카드 최신순.
  await generateNewsPage(cards);

  // 추가 정적 페이지 — 빌드 마커는 없지만 사이트의 일부로 같이 배포.
  for (const name of ["article-sample.html", "privacy.html"]) {
    const src = path.join(ROOT, name);
    try {
      await cp(src, path.join(OUT_DIR, name));
    } catch (e) {
      console.warn(`[build] skip ${name}: ${e.message}`);
    }
  }

  // 클라이언트 fetch 대상 JSON (가격 박스·머스크 라이브 박스) 복사.
  // home.html 의 폴링 스크립트가 dist/data/{kpi,musk-live}.json 을 직접 fetch.
  await mkdir(path.join(OUT_DIR, "data"), { recursive: true });
  for (const name of ["kpi.json", "musk-live.json"]) {
    const src = path.join(DATA_DIR, name);
    try {
      await cp(src, path.join(OUT_DIR, "data", name));
    } catch (e) {
      console.warn(`[build] skip data/${name}: ${e.message}`);
    }
  }

  const priceStr = typeof kpi.price === "number"
    ? `$${kpi.price.toFixed(2)} (${kpi.marketStateLabel || kpi.marketState || "?"})`
    : "(no price)";
  console.log(`[build] OK → ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`[build] price ${priceStr} · ${cards.items.length} cards · ${numArticles} articles · ${videos.items.length} videos · ${out.length} bytes · ${buildIso}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
