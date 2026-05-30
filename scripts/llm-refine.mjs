/**
 * TSLA Brief — LLM 정제기
 *
 *   import { refineCards } from "./llm-refine.mjs";
 *   const refined = await refineCards(rawCards);
 *
 * RSS 영문 헤드라인+요약을 한국어 친근 톤으로 정제하고, 제목의 핵심어를
 * `<em>...</em>` 으로 강조한다. CLAUDE.md 톤("냉정한 친절함, 사라/팔라 안 함")을
 * 따른다.
 *
 * - 의존성 0 (Node 22 native fetch 사용)
 * - Anthropic Messages API raw HTTP 호출
 * - 시스템 프롬프트는 cache_control (ephemeral) 로 캐싱 — 반복 호출 비용 ~90% 감소
 * - 구조화 출력 (output_config.format json_schema) 으로 파싱 안전
 * - 호출 실패·키 누락·스키마 위반 시 원문 카드 유지 (silent fallback)
 *
 * 환경 변수:
 *   ANTHROPIC_API_KEY  (필수. 없으면 정제 건너뜀)
 *   TSLA_LLM_MODEL     (옵션. 기본 claude-opus-4-7)
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_MODEL = "claude-opus-4-7";
const MAX_TOKENS = 2048;

// ─────────────────────────────────────────────────────────
// 시스템 프롬프트 — 캐시 대상 (큰 부분 첫 위치)
// ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `너는 테슬라 주주를 위한 일일 브리핑 사이트 "테슬라 브리핑" 의 카피 에디터다.

# 톤·정책
- 냉정한 친절함. 사라거나 팔라고 말하지 않는다.
- 흥분·공포·과장 없이, 의사결정에 필요한 재료만 전달.
- 머스크 발언 카드는 "발언 자체" 와 "회사 영향" 을 분리해서 다룬다. 추측이면 "외신 보도 단계" "공식 가이던스 아님" 같은 식으로 명시.
- 출처가 약한 정보(루머·관측)는 단정하지 말고 "신호가 잡혔다", "보도됐다" 같은 표현을 사용.
- 영문 원문의 클릭베이트(전부 대문자, 자극적 형용사, "Shocking", "Insane")는 모두 제거.

# 입력 형식
사용자 메시지는 JSON 배열로 카드 4개를 준다. 각 카드는:
{ "category": "stock|product|fsd|musk", "title_en": "...", "body_en": "..." }

# 출력 형식 (JSON Schema 강제)
{ "cards": [ { "category": "...", "title": "...", "body": "..." }, ... ] }

- 출력 카드 순서는 입력 순서와 동일. category 필드도 그대로 복사.
- title: 한국어 한 문장, 28~48자 권장. 핵심 키워드 1~2개를 \`<em>...</em>\` 로 감쌈.
  강조 대상 예: 수치(49.2만대, +1.84%), 모델명(Cybertruck → 사이버트럭), 버전(v13.4), 핵심 행동(가격 인하, 인증, 양산).
  강조는 최대 2개. 너무 길게 감싸지 않는다 (보통 2~6자).
- body: 한국어 1~2 문장, 60~120자. title과 단어 중복을 피한다.
  본문은 "왜 중요한지" 또는 "맥락(근거·출처)" 를 한 줄 더 깔아주는 역할.
- 영문 인용이 필요하면 큰따옴표 안에 영어 그대로. 한국어 본문에 자연스럽게 흡수되게.

# 카테고리별 추가 지침
- stock: 수치는 가능한 한 살림. 분석가 컨센서스·옵션 시장 시그널·인도량 같은 데이터.
- product: 모델명·가격·시장·인증 등 사실 위주. "최고의" 같은 형용사 자제.
- fsd: 버전·마일·간격·기능 차이 위주. 테슬라 자체 측정치는 "테슬라 발표 기준" 표시.
- musk: "머스크가 X에 ~라고 말했다" 형태 권장. 공식 발표와 분리.

# 예시 (few-shot)

입력:
[{"category":"stock","title_en":"Tesla Q2 deliveries beat estimates at 466K, Wall Street raises price targets","body_en":"Tesla reported 466,000 vehicle deliveries in Q2, exceeding the consensus estimate of 449,000. Several analysts including Morgan Stanley and Goldman Sachs raised their price targets."}]

출력:
{"cards":[{"category":"stock","title":"Q2 인도량 <em>46.6만대</em>, 컨센서스 상회","body":"월가 예상치 44.9만대를 넘기면서 모건스탠리·골드만삭스 등이 목표주가를 상향. 발표 직후 외신 7건이 같은 톤으로 보도됐다."}]}

입력:
[{"category":"musk","title_en":"Elon Musk says Robotaxi will be in 'few cities by end of next year' in X reply","body_en":"Musk responded to a user question about Robotaxi timeline by saying robotaxi will be available in a few cities by end of next year. Tesla has not made any official statement matching this."}]

출력:
{"cards":[{"category":"musk","title":"머스크, <em>로보택시 양산 캘린더</em> 재확인","body":"X 답글에서 \\"내년 말 몇몇 도시 상용 운행\\" 입장 유지. 같은 시점 회사 공식 발표는 없어 발언 단계로만 받아두면 된다."}]}
`;

// ─────────────────────────────────────────────────────────
// 출력 JSON Schema — 모델이 반드시 이 형태로 답함
// ─────────────────────────────────────────────────────────

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["stock", "product", "fsd", "musk"] },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["category", "title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["cards"],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────
// 메인 호출
// ─────────────────────────────────────────────────────────

/**
 * 입력 cards 의 title·body 를 한국어 + `<em>` 강조로 정제.
 * 실패 시 (키 누락, 네트워크 실패, 스키마 위반) 원본 그대로 반환.
 *
 * @param {Array<{category:string,title:string,body:string,sources?:object,time?:string,href?:string}>} cards
 * @returns {Promise<Array>}
 */
export async function refineCards(cards) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[llm-refine] ANTHROPIC_API_KEY 미설정 — 원문 유지");
    return cards;
  }
  if (!Array.isArray(cards) || cards.length === 0) return cards;

  // LLM 입력은 원문만 — 다른 메타는 함께 안 보냄 (캐싱 안정성 + 입력 최소화)
  const llmInput = cards.map((c) => ({
    category: c.category,
    title_en: c.title,
    body_en: c.body,
  }));

  const body = {
    model: process.env.TSLA_LLM_MODEL || DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    // adaptive thinking — Opus 4.7 권장. budget_tokens 제거됨.
    thinking: { type: "adaptive" },
    output_config: {
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      effort: "medium",
    },
    // 시스템 프롬프트 캐싱 — 매일 같은 prefix 라 반복 호출 시 큰 절감
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: JSON.stringify(llmInput),
      },
    ],
  };

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    console.warn(`[llm-refine] 네트워크 실패 (${e.message}) — 원문 유지`);
    return cards;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.warn(`[llm-refine] HTTP ${res.status} — 원문 유지\n  ${errText.slice(0, 240)}`);
    return cards;
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.warn(`[llm-refine] JSON 파싱 실패 — 원문 유지`);
    return cards;
  }

  // 응답 구조: content = [ {type:"thinking",...}? , {type:"text", text: "..."} , ...]
  // 첫 text 블록이 우리가 강제한 JSON.
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock || !textBlock.text) {
    console.warn(`[llm-refine] text 블록 없음 (stop_reason=${data.stop_reason}) — 원문 유지`);
    return cards;
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    console.warn(`[llm-refine] 모델 응답 JSON 파싱 실패 — 원문 유지`);
    return cards;
  }

  if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length !== cards.length) {
    console.warn(
      `[llm-refine] 응답 카드 수 불일치 (받음=${parsed?.cards?.length}, 기대=${cards.length}) — 원문 유지`,
    );
    return cards;
  }

  // 캐시 적중률 로깅 (가능한 경우)
  const usage = data.usage || {};
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  console.log(
    `[llm-refine] OK · in=${input} out=${output} cache_read=${cacheRead} cache_write=${cacheWrite}`,
  );

  // 카드별 매핑 — 입력 순서 그대로 매핑하되 category 일치 검사
  return cards.map((orig, i) => {
    const refined = parsed.cards[i];
    if (!refined || refined.category !== orig.category) {
      console.warn(
        `[llm-refine] 카드 #${i} category 불일치 (입력=${orig.category}, 출력=${refined?.category}) — 원문 유지`,
      );
      return orig;
    }
    return {
      ...orig,
      title: refined.title,
      body: refined.body,
    };
  });
}
