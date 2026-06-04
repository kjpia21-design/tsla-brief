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
- 🥇 **출처 신뢰도 우선순위** — 같은 사안을 여러 카드가 다룰 때, 또는 채택 여부가 애매할 때는
  **1차·공식 자료를 우선 채택**한다. 우선순위:
  `sec`(SEC 공시·NHTSA 규제기관) > `official`(테슬라/일론 공식) > `press`(외신·전문매체) > `rumor`(커뮤니티·추측).
  raw 카드의 `sourceLabel` 필드로 등급이 표시돼 있다(fetch 단계에서 자동 부여).
  특히 raw 에 `sec`(예: "Tesla 8-K …", "NHTSA recall …", "Elon Musk Form 4 …") 카드가 있으면
  웬만하면 빠뜨리지 말고 포함한다 — 가끔만 들어오는 고가치 1차 정보다.
- 🐦 X(트위터) 카드 처리 — sourceName 에 "(X)" 가 붙은 카드는 공식 계정(일론·테슬라·임원 → `official`)
  또는 큐레이터·애널리스트(→ `press`) 의 트윗이다. 트윗은 짧고 비격식이므로:
  ① 단순 잡담·홍보·밈은 제외하고 **주주에게 의미 있는 발표·수치·정책만** 채택.
  ② 채택 시 한국어로 **맥락을 보강**해 카드 제목·요약을 다듬는다(원문 트윗 직역 금지).
  ③ 일론/테슬라 타사(SpaceX·xAI 등) 트윗은 musk 카테고리가 맞지만, 테슬라 본업과 무관한
     단신은 hot 점수를 낮춘다.
- 🎭 **유머·풍자 판별 (X 필수 게이트)** — X 는 농담·풍자·밈·과장·가정법이 일상이다.
  트윗을 뉴스 카드로 만들기 전, **"문자 그대로의 사실 주장인가, 유머/풍자/가정인가"** 를 반드시 판단한다.
  - ✅ 뉴스 채택: **구체적·검증 가능한 사실**(출시·수치·공식 발표·공시·일정)일 때만.
  - ❌ 드롭: 농담·반어·밈·감정적 반응·가정('~라면')·과장된 단언으로 보이면 **카드로 만들지 않는다**.
  - 🚩 유머 신호: 비현실적·황당한 주장(예: "테슬라가 축구 구단 인수"), 펀치라인·이모지(😂🤣💀)·"lol",
    인용/대댓글 리액션, "Made on Earth by humans" 같은 밈 문구의 농담조 사용.
  - ⚖️ **교차검증(가장 강력)**: 놀랍거나 큰 주장(인수·대규모 수치·중대 발표)이 **X 에만** 있고
    로이터·블룸버그·CNBC 등 **보도가 전혀 없으면 → 농담/미확인으로 보고 제외**.
    (단, SEC·NHTSA·테슬라 공식 발표 등 1차 자료는 자체로 사실이므로 예외.)
  - 🤡 **특히 @elonmusk 계정은 밈·농담 비중이 매우 높다** — 문자 그대로 옮기지 말고, 사실성·시의성을
    한 번 더 검증한 뒤에만 채택.
- ⚠️ **옛 기사 재발행 의심 검사**: RSS 가 오래된 글을 새 pubDate 로 재발행하는 사고가 있다.
  내용이 현재 시점과 명백히 안 맞으면 (예: 이미 출시된 제품을 "예정/계획"으로 서술,
  'Model E'(=모델3 옛 코드명) 처럼 폐기된 명칭, 수년 전 이벤트를 신규처럼 서술) **제외**한다.
  날짜만 믿지 말고 내용의 시의성을 함께 판단.
- 🚫 **차단 목록 준수**: `data/blocklist.json` 의 substring 이 제목/slug/href/요약 어디든 포함되면
  **무조건 제외**(cards.json·archive.json 둘 다). 특히 'Model E 스틸 차체/기가캐스팅' 류 옛 기사는
  절대 다시 넣지 말 것. (빌드·누적 단계에서도 자동 차단되지만, 정제 단계에서 먼저 거른다.)

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

### sourceLabel 부여 규칙 (출처 신뢰도 — 사이트·뉴스레터에 배지로 노출)
- **원칙: raw 카드의 `sourceLabel` 을 그대로 유지**한다(도메인 기반 자동 분류라 대체로 정확).
  명백히 틀린 경우에만 아래 기준으로 교정한다.
| 값 | 의미 | 부여 기준 |
|---|---|---|
| `sec` | 1차 자료 | SEC 공시(8-K/10-Q/10-K/Form 4), NHTSA·정부 규제기관, 테슬라 IR 직접 |
| `official` | 공식 | 테슬라/일론/제품 공식 채널(tesla.com, 공식 X 계정)의 직접 발언 |
| `press` | 외신 | Reuters·Bloomberg·CNBC·Electrek·Teslarati 등 보도 매체 |
| `rumor` | 추측 | 커뮤니티·익명·블로그·"~할 수도" 추측성 |
- ⚖️ **교차 검증**: `rumor`/추측성 소식을 채택할 땐 가능하면 `press` 이상 매체가 같은 내용을
  보도했는지 확인하고, 확인되면 그 매체를 `sourceName`/`href` 로 삼아 등급을 올린다.
  확인 안 되는 단독 추측은 hot 점수를 낮추거나 제외한다.

## Step 5 — 파일 갱신 (2개만)
- `data/cards.json` — 이번 선별 4~6장. `asOf` 갱신 ("YYYY-MM-DD HH:mm KST 자동 갱신 · 최신순").
- `data/archive.json` — 기존 + 신규 누적. **slug 기준 dedup**, `pubDate` 내림차순, **최대 100개 cap**.
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
