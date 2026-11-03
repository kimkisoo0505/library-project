# cloudflare — API 서버 (Workers + D1 + Durable Objects)

## 구조

```
cloudflare/
├── wrangler.toml.example        설정 예시 (복사해서 wrangler.toml 생성, 커밋 금지)
├── workers/
│   ├── index.js                 진입점: fetch 라우팅, scheduled(cron) 처리
│   ├── router.js                경량 라우터, JSON 응답/오류, 이벤트 로그 유틸
│   ├── auth.js                  학생/관리자 로그인 분리, 세션, 장치 토큰 인증
│   ├── seats.js                 좌석 조회, 관리자 좌석 상태 변경, 브로드캐스트, WS 연결
│   ├── reservations.js          예약/취소/착석/퇴실/만료, 관리자 해제, 장치 이벤트
│   └── durable-objects/
│       └── seat-room.js         WebSocket 연결 보관 및 변경 알림 중계
└── database/
    ├── schema.sql               전체 스키마 참조본
    └── migrations/0001_initial.sql
```

## 로컬 실행

> 아래 명령은 **로컬 에뮬레이션**만 사용합니다. `--remote` 옵션이나 `deploy`는 실제 Cloudflare 리소스를 변경하므로 준비가 끝난 뒤에만 실행하세요.

```powershell
cd cloudflare
copy wrangler.toml.example wrangler.toml
# 로컬 개발용 비밀 값 (gitignore 대상)
Set-Content .dev.vars "DEVICE_TOKEN=<임의의 긴 문자열>" -Encoding utf8

npx wrangler d1 migrations apply library-seat-db --local
npx wrangler dev
# http://127.0.0.1:8787/api/health
```

로컬 D1에는 학생/관리자 계정이 없습니다. 테스트 계정은 명백한 가짜 값(예: `TEST-0001`)으로만 만들고,
비밀번호 해시는 `auth.js`의 `hashPassword()` 형식(`pbkdf2_sha256$...`)을 따릅니다.
(계정 발급 도구는 아직 미구현 — [DEVELOPMENT.md](../docs/DEVELOPMENT.md) 참고)

## 자동 배포 (GitHub Actions)

`main` 브랜치에 `cloudflare/**` 변경이 push되면 [deploy-worker.yml](../.github/workflows/deploy-worker.yml)이 실행됩니다.

```
push ──▶ check (문법 · 스키마 · wrangler dry-run)
              │ 통과 + main 브랜치
              ▼
         deploy: wrangler.toml 생성 → D1 마이그레이션(--remote) → wrangler deploy
```

- PR에서는 check만 실행되며 비밀 값을 사용하지 않습니다.
- Secrets가 없으면 deploy는 경고를 남기고 건너뜁니다.
- `wrangler.toml`은 저장소에 없고, CI가 `wrangler.toml.example` + Secrets로 생성합니다.
- GitHub Actions 탭에서 **Run workflow**로 수동 실행도 가능합니다.

### 최초 1회 설정

1. **D1 생성** — Cloudflare 대시보드 → Storage & Databases → D1 → Create → 이름 `library-seat-db` → Database ID 복사
2. **계정 ID** — 대시보드 Workers & Pages 개요 화면 오른쪽의 Account ID 복사
3. **API 토큰** — My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" 템플릿 선택 후 권한에 `Account · D1 · Edit` 추가, 계정 범위를 본인 계정으로 제한
4. **GitHub Secrets** — 저장소 Settings → Secrets and variables → Actions → New repository secret

   | 이름 | 값 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 3번 토큰 |
   | `CLOUDFLARE_ACCOUNT_ID` | 2번 ID |
   | `D1_DATABASE_ID` | 1번 ID |

   선택: Variables 탭에 `ALLOWED_ORIGINS` (예: `https://<pages 도메인>,http://localhost:5173`)
5. **workers.dev 서브도메인** — 대시보드 Workers & Pages에 처음 들어가면 서브도메인 등록 안내가 나옵니다. 등록하지 않으면 배포가 실패합니다.
6. **첫 배포 후 장치 토큰 등록** (CI에서는 다루지 않음, 한 번 등록하면 유지됨)
   ```powershell
   npx wrangler login
   npx wrangler secret put DEVICE_TOKEN
   ```

### 수동 배포 (비상용)

```powershell
npx wrangler login
npx wrangler d1 migrations apply library-seat-db --remote
npx wrangler deploy
```

## 설계 요점

- 좌석 상태의 기준은 D1. Durable Object는 알림만 중계하며 상태를 저장하지 않는다.
- 중복 예약 방지: `reservations`의 부분 UNIQUE 인덱스 + 조건부 INSERT/UPDATE (자세한 내용은 [DATABASE.md](../docs/DATABASE.md)).
- 모든 상태 변경과 인증 이벤트는 `events` 테이블에 기록된다.
- 장치 요청은 `DEVICE_TOKEN`이 없으면 503으로 거부된다 (fail-closed).
