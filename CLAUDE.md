# TESLA Brief!ng — 프로젝트 컨텍스트 (2026-06-01 갱신)

JP에게 친근한 존댓말로 답해주세요.

## 한 줄 정의

테슬라 주주를 위한, 노이즈 없는 일일 브리핑 — **랜딩 페이지 (한국어 + 영어) + 유튜브 채널 + 뉴스레터**. **라이브 운영 중** — `https://teslabriefing.com` (한) / `https://teslabriefing.com/en/` (영).

## 🚀 빠른 컨텍스트 (새 세션이 가장 먼저 봐야 할 것)

| 항목 | 값 |
|---|---|
| 라이브 도메인 | `teslabriefing.com` (Cloudflare Pages) |
| 영어 페이지 | `/en/` (IP 라우팅 자동, cookie 우선) |
| GitHub 리포 | `kjpia21-design/tsla-brief` (master) |
| Cloudflare Pages | `tesla-briefing` 프로젝트 (manager@honeylife.co.kr account) |
| TSLA 가격 API | `https://api.teslabriefing.com/` (Cloudflare Worker, 5분 cron) |
| 자동 뉴스 정제 | Claude Cloud Routine `tsla-brief-news-refresh` (한국어 + 영어 동시) |
| RSS 자동 페치 | GitHub Actions cron 2시간 (`.github/workflows/fetch-news.yml`) |
| Email 수신 | `hello@teslabriefing.com` → JP Gmail (Cloudflare Email Routing) |
| Email 송신 | 미설정 (옵션 C 보류 — 트래픽 늘면 Resend) |

## ⚠️ Cloudflare 계정 매핑 (중요 — 이전 디버깅 교훈)

| 이메일 | Cloudflare account | 도메인 |
|---|---|---|
| `kjpia21@gmail.com` | `Kjpia21@gmail.com's Account` (id `e461ca0e...`) | **honeylife.co.kr** |
| `manager@honeylife.co.kr` | `Manager@honeylife.co.kr's Account` (id `2cbcaeb2f077b4531901226e856e89e0`) | **teslabriefing.com** ← 본 프로젝트 |

- JP 환경: 크롬 = kjpia21 계정 / 사파리 = manager 계정
- `wrangler login` 시 시스템 기본 브라우저로 OAuth → **사파리를 기본으로 변경 후 인증해야** manager account 잡힘
- 또는 API token (manager account 발급) 을 `CLOUDFLARE_API_TOKEN` 환경변수로
- ❌ 노출 사고 방지: 토큰은 메시지에 적지 말 것

## 자동화 아키텍처

```
┌─ GitHub Actions (cron */2 hours) ──┐
│  • fetch-news.mjs (RSS) → raw-cards.json 갱신 → push
│  • claude/* 브랜치 7일 이상 자동 청소
└─────────────────────────────────────┘
                ↓ master push
┌─ Claude Cloud Routine (cron 2h, offset) ┐
│  • git pull → raw-cards.json 읽기
│  • 한국어 정제 (full) + 영어 정제 (옵션 C — title/slug/hot)
│  • cards.json + archive.json (KR, 50 cap)
│  • cards-en.json + archive-en.json (EN, 50 cap)
│  • git push origin HEAD:master
└─────────────────────────────────────────┘
                ↓ master push
┌─ Cloudflare Pages (자동 빌드) ────────────┐
│  • node build.mjs → dist/
│  • Pages Functions /_middleware → IP 라우팅 (KR → /, 그 외 → /en/)
│  • cookie lang=ko|en 우선
└──────────────────────────────────────────┘

┌─ Cloudflare Worker (별도, cron */5 min) ──┐
│  • Yahoo Finance fetch → KV (PRICE_KV) put
│  • GET / → KV get → JSON (CORS)
│  • Custom Domain: api.teslabriefing.com
│  • 클라이언트 (home.html JS) 1분 폴링
│  • Cloudflare Pages 빌드 트리거 X (별도 endpoint)
└────────────────────────────────────────────┘
```

## 디자인 시스템 (요약)

### 컬러
```css
--bg:#0A0A0B; --bg-2:#111114; --bg-3:#181820;
--line:#2A2A33; --line-mute:#1E1E26;
--ink:#F4F4F5; --ink-mid:#D4D4DC; --ink-mute:#B8B8C0;  /* 모든 텍스트 가독성 ↑ */
--tesla-red:#E31937; --red-deep:#A30E25; --red-soft:rgba(227,25,55,.12);
--up:#16A34A; --down:#EF4444;
```

### 4 카테고리

| 키 | 한국어 라벨 | 영어 라벨 | 액센트 컬러 |
|---|---|---|---|
| `stock`   | STOCK · 주가·실적                | STOCK · Stock & Earnings              | `#E31937` |
| `product` | PRODUCT · 차량·에너지·옵티머스   | PRODUCT · Vehicles, Energy & Optimus  | `#1B6CFF` |
| `fsd`     | FSD · 자율·로보택시              | FSD · Autonomy & Robotaxi             | `#22D3EE` |
| `musk`    | ELON · 일론 소식                 | ELON · Elon News                      | `#F59E0B` |

### 타이포
- 본문: Pretendard Variable
- 숫자·티커·라벨: IBM Plex Mono (tabular-nums)
- 헤드라인 강조 italic: Inter italic
- 로고: SPLIT BLOCK — **[TESLA]** 빨강 박스 + Brief!ng italic (! 빨강)

### 핵심 시그니처
- 카드 좌상단 카테고리 도트 + monospace 라벨
- 카드 ::before 2~3px 컬러 스트라이프
- 동적 시각 갱신 (1분 setInterval, `[data-pubdate]` + `[data-fresh-since]`)
- 가격 박스 1분 폴링 (`api.teslabriefing.com`)
- 핫뉴스 `hot` 점수 정렬 (0~10) vs 최신뉴스 시간순 — **차별화 명확**
- Archive 누적 50개 cap (slug 기준 dedup)

## 사이트 구조 (1페이지 원칙)

한국어 / 영어 동일 구조 (한국어 = `/`, 영어 = `/en/`):
1. **nav** (sticky blur) — 로고 + 카테고리 4 앵커 + **언어 토글 (KO/EN)** + 구독 CTA
2. **가격 바** — 라이브 TSLA $XXX (Worker 5분 cron + 클라이언트 1분 폴링)
3. **핫뉴스** (hot 점수 desc, top 5) — 시간순과 차별화
4. **최신 뉴스** (시간순, top 5) + "뉴스 전체보기" → `news.html` (archive 50개)
5. **영상 섹션** — placeholder 1장 ("첫 영상 준비 중") + 큰 채널 CTA
6. **히어로 + 뉴스레터 구독 폼** (PIPA 필수 동의 체크박스 + 개인정보처리방침 링크)
7. **푸터** — 브랜드 / 카테고리 / 채널 / 정책 (4 컬럼)

### 별도 페이지
- `news.html` / `en/news.html` — archive 전체 (최대 50장)
- `articles/<slug>.html` / `en/articles/<slug>.html` — 카드 상세 (한 / 영 별도)
- `privacy.html` — 개인정보처리방침 (PIPA, 라이트 톤)

## 파일 구조

```
테슬라 정보 랜딩 페이지 및 영상 채널 만들기/
├── CLAUDE.md                          ← 이 파일 (새 세션 entry point)
├── 00-기획서.md
├── README.md (없음, 필요 시 추가)
│
├── home.html                          ← 한국어 메인 (BLOCK 마커)
├── home-en.html                       ← 영어 메인 (대칭)
├── news-template.html                 ← 한국어 전체뉴스 (BLOCK 마커)
├── news-template-en.html              ← 영어 전체뉴스
├── article-template.html              ← 카드 상세 (라이트 톤, 한·영 공유 + lang 분기)
├── article-sample.html                ← 옛 샘플 (정리 대상)
├── privacy.html                       ← 개인정보처리방침 (라이트, 한국어)
├── home-v2.html, mascot-compare.html  ← 옛 백업 (정리 가능)
│
├── build.mjs                          ← KR + EN 빌드 (buildOneLang)
├── .nvmrc                             ← Node 22 (Cloudflare Pages)
│
├── functions/
│   └── _middleware.js                 ← Pages Functions IP 라우팅 (KR → / / 그 외 → /en/)
│
├── worker/                            ← Cloudflare Worker (별도 배포)
│   ├── src/index.js                   ← TSLA 가격 5분 cron + KV + GET endpoint
│   ├── wrangler.toml                  ← KV id `4b782cd93a074f778e5442cebcb919fe`
│   └── README.md                      ← 배포 가이드
│
├── scripts/
│   ├── fetch-news.mjs                 ← RSS → raw-cards.json (SEED_OUT/WINDOW/N env)
│   ├── fetch-price.mjs                ← Yahoo (로컬·옛 흐름, worker 가 대체)
│   ├── llm-refine.mjs                 ← (사용 안 함 — Routine 이 대체)
│   └── load-env.mjs                   ← (사용 안 함)
│
├── data/
│   ├── raw-cards.json                 ← GitHub Actions 가 2h 마다 갱신 (영문 RSS)
│   ├── cards.json                     ← Routine 한국어 정제 (4~6장)
│   ├── cards-en.json                  ← Routine 영어 정제 (옵션 C)
│   ├── archive.json                   ← 누적 한국어 (50 cap)
│   ├── archive-en.json                ← 누적 영어 (50 cap)
│   ├── kpi.json                       ← (legacy, worker 가 대체)
│   ├── videos.json                    ← 영상 placeholder (1장)
│   └── musk-live.json                 ← (legacy, 미사용)
│
├── assets/
│   ├── favicon.svg                    ← 빨강 박스 + 흰 T (01번 채택)
│   ├── og-image.svg                   ← 1200x630 SNS 카드 (한국어)
│   ├── stamp-verified.svg
│   ├── mascot-A-cybertruck.svg
│   └── mascot-B-optimus.svg
│
├── .github/workflows/
│   └── fetch-news.yml                 ← cron 2h: fetch + claude/* 청소
│
├── dist/                              ← gitignore. Cloudflare Pages 빌드 출력
│   ├── index.html                     ← 한국어
│   ├── news.html
│   ├── articles/*.html                ← archive 전체 (slug 있는 모든 카드)
│   ├── privacy.html
│   ├── en/                            ← 영어
│   │   ├── index.html
│   │   ├── news.html
│   │   └── articles/*.html
│   ├── data/                          ← kpi.json 등 (legacy, 미사용)
│   └── assets/
│
└── .nvmrc                             ← 22
```

## 빌드·자동화 명령

```bash
# 로컬 빌드 (한국어 + 영어 동시)
node build.mjs

# 로컬에서 신선한 RSS 페치
node scripts/fetch-news.mjs

# 일회용 시드 (3일치 더 많이)
SEED_OUT=raw-archive-seed.json SEED_WINDOW=3d SEED_N=15 node scripts/fetch-news.mjs

# Worker 배포 (manager account, 사파리 OAuth)
cd worker && wrangler deploy

# 로컬 미리보기 (이미 띄워져 있을 수도)
# .claude/launch.json 의 tsla-static (port 4173, dist/ 서빙)
```

## 데이터 흐름 (수동·자동 둘 다)

### 자동 (JP 손 안 가도)
1. GitHub Actions (cron 2h) — fetch-news.mjs → `raw-cards.json` 갱신 → push
2. Claude Cloud Routine (cron 2h, offset 권장) — git pull → 한국어+영어 정제 → push
3. Cloudflare Pages 자동 빌드 → 라이브
4. Worker (cron 5분, 별도) — Yahoo Finance → KV → `api.teslabriefing.com` 응답

### 수동 트리거 (JP 요청 시)
- 가장 빠른 신선화: 로컬 `node scripts/fetch-news.mjs && git add data/raw-cards.json && git commit -m "raw" && git push`
- Routine [Run now] 도 신선도 가드 (30분 이내 차이면 skip)

## Routine prompt (현재 운영 중)

위치: `claude.ai/code/routines` → `tsla-brief-news-refresh`

핵심:
- Step 0: `git fetch origin master + reset --hard` (master 강제 체크아웃)
- Step 1~2: raw-cards 읽기 + 신선도 가드 (30분 이내 skip)
- Step 3: 4~6장 선별 (비영어권 매체 제외)
- Step 4: 한국어 (full) + 영어 (slug + title + hot 만, 옵션 C) 정제
- Step 5: cards/archive 4 파일 갱신 (slug dedup, pubDate desc, 50 cap)
- Step 6: `node build.mjs` 검증
- Step 7~8: commit + `git push origin HEAD:master` (HEAD:master 형식 필수)

❌ 절대 금지: `node scripts/fetch-news.mjs` (Routine IP 가 RSS 403 차단), 외부 HTTP, 새 브랜치 생성, PR 생성, 다른 파일 수정.

✅ 인명 표기 가이드 (한국 표준): 젠슨 황 (휴앙 X), 일론 머스크, 사이버트럭, 사이버캡, 로보택시, 옵티머스, 파워월/메가팩, FSD (약어), 모델3/Y/S/X, 하이랜드/주니퍼

✅ hot 점수 (0~10): 9~10 임팩트 큰 1~2건만, 평균 4~6

## 작업 회고 (큰 그룹 7개 — 92 tasks 압축)

1. **초기 디자인 + 영상 (#1~24)** — Remotion TSLA daily briefing 영상 + mobile-v1.html
2. **데이터 파이프라인 (#25~46)** — fetch-news (RSS) + LLM 정제 모듈 + 가격 페처 + cards.json schema + 카드 컴팩트화 + 상세 페이지 자동 생성 + news.html
3. **브랜드 정착 (#47~58)** — Tesla Brief!ng SPLIT BLOCK 로고 (10개 후보 → 9번) + 라이트 톤 article 페이지 + 뉴스레터 폼 + PIPA 동의 + privacy.html
4. **배포 + 가짜 정리 (#59~67)** — 가상 정보 제거 + Cloudflare Pages + teslabriefing.com 도메인 + 가짜 카드 8장 → placeholder → 실제 RSS 첫 발행 (4장)
5. **자동화 1차 (#68~78)** — fetch-news v2 (카테고리당 5건) + 시각 동적 갱신 + GitHub Actions cron + Routine prompt + 즉시 raw 갱신 + archive 누적 (50 cap) + 핫뉴스 hot 점수 차별화 + claude/* 청소
6. **i18n 본격 (#79~87)** — "뉴스 전체보기" + 3일치 시드 (25장 archive) + 영어 페이지 골격 + build.mjs 두 언어 + IP 라우팅 + 토글 + SEO + 영어 데이터 시드 + 한국어 잔여 제거 + TESLA 로고 통일 (TSLA → TESLA)
7. **Worker + 자산 (#88~92)** — TSLA 가격 5분 cron Worker + api.teslabriefing.com Custom Domain + favicon (01번 채택) + og-image + 메타 태그 + Email Routing 수신

## 결정 보류 항목

- **이메일 송신** (`hello@` 으로 보내기) — Resend SMTP + Gmail Send-as. 현재 수신만 운영, 트래픽 늘면 진행.
- **fetch-news 화이트리스트** — Reuters/Bloomberg/CNBC tier-1 우선, 비영어권 자동 제외. 정제 품질 ↑.
- **OG 이미지 PNG 변환** — X/페이스북 SVG og:image 미지원 시 호환성 보강.
- **kjpia21 account 의 옛 Worker + KV 정리** — `tesla-briefing-price` (kjpia21 의 거) + KV `3d0fd1c4...` 삭제 (비용 0 이라 급하진 않음).

## 다음 작업 후보 (시간 들어가는 것부터)

| # | 작업 | 시간 |
|---|---|---|
| 1 | **유튜브 첫 영상 제작** + 사이트 영상 섹션 갱신 | 큰 작업 |
| 2 | **뉴스레터 발송 시스템** — Resend + 구독 폼 백엔드 + Cloudflare Workers/Pages Functions | 1~2시간 |
| 3 | **OG 이미지 PNG 변환** | 30분 |
| 4 | **fetch-news 화이트리스트** | 30분 |
| 5 | **이메일 송신** (Resend + Gmail Send-as) | 15~20분 |
| 6 | **kjpia21 account 옛 자원 정리** | 5분 |
| 7 | 사이트 미세 디자인 튜닝 (로고 크기 등) | 즉시 |

## 주의사항·함정 (디버깅 교훈)

1. **Cloudflare 계정 매핑** — manager@honeylife.co.kr = teslabriefing.com. 모든 Worker/KV/Domain 작업은 manager account 로.
2. **wrangler login** — macOS 기본 브라우저로 OAuth. 사파리 (manager) 로 가야. 또는 API token + `CLOUDFLARE_API_TOKEN` env.
3. **Routine push** — 반드시 `git push origin HEAD:master`. 그냥 `git push` 면 새 `claude/*` 브랜치로 가짐.
4. **fetch-news.mjs 절대 Routine 안에서 실행 X** — Routine 환경 IP 가 RSS 403 차단. RSS 페치는 GitHub Actions 만.
5. **Cloudflare Pages 무료 빌드 한도** — 월 500. 현재 cron 2h (월 360) 안전 영역.
6. **`*/N` 패턴 JSDoc 주석 안에 쓰면 esbuild 실패** — JSDoc `*/` 가 종료 마커. 주석에선 "every N minutes" 같은 영어로.
7. **카카오톡/슬랙은 OG SVG 받음, X/페이스북은 미흡** — 필요 시 PNG 변환.

## 코딩 컨벤션

- HTML/CSS 1파일 컴포지션 (허라피 패턴). React 없음.
- CSS 변수 `:root` 한 번, 페이지마다 복붙 OK.
- 숫자 = `class="mono"` 또는 `IBM Plex Mono` + `tabular-nums`.
- 한글 헤드라인 `<em>` italic monospace 강조.
- 의존성 0 (Node 22 native fetch). worker/ 는 wrangler 만.
- commit 메시지: `feat:` / `fix:` / `chore:` / `style:` / `content:` 접두사 + 한국어 본문.
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` 마지막 줄.

## 참고 레포지토리

- `~/Documents/Claude/Projects/허니라이프 채널 & 사이트 빌드업` — 디자인 시스템 원형 (허라피)
- `~/my-shorts-generator` — Remotion 영상 렌더 (TSLA 시리즈 확장 가능)
- `~/news-brief` — 5단계 딜 파이프라인 뉴스 브리프

## 새 세션 빠른 시작 패턴

```
# 1. CLAUDE.md 자동 로드됨 (현재 파일)
# 2. 최근 commit 확인
git log --oneline -10

# 3. 라이브 사이트 상태 확인 (선택)
curl -s https://api.teslabriefing.com/ | python3 -m json.tool   # 가격 라이브
# 또는 WebFetch teslabriefing.com

# 4. 결정 보류 / 다음 작업 후보 확인 → JP 와 다음 진행 결정
```
