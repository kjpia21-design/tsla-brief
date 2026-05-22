# TSLA Brief — 프로젝트 컨텍스트

JP에게 친근한 존댓말로 답해주세요.

## 한 줄 정의

테슬라 주주를 위한, 노이즈 없는 일일 브리핑 — **랜딩 페이지(원페이지) + 유튜브 채널 + 뉴스레터**.

## 타겟·톤

- **독자:** 테슬라 주주·예비 주주·장기 보유자. 단타 아님.
- **톤:** 냉정한 친절함. "사라/팔라" 말하지 않음. 의사결정 재료만.
- **머스크 발언:** "발언 자체"와 "회사 영향"을 분리해서 다룸.
- **출처 카운트 4단계:** 🟢 1차 자료 / 🔵 공식 발언 / 🟡 신뢰 외신 / 🟠 추측·루머. 카드 메타에 도트+카운트로 노출.

## 4 카테고리

| 키 | 한글명 | 액센트 컬러 | 시리즈 배지 |
|---|---|---|---|
| `stock`   | 주가·실적   | `--c-stock: #E31937` | `STOCK`   |
| `product` | 신차·제품   | `--c-product: #1B6CFF` | `PRODUCT` |
| `fsd`     | FSD·자율주행 | `--c-fsd: #22D3EE`   | `FSD`     |
| `musk`    | 머스크·일론  | `--c-musk: #F59E0B`  | `MUSK`    |

## 사이트 구조 (랜딩 1페이지 원칙)

카테고리 전용 페이지 **없음**. 한 페이지에 위→아래 순서:

1. nav (sticky, blur) — 로고 + 카테고리 4 앵커 + 구독 CTA
2. 히어로 + 뉴스레터 구독 폼 (메인 액션이 구독)
3. 주가·시총 KPI 위젯 (5칸: Price / Market Cap / 52W Range / P/E / Next Earnings)
4. 4개 카테고리 최신 이슈 카드 (2×2 grid)
5. 유튜브 최신 영상 그리드 6개 (3×2)
6. 푸터 (브랜드 / 카테고리 / 채널 / 정책 4컬럼)

추후 트래픽 보고 카테고리 페이지 분리 여부 결정.

## 디자인 시스템 (요약 — 전체 토큰은 home-v1.html `:root` 참조)

### 컬러

```css
--bg:#0A0A0B; --bg-2:#111114; --bg-3:#181820;
--line:#2A2A33; --line-mute:#1E1E26;
--ink:#F4F4F5; --ink-mid:#B8B8C0; --ink-mute:#707078;
--tesla-red:#E31937; --red-deep:#A30E25; --red-soft:rgba(227,25,55,.12);
--up:#16A34A; --down:#EF4444;
```

### 타이포

- 본문: **Pretendard Variable**
- 숫자·티커·라벨: **IBM Plex Mono** (tabular-nums) — 주가, %, 시총, 날짜
- 헤드라인 강조 italic: **Inter italic** — h1/h3 안 `<em>`만 italic 처리

### 시그니처 디테일

- 카드: `border-radius: var(--r-lg)` (18px), border 1px solid `--line`, hover 시 카테고리 컬러 + `--shadow-red` 발광
- 카드 좌상단 카테고리 도트 (`box-shadow` glow) + monospace 라벨
- 카드 우상단 시간 (`14h ago`, monospace)
- 카드 ::before 2~3px 컬러 스트라이프
- CTA 화살표 `→`: hover 시 `gap: 4px → 10px` 분리
- 영상 썸네일: 사진 없이 **단색 그라데이션 + 거대 italic 라벨** (`Q2`, `13.4`, `Y` 등)
- 뉴스레터 폼: `:focus` 시 red soft glow

## 마스코트

**확정안: A — 사이버트럭 실루엣** (`assets/mascot-A-cybertruck.svg`).
B(옵티머스 헤드, `assets/mascot-B-optimus.svg`)는 비교 검토용으로 보존.

**노출 원칙 (허라비와 동일하게 절제):**
1. nav 로고 (28~30px)
2. footer 브랜드 (56~80px)
3. "출처 검증 도장" SVG (220px, 추후 콘텐츠 페이지에서 사용)

작은 사이즈 시인성을 위해 검증 도장 패턴은 sample 콘텐츠 페이지 만들 때 별도 작업.

## 영상 채널 (별도 레포: `~/my-shorts-generator`)

`my-shorts-generator`의 허라비 스타일(`summer-electricity-tier3-themed`)을 다크 변형으로 차용. 다음 작업 시 그쪽에 TSLA 시리즈 컴포지션 추가.

- 다크 배경(`#0A0A0B`) + 레드 액센트
- 인트로: 3줄 카드 스택 + 우상단 `VERIFIED` 또는 `SOURCE.SEC` 도장 + 마스코트
- 본문 비트: `POINT 01~N` + monospace 데이터 박스
- 자막: 검정 박스 + 흰 글씨 (허라비 ThemedSubtitle 그대로)
- 보이스: `ko-KR-Chirp3-HD-*` 차분 톤 후보
- 시리즈 배지: STOCK / PRODUCT / FSD / MUSK

## 뉴스레터

- **발송:** 평일 오전 7시 KST (장 시작 전)
- **분량:** 평일 약 800자, 주말 정리편 1500자
- **구조:** 어제 종가 한 줄 → 오늘의 한 줄(3문장) → 4 카테고리 1~2 헤드라인 → 읽을거리 2~3 링크 → 푸터

## 파일 구조 (현재)

```
테슬라 정보 랜딩 페이지 및 영상 채널 만들기/
├── CLAUDE.md                          ← 이 파일
├── 00-기획서.md                       ← 전체 기획서 (긴 버전)
├── home-v1.html                       ← 랜딩 v1 (템플릿, BLOCK 마커 포함)
├── mascot-compare.html                ← 마스코트 A/B 비교 (참조용, 추후 정리 가능)
├── build.mjs                          ← JSON → home.html 빌드 (의존성 0)
├── data/                              ← 1시간마다 갱신될 카드/KPI/영상 데이터
│   ├── kpi.json
│   ├── cards.json
│   └── videos.json
├── dist/                              ← 빌드 산출물 (gitignore, Pages 배포 대상)
│   └── home.html
├── .github/workflows/
│   └── update.yml                     ← cron 1h + Pages 배포
└── assets/
    ├── mascot-A-cybertruck.svg        ← 채택
    └── mascot-B-optimus.svg           ← 백업 보존
```

## 빌드 파이프라인 (1시간 주기 업데이트)

**아키텍처:** ① 정적 재생성(SSG) + ② 클라이언트 fetch 자리 마련(머스크 라이브 박스용, 미구현).

```
home-v1.html (BLOCK 마커 포함)
       +
data/{kpi,cards,videos}.json   ←  cron 으로 갱신 (데이터 수집기 미구현)
       ↓
   node build.mjs
       ↓
   dist/home.html  →  GitHub Pages 배포
```

### 마커 규칙

`home-v1.html` 안에 `<!-- BLOCK:NAME --> ... <!-- /BLOCK:NAME -->` 쌍으로 치환 영역을 표시.
현재 마커: `KPI_TIME`, `KPI_GRID`, `CARDS_TIME`, `CARDS_GRID`, `VIDEOS_GRID`, `BUILD_INFO`.
마커 사이에 샘플 데이터를 그대로 두면 v1 도 단독으로 브라우저에서 정상 표시됨.

### 데이터 스키마 약속

- **카드 출처 카운트:** `{ sec, official, press, rumor }` 4단계. 0 인 항목은 렌더 시 생략.
- **출처 표시 순서:** SEC(🟢 1차) → OFFICIAL(🔵 공식) → PRESS(🟠 외신) → RUMOR(⚪ 추측) 로 통일.
- **카드 제목·바디:** `<em>...</em>` 강조는 데이터(JSON) 안에 마크업 그대로. 빌드는 이 부분만 escape 하지 않음.

### 빌드 명령

```bash
node build.mjs            # dist/home.html 생성
python3 -m http.server 5734    # 로컬 미리보기 (preview tool: tsla-static)
```

### 현재 상태

- ✅ JSON ↔ HTML 분리 + 빌드 스크립트 완성
- ✅ GitHub Actions cron 1h + Pages 배포 워크플로 작성
- ⏳ **데이터 수집기 미구현** — `data/*.json` 은 현재 정적 샘플. cron 돌려도 결과 동일(멱등).
- ⏳ GitHub 리모트·Pages 활성화 미진행

## 다음 작업 후보

번호순 우선순위 추천:

1. **데이터 수집기** — news-brief 어댑터 또는 RSS 페처. 출력 = `data/cards.json` 등. 카테고리 자동 분류 + 출처 4단계 라벨링이 핵심.
2. **GitHub 리모트 + Pages 활성화** — 리포 만들고 워크플로 동작 확인.
3. **머스크 라이브 박스 (②번 fetch)** — RSS Bridge / 수동 큐레이션으로 시작. 페이지에 `<section id="musk-live">` 슬롯 추가하고 클라이언트 폴링(10분).
4. **home-v2 디자인 튜닝** — 다크 톤 강도, 카드 간격, hero 카피 등 디테일 반복. 허라비 home-v1~v5 패턴.
5. **모바일 v1 (`mobile-v1.html`)** — 768px 이하 전용. 허라비 mobile-v1 참조 가능 (`~/Documents/Claude/Projects/허니라이프 채널 & 사이트 빌드업/mobile-v1.html`).
6. **뉴스레터 HTML 템플릿** (`newsletter-template.html`) — 실제 발송 가능한 인라인 스타일 메일.
7. **출처 검증 도장 SVG** (`assets/stamp-verified.svg`) — 허라비 `bee-stamp-verified.svg` 패턴 차용, 마스코트 A 임베드.
8. **샘플 콘텐츠 상세 페이지** (`sample-stock-q1-earnings.html`) — 출처 4단계가 어떻게 본문에 노출되는지 보여주는 모범 페이지.
9. **`my-shorts-generator`에 TSLA 시리즈 컴포지션 추가** — 다크 변형 디자인 시스템 컴포넌트 확장.

## 코딩 컨벤션

- HTML/CSS 1파일 컴포지션 (허라비처럼). React 도입은 영상 작업할 때만(`my-shorts-generator` 쪽).
- CSS 변수는 `:root`에 한 번 정의, 페이지마다 복붙 OK (허라비와 동일 원칙 — 강한 일관성).
- 숫자는 항상 `class="mono"` 또는 `font-family: IBM Plex Mono` + `font-variant-numeric: tabular-nums`.
- 한글 헤드라인 안에 `<em>`으로 강조하는 단어를 italic monospace 처리.
- 외부 폰트 CDN 호출 안 함 (Pretendard Variable, Inter, IBM Plex Mono은 시스템에 깔려 있다고 가정). 필요 시 `home-v1.html`에 fallback 체인 이미 구성.

## 참고 레포지토리

- `~/Documents/Claude/Projects/허니라이프 채널 & 사이트 빌드업` — 디자인 시스템 원형. home-v5, topics-finance, sample-welfare-tips-ep05를 참조하세요.
- `~/my-shorts-generator` — 영상 렌더링. `src/components/tips/`, `src/compositions/tips-themed/SingleTopicVideo.tsx`.
- `~/news-brief` — 5단계 딜 파이프라인 뉴스 브리프 (테슬라 어닝/M&A 코멘트에 동일 우선순위 적용 가능).
