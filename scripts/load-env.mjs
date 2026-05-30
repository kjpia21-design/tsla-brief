/**
 * 의존성 0 .env 로더.
 *
 *   import { loadDotEnv } from "./load-env.mjs";
 *   await loadDotEnv();
 *
 * - 프로젝트 루트의 .env 를 읽어 process.env 에 머지.
 * - 이미 process.env 에 있는 키는 덮어쓰지 않음 (CI 환경 우선).
 * - 파일 없음/읽기 실패는 silent (실패해도 fetch-news 가 폴백으로 동작).
 * - dotenv 같은 패키지 의존성을 만들지 않기 위한 최소 구현.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function loadDotEnv(envPath) {
  const fp =
    envPath ||
    path.join(
      path.dirname(path.dirname(fileURLToPath(import.meta.url))),
      ".env",
    );
  let raw;
  try {
    raw = await readFile(fp, "utf8");
  } catch {
    return; // 파일 없음 — 정상 (CI는 env로 직접 주입)
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 따옴표 벗기기
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // 이미 값이 있으면 덮어쓰지 않음 (CI 환경 우선).
    // 단 빈 문자열로 export 된 경우는 .env 값으로 채움 — shell rc 에 빈 alias 가 깔린 케이스 대응.
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}
