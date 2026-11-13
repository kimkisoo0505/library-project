# web — 키오스크 및 관리자 화면

`web/kiosk`는 Vite 기반의 Vanilla JS 프론트엔드입니다.

- 운영 주소: **https://library-kiosk.kimkisoo0505.workers.dev** (관리자: `/#/admin`)
- 배포 방식: Cloudflare Workers Static Assets (Pages가 Workers로 통합된 최신 방식). 코드 없이 `dist/`만 올리는 별도 Worker `library-kiosk`이며, API 서버(`library-seat-api`)와 분리되어 있습니다.
- 자동 배포: `web/kiosk/**` 변경이 `main`에 push되면 [deploy-kiosk.yml](../.github/workflows/deploy-kiosk.yml) 실행
- 수동 배포: `cd web\kiosk; npm run deploy` (**반드시 web/kiosk 폴더에서 실행** — 다른 폴더의 wrangler.toml이 읽히면 엉뚱한 Worker가 배포됨)
- 운영 API 주소는 [.env.production](kiosk/.env.production)에 있고, API의 `ALLOWED_ORIGINS`에 키오스크 주소가 등록되어 있어야 합니다.
- 보안 헤더(CSP 등): [public/_headers](kiosk/public/_headers)

## 화면

| 경로 | 화면 | 코드 | 인증 |
|---|---|---|---|
| `#/kiosk` | **키오스크 모드** 학생 화면: 입구 등 공용 기기용. 개인 기능 없음, 90초 동안 입력이 없으면 자동 로그아웃 | `src/kiosk/` | 학생 세션 (좌석 현황은 비로그인 조회 가능) |
| `#/personal` | **개인 사용 모드** 학생 화면: 본인 휴대폰·앱용. 블루투스 좌석 자동 연장, 가까운 열람실 찾기(GPS·카카오맵), 자동 로그아웃 없음 | `src/personal/` | 학생 세션 |
| `#/admin` | 좌석 관리(점검 전환, 예약 해제, 호수, 배치 편집), 장치, 이벤트 로그 | `src/admin/` | 관리자 세션 (학생 세션과 분리) |
| `#/` (그 외) | 저장된 모드 → 없으면 기기 기본값(휴대폰 = 개인 사용, 그 외 = 키오스크)으로 이동. 앱(WebView)은 항상 개인 사용 | `src/common/routes.js` | — |

키오스크 · 개인 사용 · 관리자는 **각각 별개의 코드**입니다 (2026-11-13 나눔: 학생 화면은 복제해 두 개로, 관리자는 자기 폴더로).
각 폴더가 자기 화면 코드 · 부품(components/) · 스타일(style.css)을 가지며, 한쪽을 고쳐도 다른 쪽에 영향이 없습니다.
여러 화면에 있는 같은 부품의 버그는 해당 폴더들을 모두 고쳐야 합니다 (예: 좌석 배치도는 세 폴더에 각각 있음 —
관리자 배치 편집 미리보기는 admin/components/seat-map.js). 서버 통신 등 `src/common/` 만 함께 씁니다.
다른 화면으로 이동하면(모드 전환, 학생 ↔ 관리자) 페이지를 새로 열어 각 화면의 CSS 가 섞이지 않게 합니다.

## 구조

```
kiosk/
├── index.html
├── vite.config.js          /api → 127.0.0.1:8787 프록시 (WebSocket 포함)
├── public/                 kgu-logo.png(상단 바 로고), favicon-16/32.png · apple-touch-icon.png(탭 아이콘), _headers
├── src/
│   ├── main.js             해시 라우터 (화면별 코드를 필요할 때만 불러옴)
│   ├── common/             공용: api.js(REST, 학생/관리자 토큰 분리), websocket.js(좌석 변경 알림),
│   │                       app-detect.js(앱 감지), usage-mode.js(모드 기본값·저장·전환), routes.js(주소 결정),
│   │                       test-accounts.js(시연용 테스트 계정 안내),
│   │                       campus-buildings.js(수원캠퍼스 건물 목록·좌표·강의실 위치 형식 — 관리자·개인 화면 공용)
│   ├── kiosk/              키오스크 모드: home.js, style.css, components/(seat-card, seat-map, room-tabs,
│   │                       login-form, central-library, system-status)
│   ├── personal/           개인 사용 모드: home.js, style.css, components/(위와 같은 목록),
│   │                       web-ble.js(브라우저 블루투스), app-bridge.js(앱 WebView 연동),
│   │                       nearby.js·geo.js·kakao-map.js·components/nearby-card.js(가까운 열람실: 위치·거리·지도)
│   └── admin/              관리자 화면: admin.js, style.css, components/(layout-editor, seat-map, seat-card,
│                           room-tabs, login-form, location-picker(건물 목록 + 호실 숫자 키패드))
└── tests/                  npm test (node --test): 모드·주소·블루투스(가짜 Pi)
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
