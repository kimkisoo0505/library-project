# 개발 및 테스트 절차

## 0. 개발 환경 준비 (Windows 11)

| 도구 | 용도 | 확인 |
|---|---|---|
| Node.js 20+ / npm | 프론트엔드, wrangler | `node -v` |
| Python 3.12+ (서버는 3.13) | 에이전트 테스트 | `python --version` |
| Git | 버전 관리 | `git --version` |
| Arduino IDE 또는 arduino-cli | 펌웨어 | `arduino-cli version` |
| OpenSSH 클라이언트 | Pi 접속 | `ssh -V` |

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check_environment.ps1
```

## 1. 단계별 개발 계획

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | 프로젝트 구조, 문서, 기본 골격 | **완료 (현재)** |
| 1 | 로컬 D1 + `wrangler dev`로 API 동작 확인, 테스트 계정 발급 도구 | 예정 |
| 2 | 키오스크 ↔ 로컬 API 연동, 동시 예약 부하 테스트 | 예정 |
| 3 | Arduino 펌웨어 업로드, 시리얼 모니터로 프로토콜 검증 | 예정 |
| 4 | Pi에 에이전트 설치, 로컬 API(개발 PC)와 연동 시험 | 예정 |
| 5 | 버튼 방식 확정 및 버튼 → 동작 매핑 구현 | 예정 |
| 6 | Cloudflare 배포 (D1 원격, Workers, Pages), 장치 토큰 등록 | Workers 자동 배포 구성 완료 (GitHub Actions, Secrets 등록 필요), Pages 예정 |
| 7 | 서보모터 안전 설계 검토 후 구현 | 예정 |
| 8 | 운영 정책 (운영 시간, 이용 시간 제한, 로그 보존) | 예정 |

## 2. 구성요소별 테스트

### 2.1 라즈베리파이 에이전트 (하드웨어 불필요)
```powershell
cd raspberry-pi
python -m unittest discover -s tests -t . -v
```
테스트 범위: 설정 검증, 좌석 캐시 안전 동작, 시리얼 프로토콜 파싱/명령 생성, 시리얼 재연결, 오프라인 시 버튼 거부.

### 2.2 Workers (로컬)
```powershell
cd cloudflare
copy wrangler.toml.example wrangler.toml
npx wrangler d1 migrations apply library-seat-db --local
npx wrangler dev
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/seats
```
동시 예약 검증(단계 2): 같은 좌석에 여러 학생 토큰으로 동시에 POST → 201 하나, 나머지 409인지 확인.

### 2.3 웹 키오스크
```powershell
cd web\kiosk
npm install
npm run dev     # wrangler dev 와 함께 실행
npm run build
```

### 2.4 Arduino
시리얼 모니터(115200, Newline)에서:
```
PING,1          → PONG,1
STATUS,ONLINE   → ACK,STATUS,ONLINE
SERVO,1,90      → ERR,SERVO_DISABLED
HELLO           → ERR,UNKNOWN_CMD
```

### 2.5 라즈베리파이 현장 점검
```bash
bash scripts/check_raspberry_pi.sh
```

## 3. 기본 문법 검사

```powershell
# Python
python -m compileall -q raspberry-pi
# JavaScript (Node 22+ 는 ESM 자동 인식)
Get-ChildItem cloudflare\workers, web\kiosk\src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
# SQL (로컬 SQLite로 스키마 적용 시험)
python -c "import sqlite3;c=sqlite3.connect(':memory:');c.executescript(open('cloudflare/database/schema.sql',encoding='utf-8').read());print(c.execute('select count(*) from seats').fetchone())"
```

## 4. 테스트 데이터 규칙

- 학생: `TEST-0001` 같은 명백한 가짜 학번, 이름은 `테스트학생1` 등
- 실제 학생 정보, 실제 비밀번호를 사용하지 않습니다.
- 테스트 데이터는 로컬 D1(`--local`)에만 넣습니다.

## 5. 아직 구현되지 않은 기능

- 학생/관리자 계정 발급 도구 (비밀번호 해시 생성 CLI)
- 로그인 시도 횟수 제한
- 현장 확인 기반 착석 (현재는 학생 본인 요청으로 착석 처리)
- 버튼 → 동작 매핑 (현재 장치 이벤트는 기록만)
- PONG 누락 감지 후 시리얼 재연결
- 서보모터 / LED 제어
- 운영 시간, 이용 시간 제한, 자동 퇴실
- Workers 통합 테스트 (Vitest + `@cloudflare/vitest-pool-workers` 도입 예정)
- 로그 보존 / 정리 정책
