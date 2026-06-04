#!/usr/bin/env node
/**
 * Phase B — 장기 아카이브 누적기
 *
 *   node scripts/archive-merge.mjs
 *
 * data/archive.json(롤링 100건, Routine 이 매번 재작성) 을
 * data/archive-full.json(영구 누적 이력) 에 append-only 로 합친다.
 *
 *  - slug(없으면 title) 기준 dedup. 롤링본의 최신 정제 버전을 우선.
 *  - pubDate 내림차순. CAP(기본 2000) 상한 — 무한 증식 방지.
 *  - GitHub Actions(fetch-news.yml)에서 매 2시간 실행 → archive-full.json 갱신/커밋.
 *    (롤링이 100건=3~4일치라, 2h 머지면 카드가 100에서 밀려나기 전 충분히 포착)
 *
 * 의존성 0.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROLLING = path.join(ROOT, "data", "archive.json");
const FULL = path.join(ROOT, "data", "archive-full.json");
const BLOCK = path.join(ROOT, "data", "blocklist.json");
const CAP = Number(process.env.ARCHIVE_FULL_CAP || 2000);

async function readJsonSafe(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch { return fallback; }
}

const key = (c) => c.slug || c.title || "";

// 재발행 옛 기사 등 영구 차단 — 누적 단계에서도 걸러 archive-full.json 을 깨끗하게 유지.
function blockedFn(subs) {
  return (c) => {
    const hay = `${c.title || ""} ${c.slug || ""} ${c.href || ""} ${c.summary || ""} ${c.body || ""}`.toLowerCase();
    return subs.some((s) => hay.includes(s));
  };
}

async function main() {
  const rolling = await readJsonSafe(ROLLING, { items: [] });
  const full = await readJsonSafe(FULL, { items: [] });
  const subs = ((await readJsonSafe(BLOCK, { substrings: [] })).substrings || []).map((s) => s.toLowerCase());
  const isBlocked = blockedFn(subs);

  const bySlug = new Map();
  // 기존 이력 먼저
  for (const c of full.items || []) {
    const k = key(c);
    if (k) bySlug.set(k, c);
  }
  // 롤링본으로 덮어쓰기 — 같은 slug 면 더 최신 정제 버전 채택
  let added = 0;
  for (const c of rolling.items || []) {
    const k = key(c);
    if (!k) continue;
    if (!bySlug.has(k)) added += 1;
    bySlug.set(k, c);
  }

  let items = [...bySlug.values()]
    .filter((c) => !isBlocked(c))   // 차단 목록 제외
    .sort((a, b) => (Date.parse(b.pubDate || 0) || 0) - (Date.parse(a.pubDate || 0) || 0));
  const before = items.length;
  items = items.slice(0, CAP);

  const out = {
    asOf: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · 누적 ${items.length}건 (slug dedup, pubDate desc, cap ${CAP})`,
    items,
  };
  await writeFile(FULL, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`[archive-merge] +${added} new · 누적 ${items.length}건${before > CAP ? ` (cap ${CAP} 적용, ${before - CAP}건 절삭)` : ""}`);
}

main().catch((err) => {
  console.error(`[archive-merge] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
