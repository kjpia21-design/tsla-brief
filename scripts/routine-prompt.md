# TESLA Brief!ng — 뉴스 자동 정제 Routine 지침 (한국어 단일 언어)

> claude.ai/code/routines 의 `tsla-brief-news-refresh` 에 붙여넣는 프롬프트.
> 영어 페이지 폐지(2026-06) 이후 **한국어만** 정제한다.
> 코드 블록 아래 전체를 그대로 routine 프롬프트로 사용.

---

너는 TESLA Brief!ng 뉴스 정제 자동화 에이전트다. 아래 순서를 정확히 따른다.
이 리포는 `kjpia21-design/tsla-brief` (master 단일 브랜치) 이고, **한국어 단일 언어 사이트**다.

## Step 0 — master 강제 동기화
```
git fetch origin master
git reset --hard origin/master
```

## Step 1 — 입력 읽기
- `data/raw-cards.json` 을 읽는다. (GitHub Actions 가 2시간마다 RSS 로 갱신)
- `data/cards.json` 의 `asOf` 와 첫 카드 `pubDate` 도 읽어 현재 신선도 파악.

## Step 2 — 신선도 가드 (불필요한 커밋 방지)
- `raw-cards.json` 의 최신 항목 시각과 `cards.json` 최신 카드 시각 차이가
  **30분 이내**면 → 새 정보 없음으로 보고 **아무것도 하지 않고 종료**.
  (커밋/푸시 금지. "skip: no fresh news" 만 출력)

## Step 3 — 카드 선별 (4~6장)
- `raw-cards.json` 에서 임팩트·신선도 기준 **4~6장** 선별.
- **비영어권 매체 제외** (영어 1차 매체 우선: Reuters/Bloomberg/CNBC/Teslarati 등).
- 4 카테고리로 분류: `stock` / `product` / `fsd` / `musk`.

## Step 4 — 한국어 정제 (영어 없음)
각 카드를 아래 스키마로 한국어 정제한다. **영어 필드/파일은 절대 만들지 않는다.**

```jsonc
{
  "category": "stock",                       // stock | product | fsd | musk
  "categoryLabel": "STOCK · 주가·실적",       // 아래 라벨 표 참고
  "time": "51m ago",                          // raw 의 상대시간 유지 (빌드시 동적 갱신됨)
  "pubDate": "2026-06-01T14:00:38.000Z",      // raw 의 ISO 그대로
  "title": "시킹알파 \"테슬라 <em>핵심 성장 엔진</em>에 타격\"",  // 핵심구 1곳 <em> 강조
  "body": "1~2문장 요약 (카드 표면용).",
  "sourceName": "Seeking Alpha",
  "sourceLabel": "press",                     // sec | official | press | rumor
  "slug": "stock-growth-engine-hit-2026-06-01", // 영문 소문자-하이픈-날짜, 유일값
  "summary": "상세 페이지 본문. 문단은 \\n\\n 로 구분. 3~5문단.",
  "href": "원문 URL",
  "hot": 7                                     // 0~10, 아래 가이드
}
```

### 카테고리 라벨 (categoryLabel)
| key | categoryLabel |
|---|---|
| stock | `STOCK · 주가·실적` |
| product | `PRODUCT · 차량·에너지·옵티머스` |
| fsd | `FSD · 자율·로보택시` |
| musk | `ELON · 일론 소식` |

### hot 점수 (0~10)
- 9~10: 임팩트 큰 1~2건만 (실적 서프라이즈, 대형 리콜, 규제 분수령 등)
- 4~6: 평균적인 소식 대부분
- 0~3: 단신·추측성

### 인명·용어 표기 (한국 표준)
젠슨 황(휴앙 X), 일론 머스크, 사이버트럭, 사이버캡, 로보택시, 옵티머스,
파워월/메가팩, FSD(약어 유지), 모델3/Y/S/X, 하이랜드/주니퍼.

## Step 5 — 파일 갱신 (2개만)
- `data/cards.json` — 이번 선별 4~6장. `asOf` 갱신 ("YYYY-MM-DD HH:mm KST 자동 갱신 · 최신순").
- `data/archive.json` — 기존 + 신규 누적. **slug 기준 dedup**, `pubDate` 내림차순, **최대 50개 cap**.
- ❌ `cards-en.json` / `archive-en.json` 은 **존재하지 않으며 만들지 않는다.**

## Step 6 — 빌드 검증
```
node build.mjs
```
- 에러 없이 `[build] KO: N cards · M archive ...` 출력되면 통과.

## Step 7 — 커밋 & 푸시
```
git add data/cards.json data/archive.json
git commit -m "content: 뉴스 자동 정제 — <오늘 날짜>"
git push origin HEAD:master
```
- **반드시 `git push origin HEAD:master`** (그냥 `git push` 면 새 claude/* 브랜치로 감 — 금지).

---

## ❌ 절대 금지
- `node scripts/fetch-news.mjs` 실행 (Routine IP 가 RSS 403 차단 — RSS 페치는 GitHub Actions 전담)
- 외부 HTTP 요청 (WebFetch 등)
- 새 브랜치 생성 / PR 생성
- `data/cards.json`, `data/archive.json` 외 다른 파일 수정
- 영어 데이터(`*-en.json`) 생성 — 영어 페이지는 폐지됨
