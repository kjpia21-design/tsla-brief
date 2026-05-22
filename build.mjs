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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(ROOT, "home-v1.html");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "dist");
// GitHub Pages 호환을 위해 index.html 로 출력. 템플릿은 home-v1.html 그대로.
const OUT_PATH = path.join(OUT_DIR, "index.html");

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

function replaceBlock(html, name, replacement) {
  const re = new RegExp(
    `<!--\\s*BLOCK:${name}\\s*-->[\\s\\S]*?<!--\\s*/BLOCK:${name}\\s*-->`,
    "g"
  );
  if (!re.test(html)) {
    throw new Error(`[build] BLOCK:${name} 마커가 home-v1.html 에 없습니다.`);
  }
  return html.replace(
    new RegExp(
      `<!--\\s*BLOCK:${name}\\s*-->[\\s\\S]*?<!--\\s*/BLOCK:${name}\\s*-->`,
      "g"
    ),
    `<!-- BLOCK:${name} -->${replacement}<!-- /BLOCK:${name} -->`
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 제목·바디에는 <em> 강조 마크업이 들어 있으므로 그대로 살림(이미 콘텐츠 작성자가 의도한 것).
// 나머지 텍스트 필드는 escapeHtml 적용.

function renderKpi(kpi) {
  const items = kpi.items.map((it) => {
    let third = "";
    if (it.delta) {
      const dir = it.delta.direction === "down" ? "down" : "up";
      third = `<span class="kpi__delta ${dir}">${escapeHtml(it.delta.text)}</span>`;
    } else if (it.sub) {
      third = `<span class="kpi__sub">${escapeHtml(it.sub)}</span>`;
    }
    return `      <div class="kpi">
        <span class="kpi__label">${escapeHtml(it.label)}</span>
        <span class="kpi__value">${escapeHtml(it.value)}</span>
        ${third}
      </div>`;
  }).join("\n");
  return `\n${items}\n      `;
}

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

function renderCards(cards) {
  const items = cards.items.map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    return `      <a class="ccard ${cls}" href="${escapeHtml(c.href || "#")}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(c.categoryLabel)}</span>
          <span class="ccard__time">${escapeHtml(c.time)}</span>
        </div>
        <h3>${c.title}</h3>
        <p class="ccard__body">${escapeHtml(c.body)}</p>
        <div class="ccard__meta">
          <div class="src">
            ${renderSources(c.sources || {})}
          </div>
          <span class="ccard__cta">자세히</span>
        </div>
      </a>`;
  }).join("\n");
  return `\n${items}\n      `;
}

function renderVideos(videos) {
  const items = videos.items.map((v, idx) => {
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
  out = replaceBlock(out, "KPI_TIME",    escapeHtml(kpi.asOf));
  out = replaceBlock(out, "KPI_GRID",    renderKpi(kpi));
  out = replaceBlock(out, "CARDS_TIME",  escapeHtml(cards.asOf));
  out = replaceBlock(out, "CARDS_GRID",  renderCards(cards));
  out = replaceBlock(out, "VIDEOS_GRID", renderVideos(videos));
  out = replaceBlock(out, "BUILD_INFO",  `<!-- build: ${buildIso} -->`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, out, "utf8");

  const sizes = {
    template: template.length,
    output: out.length,
    kpi: kpi.items.length,
    cards: cards.items.length,
    videos: videos.items.length,
  };
  console.log(`[build] OK → ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`[build] ${sizes.kpi} KPI · ${sizes.cards} cards · ${sizes.videos} videos · ${sizes.output} bytes · ${buildIso}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
