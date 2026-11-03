# web — 키오스크 및 관리자 화면

`web/kiosk`는 Vite 기반의 Vanilla JS 프론트엔드입니다.

- 운영 주소: **https://library-kiosk.kimkisoo0505.workers.dev** (관리자: `/#/admin`)
- 배포 방식: Cloudflare Workers Static Assets (Pages가 Workers로 통합된 최신 방식). 코드 없이 `dist/`만 올리는 별도 Worker `library-kiosk`이며, API 서버(`library-seat-api`)와 분리되어 있습니다.
- 자동 배포: `web/kiosk/**` 변경이 `main`에 push되면 [deploy-kiosk.yml](../.github/workflows/deploy-kiosk.yml) 실행
- 수동 배포: `cd web\kiosk; npm run deploy` (**반드시 web/kiosk 폴더에서 실행** — 다른 폴더의 wrangler.toml이 읽히면 엉뚱한 Worker가 배포됨)
- 운영 API 주소는 [.env.production](kiosk/.env.production)에 있고, API의 `ALLOWED_ORIGINS`에 키오스크 주소가 등록되어 있어야 합니다.
- 보안 헤더(CSP 등): [public/_headers](kiosk/public/_headers)

## 화면

| 경로 | 화면 | 인증 |
|---|---|---|
| `#/` | 좌석 현황, 학생 로그인, 예약/취소/착석/퇴실 | 학생 세션 (좌석 현황은 비로그인 조회 가능) |
| `#/admin` | 좌석 관리(점검 전환, 예약 해제), 이벤트 로그 | 관리자 세션 (학생 세션과 분리) |

## 구조

```
kiosk/
├── index.html
├── vite.config.js          /api → 127.0.0.1:8787 프록시 (WebSocket 포함)
├── public/favicon.svg
└── src/
    ├── main.js             해시 라우터
    ├── api.js              REST 클라이언트, 학생/관리자 토큰 분리 보관
    ├── websocket.js        좌석 변경 알림 구독 (자동 재연결)
    ├── style.css
    ├── components/         seat-card, seat-map, login-form
    └── pages/              home(키오스크), admin(관리자)
```

## 실행

```powershell
cd web\kiosk
npm install
npm run dev       # http://localhost:5173  (백엔드: cloudflare 에서 npx wrangler dev)
npm run build     # dist/ 생성
```

## 환경 변수 (선택)

`web/kiosk/.env.local`(gitignore 대상)에 설정합니다. 비워두면 같은 Origin의 `/api`를 사용합니다.

```
VITE_API_BASE=https://library-seat-api.example.workers.dev/api
VITE_WS_URL=wss://library-seat-api.example.workers.dev/api/ws
```

`VITE_` 변수는 브라우저에 그대로 노출되므로 비밀 값을 넣지 마세요.

## 동작 원칙

- 예약 결과는 서버 응답으로만 판단하며, 요청 후에는 성공/실패와 무관하게 좌석 목록을 다시 조회합니다.
- 서버와 연결되지 않으면 예약 버튼을 비활성화합니다.
- 공용 키오스크 특성상 90초 동안 입력이 없으면 자동 로그아웃합니다.
- 사용자 데이터는 `textContent`로만 화면에 넣습니다 (XSS 방지).
