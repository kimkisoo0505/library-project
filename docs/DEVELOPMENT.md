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
| 1 | 로컬 D1 + `wrangler dev`로 API 동작 확인, 테스트 계정 발급 도구 | 완료 (`cloudflare/scripts/accounts.mjs`) |
| 2 | 키오스크 ↔ 로컬 API 연동, 동시 예약 부하 테스트 | 예정 |
| 3 | Arduino 펌웨어 업로드, 시리얼 모니터로 프로토콜 검증 | 예정 |
| 4 | Pi에 에이전트 설치, 로컬 API(개발 PC)와 연동 시험 | 예정 |
| 5 | 버튼 방식 확정 및 버튼 → 동작 매핑 구현 | 예정 |
| 6 | Cloudflare 배포 (D1 원격, Workers, Pages), 장치 토큰 등록 | Workers 자동 배포 구성 완료 (GitHub Actions, Secrets 등록 필요), Pages 예정 |
| 7 | 서보모터 안전 설계 검토 후 구현 | 예정 |
| 8 | 운영 정책 (운영 시간, 이용 시간 제한, 로그 보존) | 예정 |
| 9 | 현장형 키오스크: 라즈베리파이 카메라(Pi Camera) · 숫자 키패드로 입구에서 입장 확인 → 착석 처리 (원격 착석 방지) | 예정 |
| 10 | 지문 센서 본인 확인 | **보류** (생체정보 수집 필요성·보관 방식 검토 후 결정) |
| 11 | 재실 확인: Bluetooth + 모바일 앱 또는 웹 → 좌석 **자동 연장** / 일정 시간 미확인 시 **자동 퇴실** (사전 알림) | 예정 |

### 추후 계획 설계 메모 (구현 전 결정 필요)
- **입장 확인 → 착석**: 현재 웹 `check-in` 은 학생 본인 요청만으로 처리된다. 현장 키오스크 도입 시 장치 토큰으로 인증된 키오스크의 확인이 있어야 착석되도록 서버 규칙을 바꾼다 (장치 이벤트 → 서버가 원자적으로 상태 전이).
- **자동 연장 / 자동 퇴실**: 이용 종료 시각 컬럼과 "마지막 재실 확인 시각"이 필요하다 → 새 마이그레이션. Cron(현재 1분)으로 미확인 좌석을 정리하되, 퇴실 전 알림 유예 시간을 둔다.
- **Bluetooth 재실 확인**: 열람실 장치(라즈베리파이/아두이노)가 근처 기기를 감지하는 방식과, 휴대폰이 열람실 비콘을 감지해 앱/웹으로 보고하는 방식 중 선택. 위치는 "열람실 안 / 밖"만 다루고 이동 기록은 저장하지 않는다. 웹만으로는 백그라운드 Bluetooth 감지가 제한될 수 있어 앱 필요 여부를 함께 검토한다.
- **카메라 / 지문**: 영상·생체정보는 저장하지 않거나 최소화하는 방향으로 설계하고, 지문은 보류.

## 2. 구성요소별 테스트

### 2.1 라즈베리파이 에이전트 (하드웨어 불필요)
```powershell
cd raspberry-pi
python -m unittest discover -s tests -t . -v
```
테스트 범위: 설정 검증, 좌석 캐시 안전 동작, 시리얼 프로토콜 파싱/명령 생성, 시리얼 재연결, 오프라인 시 버튼 거부.

### 2.2 Workers 단위 테스트 / 계정 도구
```powershell
cd cloudflare
npm test                                             # 비밀번호 해시, 계정 도구 검증
node scripts/accounts.mjs create-student TEST-0001 테스트학생1   # 로컬 D1
```

### 2.3 Workers (로컬)
```powershell
cd cloudflare
copy wrangler.toml.example wrangler.toml
npx wrangler d1 migrations apply library-seat-db --local
npx wrangler dev
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/seats
```
동시 예약 검증(단계 2): 같은 좌석에 여러 학생 토큰으로 동시에 POST → 201 하나, 나머지 409인지 확인.

### 2.4 웹 키오스크
```powershell
cd web\kiosk
npm install
npm run dev     # wrangler dev 와 함께 실행
npm run build
```

### 2.5 Arduino
시리얼 모니터(115200, Newline)에서:
```
PING,1          → PONG,1
STATUS,ONLINE   → ACK,STATUS,ONLINE
SERVO,1,90      → ERR,SERVO_DISABLED
HELLO           → ERR,UNKNOWN_CMD
```

### 2.6 라즈베리파이 현장 점검
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

- 관리자 화면에서의 학생 계정 발급 (현재는 CLI만 지원)
- 로그인 시도 횟수 제한
- 현장 확인 기반 착석 (현재는 학생 본인 요청으로 착석 처리)
- 버튼 → 동작 매핑 (현재 장치 이벤트는 기록만)
- PONG 누락 감지 후 시리얼 재연결
- 서보모터 / LED 제어
- 운영 시간, 이용 시간 제한, 자동 퇴실
- Workers 통합 테스트 (Vitest + `@cloudflare/vitest-pool-workers` 도입 예정)
- 로그 보존 / 정리 정책
