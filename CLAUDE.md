# CLAUDE.md — 프로젝트 규칙

이 파일은 이 저장소에서 작업하는 Claude Code와 개발자가 따라야 할 규칙입니다.

## 프로젝트 개요

30석 도서관 열람실 좌석 예약·관리 시스템.
웹 키오스크(Cloudflare Pages) ↔ API(Workers) ↔ D1 / Durable Objects ↔ 라즈베리파이 에이전트 ↔ Arduino.

## 기술 스택

| 영역 | 스택 | 비고 |
|---|---|---|
| 프론트엔드 | Vite + Vanilla JS (ES Modules) | `web/kiosk`, 프레임워크 없음. Workers Static Assets(`library-kiosk`, 구 Pages)로 배포 |
| 백엔드 | Cloudflare Workers (ES Module 문법) | `cloudflare/workers` |
| DB | Cloudflare D1 (SQLite) | `cloudflare/database` |
| 실시간 | Durable Objects + WebSocket Hibernation API | `SeatRoom` 클래스 |
| 현장 에이전트 | Python 3.13 (asyncio, pyserial, httpx, websockets) | Raspberry Pi OS Lite 32-bit |
| 하드웨어 | Arduino UNO R3, 115200bps 줄 단위 ASCII 프로토콜 | `arduino/protocol/SERIAL_PROTOCOL.md` |

## 디렉터리 구조

```
docs/            설계 문서 (아키텍처, API, DB, 하드웨어, 개발 절차)
raspberry-pi/    현장 하드웨어 에이전트 (agent/, tests/, systemd/)
arduino/         펌웨어(firmware/) 및 시리얼 프로토콜 문서(protocol/)
cloudflare/      Workers 코드(workers/), D1 스키마/마이그레이션(database/)
web/kiosk/       키오스크 및 관리자 웹 화면 (Vite)
scripts/         개발 PC / 라즈베리파이 환경 점검 스크립트
```

## 핵심 규칙 (반드시 지킬 것)

1. **좌석 상태의 최종 기준은 D1이다.** 라즈베리파이·브라우저는 캐시만 가진다. 클라이언트 측에서 예약을 "승인"하는 코드를 만들지 않는다.
2. **중복 예약 방지는 서버에서 원자적으로 처리한다.** `reservations`의 부분 UNIQUE 인덱스(활성 예약 기준)와 조건부 `INSERT ... SELECT ... WHERE` / `UPDATE ... WHERE status = ?`를 사용한다. "조회 후 삽입" 패턴(check-then-insert)으로 바꾸지 않는다.
3. **인증과 관리자 권한을 분리한다.** 학생(`students`)과 관리자(`admins`)는 다른 테이블, 다른 로그인 엔드포인트를 사용하며, 세션의 `subject_type`으로 엄격히 구분한다.
4. **비밀 값을 코드에 쓰지 않는다.** 토큰·비밀번호·Cloudflare 키는 `.env`, `.dev.vars`, `wrangler secret`으로만 관리한다. `.env.example`에는 빈 값/설명만 둔다.
5. **실제 학생 개인정보를 만들거나 넣지 않는다.** 테스트 데이터는 명백한 가짜 값(예: `TEST-0001`)만 사용하며 시드 SQL에 학생 데이터를 넣지 않는다.
6. **학번과 이름만으로 본인 확인이 된다고 가정하지 않는다.** 로그인은 반드시 비밀 정보(비밀번호 또는 향후 SSO)를 요구한다.
7. **서보모터를 자동으로 구동하는 코드를 작성하지 않는다.** 현재 펌웨어는 `SERVO` 명령을 거부(`ERR,SERVO_DISABLED`)하며, 에이전트 설정 `SERVO_ENABLED=true`는 오류로 처리된다. 서보 기능은 별도 단계에서 안전 검토 후 추가한다.
8. **Arduino 연결이 끊겨도 좌석 상태를 바꾸지 않는다.** 시리얼 단절은 로그와 장치 이벤트로만 기록한다.
9. **네트워크가 끊기면 신규 예약을 승인하지 않는다.** 오프라인 상태의 버튼 입력은 거부하고 Arduino에 `STATUS,OFFLINE`을 알린다. 오프라인 큐로 나중에 상태를 변경하지 않는다.
10. **중요 이벤트는 모두 로그로 남긴다.** 서버는 `events` 테이블, 에이전트는 JSON 로그 파일(`logger.log_event`). 로그에 비밀번호·토큰을 기록하지 않는다.
11. **라즈베리파이는 외부 발신 연결만 사용한다.** 포트포워딩이나 인바운드 서버를 열지 않는다.
12. **실제 Cloudflare 배포, 원격 리소스 생성, 하드웨어 구동은 사용자가 명시적으로 요청했을 때만** 수행한다.
13. **`main` 브랜치 push = 운영 배포다.** `cloudflare/**`(API) 또는 `web/kiosk/**`(키오스크, `deploy-kiosk.yml`) 변경이 `main`에 push되면 GitHub Actions(`.github/workflows/deploy-worker.yml`)가 원격 D1 마이그레이션 적용과 Worker 배포를 자동 수행한다. 따라서 push는 사용자가 요청했을 때만 하고, push 전에 로컬 검사(`npm run check`, 테스트)를 통과시킨다. 이미 적용된 마이그레이션 파일은 절대 수정하지 않는다.
14. **wrangler 명령은 반드시 해당 설정 파일이 있는 폴더에서 실행한다.** API는 `cloudflare/`, 키오스크는 `web/kiosk/`. 다른 폴더에서 실행하면 그 폴더의 `wrangler.toml`이 읽혀 엉뚱한 Worker가 배포된다. 실제 배포 전에 `--dry-run`으로 바인딩을 확인한다.

## 코딩 규칙

- Python: 3.13 호환, 타입 힌트 사용, 표준 `unittest`로 테스트 (하드웨어 없이 실행 가능해야 함). 외부 패키지는 함수 내부에서 지연 import 하여 테스트가 의존성 없이 돌도록 유지.
- JavaScript: ES Modules, 빌드 도구 의존 최소화. DOM에 사용자 데이터를 넣을 때 `innerHTML` 대신 `textContent` 사용.
- SQL: 모든 쿼리는 `prepare().bind()` 파라미터 바인딩. 문자열 연결로 SQL을 만들지 않는다.
- 시간: 모두 UTC ISO 8601 (`2026-01-01T00:00:00.000Z`) 문자열로 저장/비교.
- 에러 응답 형식: `{ "error": { "code": "...", "message": "..." } }`.
- 스키마 변경 시 `cloudflare/database/migrations/`에 새 번호의 마이그레이션을 추가하고 `schema.sql`과 `docs/DATABASE.md`도 갱신한다. 기존 마이그레이션은 수정하지 않는다.
- API 변경 시 `docs/API_SPEC.md`를 함께 갱신한다. 시리얼 명령 변경 시 `SERIAL_PROTOCOL.md`, 펌웨어, `serial_manager.py`를 함께 갱신한다.

## 자주 쓰는 명령

```powershell
# 프론트엔드
cd web\kiosk; npm install; npm run dev; npm run build

# Workers (로컬)
cd cloudflare; npm install; npm run migrate:local; npm run dev
# Workers 빌드 검사 (배포 없음, wrangler.toml 필요)
cd cloudflare; npm run check

# 에이전트 테스트
cd raspberry-pi; python -m unittest discover -s tests -t . -v

# 환경 점검
powershell -ExecutionPolicy Bypass -File scripts\check_environment.ps1
```

## 현장 환경 정보

- 서버: Raspberry Pi 3 B+ Rev 1.3, Raspberry Pi OS Lite 32-bit (Debian 13), Python 3.13
- hostname `library-server`, 사용자 `pi`
- Arduino UNO R3 → USB 시리얼 (`/dev/ttyACM0` 예상)
- 서보모터: 아직 미연결
