# 도서관 좌석 관리 시스템

30석 규모 도서관 열람실의 좌석 예약·착석·퇴실을 관리하는 시스템입니다.
웹 키오스크, Cloudflare 기반 클라우드 백엔드, 현장 라즈베리파이 에이전트, Arduino 컨트롤러로 구성됩니다.

> 현재 단계: **초기 프로젝트 구조(스캐폴딩)**. 각 구성요소의 기본 골격만 구현되어 있으며
> 실제 배포·하드웨어 구동은 하지 않습니다. 구현 현황은 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)를 참고하세요.

## 구성

| 구성요소 | 위치 | 기술 |
|---|---|---|
| 웹 키오스크 / 관리자 화면 | [web/kiosk](web/kiosk) | Vite, Vanilla JS → Cloudflare Pages |
| API 서버 | [cloudflare/workers](cloudflare/workers) | Cloudflare Workers |
| 데이터베이스 | [cloudflare/database](cloudflare/database) | Cloudflare D1 (SQLite) |
| 실시간 동기화 | [cloudflare/workers/durable-objects](cloudflare/workers/durable-objects) | Durable Objects + WebSocket |
| 현장 에이전트 | [raspberry-pi](raspberry-pi) | Python 3.13, Raspberry Pi 3 B+ |
| 하드웨어 컨트롤러 | [arduino](arduino) | Arduino UNO R3 (버튼, 서보모터 예정) |

**좌석 상태의 최종 기준은 클라우드 D1 데이터베이스**입니다. 라즈베리파이와 키오스크는 상태를 캐시로만 보유하며,
예약 승인은 오직 서버가 원자적으로 처리합니다.

## 빠른 시작 (개발 PC, Windows 11)

### 0. 환경 점검
```powershell
powershell -ExecutionPolicy Bypass -File scripts\check_environment.ps1
```

### 1. 웹 키오스크
```powershell
cd web\kiosk
npm install
npm run dev        # http://localhost:5173
```

### 2. Cloudflare Workers (로컬 실행)
```powershell
cd cloudflare
copy wrangler.toml.example wrangler.toml   # database_id 등 실제 값으로 수정 (커밋 금지)
npx wrangler d1 migrations apply library-seat-db --local
npx wrangler dev                            # http://127.0.0.1:8787
```
자세한 내용: [cloudflare/README.md](cloudflare/README.md)

### 3. 라즈베리파이 에이전트 (PC에서 테스트만)
```powershell
cd raspberry-pi
python -m unittest discover -s tests -t . -v
```
실제 설치 방법: [raspberry-pi/README.md](raspberry-pi/README.md)

### 4. Arduino
Arduino IDE 또는 `arduino-cli`로 [library_controller.ino](arduino/firmware/library_controller/library_controller.ino)를 업로드합니다.
통신 규격: [SERIAL_PROTOCOL.md](arduino/protocol/SERIAL_PROTOCOL.md)

## 문서

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — 시스템 구성 및 통신 흐름
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) — 단계별 개발/테스트 절차
- [API_SPEC.md](docs/API_SPEC.md) — REST/WebSocket API 명세
- [DATABASE.md](docs/DATABASE.md) — D1 스키마 설명
- [HARDWARE.md](docs/HARDWARE.md) — 라즈베리파이·Arduino 연결 설계
- [CLAUDE.md](CLAUDE.md) — 개발 규칙 (AI 도우미 및 개발자 공통)

## 보안 원칙 요약

- 비밀번호·토큰·Cloudflare 키는 코드/저장소에 기록하지 않습니다 (`.env`, `wrangler secret` 사용).
- 학생 인증과 관리자 권한은 별도 테이블·별도 로그인으로 분리합니다.
- 실제 학생 개인정보를 테스트 데이터로 사용하지 않습니다.
- 라즈베리파이는 클라우드로 **외부 발신 연결만** 사용합니다 (포트포워딩 없음).
