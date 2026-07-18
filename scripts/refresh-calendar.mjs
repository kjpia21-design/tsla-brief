// 투자자 캘린더 추정치 롤포워드 — GitHub Actions 가 월 1회 실행.
// 외부 HTTP 없음(순수 날짜 패턴). 테슬라 분기 실적·인도 일정의 "과거 패턴 기반 잠정치"를
// 항상 다가오는 N건으로 채워둔다. 지나간 일정은 자동으로 빠지고 다음 분기가 들어온다.
//
// 공식 확정일 반영 방법(보존됨):
//   data/calendar.json 의 해당 이벤트에서 date 를 공식일로 고치고 tentative 를 false 로 바꾸면,
//   이 스크립트가 key 로 인식해 추정치로 덮어쓰지 않고 그대로 보존한다.
//
// 과거 패턴(추정): P&D=분기 종료 다음 달 2일, 실적 발표=약 3주 뒤(분기별 22~23일 / Q4는 익년 1/28).
//   - 2024·2025 P&D 모두 4/2·7/2·10/2·1/2, 실적 7/23 등으로 일관 → 추정 신뢰도 높으나 공식 아님.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CAL_PATH = path.join(ROOT, "data", "calendar.json");
const HORIZON = 6; // 다가오는 일정 노출 개수(약 7~9개월치 = "3개월 이상")

/** 한 해의 분기 추정 일정 8건 (P&D 4 + 실적 4). Q4 는 익년 1월. */
function quarterEstimates(year) {
  const y1 = year + 1;
  return [
    { key: `${year}-Q1-pd`,       date: `${year}-04-02`, title: `Q1 ${year} 차량 인도·생산 실적 발표`, title_en: `Q1 ${year} Production & Delivery report` },
    { key: `${year}-Q1-earnings`, date: `${year}-04-23`, title: `Q1 ${year} 실적 발표·컨퍼런스콜`,     title_en: `Q1 ${year} Earnings call` },
    { key: `${year}-Q2-pd`,       date: `${year}-07-02`, title: `Q2 ${year} 차량 인도·생산 실적 발표`, title_en: `Q2 ${year} Production & Delivery report` },
    { key: `${year}-Q2-earnings`, date: `${year}-07-23`, title: `Q2 ${year} 실적 발표·컨퍼런스콜`,     title_en: `Q2 ${year} Earnings call` },
    { key: `${year}-Q3-pd`,       date: `${year}-10-02`, title: `Q3 ${year} 차량 인도·생산 실적 발표`, title_en: `Q3 ${year} Production & Delivery report` },
    { key: `${year}-Q3-earnings`, date: `${year}-10-22`, title: `Q3 ${year} 실적 발표·컨퍼런스콜`,     title_en: `Q3 ${year} Earnings call` },
    { key: `${year}-Q4-pd`,       date: `${y1}-01-02`,   title: `Q4 ${year} 차량 인도·생산 실적 발표`, title_en: `Q4 ${year} Production & Delivery report` },
    { key: `${year}-Q4-earnings`, date: `${y1}-01-28`,   title: `Q4 ${year} 실적 발표·컨퍼런스콜`,     title_en: `Q4 ${year} Earnings call` },
  ];
}

const now = new Date();
const todayISO = now.toISOString().slice(0, 10);
const year = now.getUTCFullYear();

// 후보: 작년~내후년 추정치 중 오늘 이후, 가까운 순.
const candidates = [year - 1, year, year + 1, year + 2]
  .flatMap(quarterEstimates)
  .filter((e) => e.date >= todayISO)
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// 기존 데이터에서 확정(tentative:false) 일정은 key 로 보존.
let existing = { events: [] };
try { existing = JSON.parse(await readFile(CAL_PATH, "utf8")); } catch { /* 최초 실행 */ }
const confirmed = new Map();
for (const e of existing.events || []) {
  if (e && e.key && e.tentative === false) confirmed.set(e.key, e);
}

// 분기 패턴 후보에 없는 확정 이벤트(주총 등 비분기 일정, 또는 후보 날짜가 지나 후보에서 빠진 확정일)도 미래면 보존.
const candidateKeys = new Set(candidates.map((c) => c.key));
const extraConfirmed = [...confirmed.values()]
  .filter((e) => e.date >= todayISO && !candidateKeys.has(e.key));
const merged = [...candidates.map((e) => (confirmed.has(e.key) ? confirmed.get(e.key) : { ...e, tentative: true })), ...extraConfirmed]
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  .slice(0, HORIZON);

const out = {
  asOf: todayISO,
  note: "분기 실적·인도 일정은 테슬라 공식 발표 전 과거 패턴 기반 잠정치입니다. 공식 확정 시 해당 이벤트의 date 를 고치고 tentative 를 false 로 바꾸면 보존됩니다(scripts/refresh-calendar.mjs).",
  events: merged,
};

// 이벤트 배열이 동일하면 파일을 건드리지 않음(불필요한 커밋 방지).
const same = JSON.stringify(existing.events || []) === JSON.stringify(merged);
if (same) {
  console.log("[calendar] 변경 없음 — 다음 일정", merged[0]?.date, merged[0]?.title);
} else {
  await writeFile(CAL_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`[calendar] 갱신 ${merged.length}건 · 가장 가까운: ${merged[0]?.date} ${merged[0]?.title}`);
}
