# tesla-briefing-price — TSLA price Worker

Cloudflare Workers (standalone). 5분마다 Yahoo Finance 에서 TSLA 가격 fetch 해서
KV 에 저장. HTTP GET 으로 KV 의 최신 값 반환.

## 아키텍처

```
Scheduled trigger (cron: */5 * * * *)
  └─ Yahoo Finance fetch → KV put (key: "tsla:kpi")

HTTP GET https://tesla-briefing-price.<account>.workers.dev/
  └─ KV get → JSON 반환 (CORS: teslabriefing.com 허용)
```

## 배포 절차 (JP)

### 1. KV namespace 생성
- Cloudflare 대시보드 → **Workers & Pages → KV → Create a namespace**
- 이름: `tesla-briefing-price-kv` (또는 원하는 이름)
- 생성 후 **Namespace ID** 복사

### 2. wrangler.toml 의 KV id 채우기
- `worker/wrangler.toml` 의 `id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"` 부분에 복사한 ID 붙여넣기

### 3. 로컬에서 wrangler 설치 + 배포
```bash
cd worker
npm install -g wrangler          # 한 번만
wrangler login                   # 브라우저로 Cloudflare 인증 (한 번만)
wrangler deploy                  # 배포
```

배포 성공 시 URL 출력: `https://tesla-briefing-price.<account>.workers.dev`

### 4. (선택, 권장) 커스텀 도메인 — `api.teslabriefing.com`
- Cloudflare 대시보드 → 이 Worker → **Settings → Triggers → Custom Domain**
- `api.teslabriefing.com` 추가 → 자동 DNS + SSL

### 5. 클라이언트 fetch URL 변경
- `home.html` + `home-en.html` 의 가격 폴링 script 의
  `URL_ = 'data/kpi.json'` →
  `URL_ = 'https://tesla-briefing-price.<account>.workers.dev/'` (또는 커스텀 도메인)
- 알려주시면 정확한 URL 박아드림

## 검증

```bash
curl https://tesla-briefing-price.<account>.workers.dev/
```

JSON 응답 + 5분마다 `asOf` 시각 갱신 확인.

## 비용

- Cloudflare Workers 무료 한도: 100,000 requests/day
- Cron 트리거: 5분마다 = 일 288회 (제한 없음)
- KV: 무료 한도 일 100,000 reads + 1,000 writes (충분)

모두 무료 한도 안에서 운영 가능.
