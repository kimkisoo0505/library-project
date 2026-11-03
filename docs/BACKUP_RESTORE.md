# 백업 · 롤백 · 재구축 가이드

> 기준 시점: **2026-11-04 (KST) / 2026-11-03T16:54:51Z (UTC)**, Git 태그 **`backup-2026-11-04`**
> 이 문서에는 비밀 값이 없습니다. 비밀 값은 **로컬 백업 폴더의 `SECRETS.txt`** 에만 있습니다.

## 0. 이 시점의 상태 요약

| 구성요소 | 상태 |
|---|---|
| 키오스크 | https://library-kiosk.kimkisoo0505.workers.dev (관리자 `/#/admin`) — 열람실 A/B/C 탭, 테스트 계정 안내, 중앙·금화도서관 패널, 임시 상태 표시줄 |
| API | https://library-seat-api.kimkisoo0505.workers.dev/api/health |
| DB (D1) | `library-seat-db`, 마이그레이션 0001~0004 적용, 3실 × 30석 = 90석 |
| 라즈베리파이 | `library-server`, 열람실 A 담당, Grove LCD RGB Backlight, 중앙·금화도서관 중계, 핫스팟 자동 연결 |
| 아두이노 B/C | 미구현 (코드 없음) |

## 1. 백업 구성물

### 1-1. GitHub (비밀 값 없음)
- 저장소: https://github.com/kimkisoo0505/library-project
- 롤백 지점: 태그 **`backup-2026-11-04`**

### 1-2. 로컬 백업 폴더 `C:\Users\kisoo\VsCode\library-project-backups\2026-11-04\`

| 파일 | 내용 |
|---|---|
| `workspace-2026-11-04.zip` | 작업 폴더 전체 사본 (`.git` 이력, git 제외 파일 `cloudflare/wrangler.toml`, 로컬 D1 `.wrangler/` 포함. `node_modules`·`dist`·캐시 제외 → `npm install` 로 복원) |
| `d1-production-2026-11-04.sql` | 운영 D1 전체 내보내기 (스키마 + 데이터) |
| `cloudflare-snapshot/` | Worker 배포 버전 목록, secret 이름, D1 정보, 마이그레이션 상태, 로컬 `wrangler.toml` 사본, 백업 UTC 시각 |
| `pi-snapshot/raspberry-pi.env` | 라즈베리파이 `.env` (**장치 토큰 포함**) |
| `pi-snapshot/library-agent.service` | systemd 서비스 파일 |
| `pi-snapshot/wifi-profiles.txt` | Wi-Fi 프로필 2개와 우선순위 (**비밀번호 포함**) |
| `pi-snapshot/system-info.txt`, `pip-freeze.txt` | OS·I2C·그룹·패키지 버전 |
| `SECRETS.txt` | Cloudflare API 토큰, 라즈베리파이 비밀번호, 핫스팟 비밀번호, 테스트 계정 |
| `SHA256SUMS.txt` | 위 파일들의 무결성 확인용 해시 |
| `BACKUP_RESTORE.md` | 이 문서 사본 |

> 백업 폴더는 USB나 개인 클라우드 드라이브에도 한 부 복사해 두는 것을 권장합니다. (`SECRETS.txt` 가 있으므로 공유 금지)

## 2. 이 시점의 설정값 (비밀 아님)

### Cloudflare
| 항목 | 값 |
|---|---|
| 계정 ID | `8d6e7f3948c38c9288349f16a597f853` |
| workers.dev 서브도메인 | `kimkisoo0505` |
| API Worker | `library-seat-api` (배포 버전 `a74c7b68-8728-4104-bb30-b90752669b55`) |
| 키오스크 Worker | `library-kiosk` — 정적 파일 전용, 바인딩 없음 (배포 버전 `10760658-8a5d-4671-a9b5-dea798c6ac57`) |
| D1 | `library-seat-db` / ID `9482b6cd-61dc-4109-a7f8-56148e8253df` |
| Durable Object | `SeatRoom` (바인딩 `SEAT_ROOM`, 마이그레이션 태그 `v1`, SQLite 클래스) |
| Cron | `* * * * *` (만료 예약 정리) |
| 변수 [vars] | `ALLOWED_ORIGINS="https://library-kiosk.kimkisoo0505.workers.dev,http://localhost:5173"`, `RESERVATION_HOLD_MINUTES="15"`, `SESSION_TTL_HOURS="12"`, `CENTRAL_LIBRARY_MODE="relay"` |
| 비밀 [secret] | `DEVICE_TOKEN` (값 = 라즈베리파이 `.env` 의 `LIBRARY_DEVICE_TOKEN`) |

### GitHub Actions
| 항목 | 값 |
|---|---|
| Repository secret | `CLOUDFLARE_API_TOKEN` (값: `SECRETS.txt`) — 계정 ID·D1 ID 는 워크플로에 기본값으로 들어 있음 |
| 워크플로 | `deploy-worker.yml` (`cloudflare/**` 변경 시), `deploy-kiosk.yml` (`web/kiosk/**` 변경 시) |

### 라즈베리파이
| 항목 | 값 |
|---|---|
| 기기 | Raspberry Pi 3 B+ Rev 1.3, Raspbian 13 (trixie) armv7l, Python 3.13.5 |
| 접속 | `ssh pi@<IP>` (집: `192.168.45.248`), hostname `library-server` |
| 코드 위치 | `/home/pi/library-project` (git clone), 가상환경 `raspberry-pi/.venv` |
| 서비스 | `library-agent.service` (사용자 `pi`, 부팅 시 자동 시작) |
| I2C | `/boot/firmware/config.txt` 에 `dtparam=i2c_arm=on`, 버스 1: `0x3E` LCD 텍스트, `0x62` RGB 백라이트 (초기화 후 `0x70` 은 응답하지 않는 것이 정상) |
| Wi-Fi | 우선순위 10 `SK_WiFiGIGAC88A_5G` (집), 5 `AndroidHotspot4912` (핸드폰, `phone-hotspot`), 둘 다 무한 재시도 |
| 추가 설치 apt | `git`, `i2c-tools` |

## 3. 상황별 롤백

### 3-1. 방금 배포한 API/키오스크가 이상할 때 (가장 빠름, 코드 변경 없음)
```powershell
cd C:\Users\kisoo\VsCode\library-project\cloudflare
$env:CLOUDFLARE_API_TOKEN="<SECRETS.txt>"; $env:CLOUDFLARE_ACCOUNT_ID="8d6e7f3948c38c9288349f16a597f853"
npx wrangler deployments list --name library-seat-api          # 버전 목록 확인
npx wrangler rollback a74c7b68-8728-4104-bb30-b90752669b55 --name library-seat-api
cd ..\web\kiosk
npx wrangler rollback 10760658-8a5d-4671-a9b5-dea798c6ac57 --name library-kiosk
```
> 롤백은 코드만 되돌립니다. DB 스키마를 바꾼 배포였다면 3-3 도 확인하세요.
> 이후 `main` 에 push 하면 다시 최신 코드가 배포되므로, 원인을 고친 뒤 push 하거나 3-2 로 코드를 되돌리세요.

### 3-2. 코드를 이 시점으로 되돌리기 (GitHub 자동 배포 이용)
```powershell
cd C:\Users\kisoo\VsCode\library-project
git fetch --tags
git checkout -b restore-2026-11-04 backup-2026-11-04    # 이 시점 코드 확인용 브랜치
# 확인 후 main 을 이 시점 내용으로 되돌리는 커밋 생성 (이력은 보존)
git checkout main
git checkout backup-2026-11-04 -- .
git commit -m "Restore to backup-2026-11-04"
git push origin main                                     # → GitHub Actions 가 API·키오스크 배포
```
> 이후 추가된 DB 마이그레이션 파일이 있었다면 `git checkout ... -- .` 로는 삭제되지 않습니다. 그 파일은 직접 지우지 말고 3-3 을 참고하세요 (이미 적용된 마이그레이션은 되돌리는 새 마이그레이션으로 처리).

### 3-3. DB(D1) 되돌리기
**방법 A — Time Travel (권장, 무료 플랜 7일 이내):**
```powershell
cd C:\Users\kisoo\VsCode\library-project\cloudflare
npx wrangler d1 time-travel info library-seat-db --timestamp=2026-11-03T16:54:51Z
npx wrangler d1 time-travel restore library-seat-db --timestamp=2026-11-03T16:54:51Z
```
**방법 B — 백업 SQL 로 새 DB 만들기 (기간 제한 없음):**
```powershell
npx wrangler d1 create library-seat-db-restore
npx wrangler d1 execute library-seat-db-restore --remote --file "C:\Users\kisoo\VsCode\library-project-backups\2026-11-04\d1-production-2026-11-04.sql"
```
그 다음 새 DB ID 로 ① `cloudflare/wrangler.toml` 의 `database_id`, ② `.github/workflows/deploy-worker.yml` 의 `D1_DATABASE_ID` 기본값을 바꾸고 push (또는 GitHub Secret `D1_DATABASE_ID` 등록).
> 백업 SQL 에는 `d1_migrations` 기록이 포함되어 있어 마이그레이션이 다시 적용되지 않습니다.

### 3-4. 라즈베리파이 코드를 이 시점으로 되돌리기
```bash
ssh pi@<라즈베리파이 IP>
cd ~/library-project && git fetch --tags && git checkout backup-2026-11-04
cd raspberry-pi && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -t .      # Ran 69 tests ... OK
sudo systemctl restart library-agent && journalctl -u library-agent -n 30 -o cat
# 다시 최신으로: git checkout main && git pull
```

## 4. 처음부터 다시 만들기 (이 시점 그대로)

### 4-1. 개발 PC (Windows 11)
- 필요: Node.js 20+, Python 3.12+, Git (`scripts\check_environment.ps1` 로 점검)
- **방법 A (작업 폴더 그대로):** `workspace-2026-11-04.zip` 을 `C:\Users\kisoo\VsCode\library-project` 로 압축 해제 →
  ```powershell
  cd C:\Users\kisoo\VsCode\library-project\cloudflare; npm install
  cd ..\web\kiosk; npm install
  ```
- **방법 B (GitHub에서):** `git clone https://github.com/kimkisoo0505/library-project.git` → `git checkout backup-2026-11-04` → 위 `npm install` 2회 → `cloudflare\wrangler.toml` 은 백업의 `cloudflare-snapshot\wrangler.toml (local, gitignored)` 를 복사
- 검증: `cd cloudflare; npm test; python tests\check_schema.py` / `cd raspberry-pi; python -m unittest discover -s tests -t .`

### 4-2. Cloudflare (계정을 새로 만드는 경우)
1. Cloudflare 가입 → 대시보드 **Workers & Pages** 를 한 번 열어 workers.dev 서브도메인 생성
2. **API 토큰**: My Profile → API Tokens → "Edit Cloudflare Workers" 템플릿 + 권한 `Account · D1 · Edit` 추가
3. **D1 생성**: `npx wrangler d1 create library-seat-db` → 새 ID 를 `cloudflare/wrangler.toml` 과 `deploy-worker.yml` 기본값에 반영 (계정 ID 도 바뀌면 두 워크플로의 기본값 수정)
4. **스키마**: `npx wrangler d1 migrations apply library-seat-db --remote` (또는 3-3 방법 B 로 데이터까지 복원)
5. **API 배포** (반드시 `cloudflare\` 폴더에서): `npx wrangler deploy --dry-run` 으로 바인딩 확인 후 `npx wrangler deploy`
6. **장치 토큰**: 라즈베리파이 `.env` 의 `LIBRARY_DEVICE_TOKEN` 값을 `npx wrangler secret put DEVICE_TOKEN --name library-seat-api` 로 등록
7. **키오스크 배포** (반드시 `web\kiosk\` 폴더에서): `npm run deploy`
8. 서브도메인이 `kimkisoo0505` 가 아니면 주소가 바뀌므로 `web/kiosk/.env.production`, `public/_headers`(CSP), `cloudflare/wrangler.toml.example`(ALLOWED_ORIGINS), `raspberry-pi/.env`(LIBRARY_API_BASE_URL), `deploy-kiosk.yml`(번들 확인 주소)를 새 주소로 수정
9. **GitHub**: Settings → Secrets and variables → Actions → `CLOUDFLARE_API_TOKEN` 등록
10. **계정**: DB 를 백업 SQL 로 복원했다면 계정도 복원됨. 새로 만들었다면
    ```powershell
    cd cloudflare
    "JEzveJCCMPJx" | node scripts/accounts.mjs create-student TEST-0001 테스트학생1 --remote --yes --password-stdin
    "KzkydLNyWPmV" | node scripts/accounts.mjs create-student TEST-0002 테스트학생2 --remote --yes --password-stdin
    "R6rhtTA72rp4" | node scripts/accounts.mjs create-student TEST-0003 테스트학생3 --remote --yes --password-stdin
    node scripts/accounts.mjs create-admin testadmin --remote --yes      # 비밀번호 새로 발급됨
    ```
    (키오스크 테스트 계정 안내 `web/kiosk/src/test-accounts.js` 와 비밀번호를 맞춰야 함)

### 4-3. 라즈베리파이 (SD 카드를 새로 굽는 경우) — 지금까지 SSH 로 실행한 작업 전부
Raspberry Pi Imager 로 **Raspberry Pi OS Lite 32-bit** 설치 (hostname `library-server`, 사용자 `pi`, SSH 켜기, 집 Wi-Fi 입력) 후:
```bash
# (1) 패키지
sudo apt update && sudo apt install -y git python3-venv i2c-tools

# (2) I2C 활성화 (LCD)
sudo raspi-config nonint do_i2c 0           # config.txt 에 dtparam=i2c_arm=on 기록
/usr/sbin/i2cdetect -y 1                     # 3e, 62 보이면 정상

# (3) 코드 / 가상환경 / 테스트
git clone https://github.com/kimkisoo0505/library-project.git ~/library-project
cd ~/library-project && git checkout backup-2026-11-04     # 최신을 원하면 생략
cd raspberry-pi
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -t .       # 69개 OK
mkdir -p logs

# (4) 설정 파일 — 백업 pi-snapshot/raspberry-pi.env 를 그대로 복사 (PC에서)
#   scp "...\pi-snapshot\raspberry-pi.env" pi@<IP>:/home/pi/library-project/raspberry-pi/.env
chmod 600 .env
#   백업이 없으면: cp .env.example .env 후 아래 값 설정, 토큰은 새로 생성해 Cloudflare 에도 등록(4-2의 6)
#   python3 -c "import secrets; print(secrets.token_urlsafe(32))"
#   LIBRARY_API_BASE_URL=https://library-seat-api.kimkisoo0505.workers.dev
#   LIBRARY_DEVICE_TOKEN=<토큰>   DEVICE_ROOM=A
#   LCD_ENABLED=true  LCD_TYPE=grove-rgb  LCD_I2C_BUS=1  LCD_I2C_ADDRESS=0x3E  LCD_RGB_ADDRESS=0x62
#   LCD_COLOR_NORMAL=0,255,0  LCD_COLOR_OFFLINE=255,0,0
#   CENTRAL_LIBRARY_RELAY=true  CENTRAL_LIBRARY_INTERVAL_SECONDS=60  SERVO_ENABLED=false

# (5) 권한 (Raspberry Pi OS 기본 사용자는 이미 dialout, i2c 그룹)
id -nG | grep -wq dialout || sudo usermod -aG dialout pi
id -nG | grep -wq i2c     || sudo usermod -aG i2c pi

# (6) 자동 실행 서비스
sudo install -m 644 systemd/library-agent.service.example /etc/systemd/system/library-agent.service
sudo systemctl daemon-reload && sudo systemctl enable --now library-agent

# (6-1) 관리자 화면 원격 종료 허용 (선택): polkit 규칙 + .env 의 ALLOW_REMOTE_SHUTDOWN=true
sudo install -m 644 system/50-library-agent-poweroff.rules /etc/polkit-1/rules.d/
sudo systemctl restart library-agent

# (7) Wi-Fi: 집 우선, 없으면 핸드폰 핫스팟 (비밀번호는 SECRETS.txt)
HOME_CON=$(nmcli -t -f NAME,TYPE connection show | grep 802-11-wireless | head -1 | cut -d: -f1)
sudo nmcli connection modify "$HOME_CON" connection.autoconnect yes connection.autoconnect-priority 10 connection.autoconnect-retries 0
sudo nmcli connection add type wifi ifname wlan0 con-name phone-hotspot ssid AndroidHotspot4912 \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "<핫스팟 비밀번호>" \
  connection.autoconnect yes connection.autoconnect-priority 5 connection.autoconnect-retries 0
```
> 핸드폰 핫스팟 보안은 **WPA2-Personal** (또는 WPA2/WPA3 혼합). 라즈베리파이 3 B+ 의 WPA3 전용 지원은 확인되지 않음.

### 4-4. 아두이노
이 시점에는 열람실 B/C 아두이노 코드가 없습니다. `arduino/firmware/library_controller/` 는 초기 통신 골격(서보 비활성)만 있습니다.

## 5. 복구 후 확인 체크리스트
- [ ] `https://library-seat-api.kimkisoo0505.workers.dev/api/health` → `{"ok":true}`
- [ ] `/api/seats` → `rooms` A/B/C 각 30석
- [ ] 키오스크 하단 상태 표시줄: 라즈베리파이(A) **연결됨**, Wi-Fi 이름 표시, 경기대 도서관 서버 **정상 수신**
- [ ] 중앙·금화도서관 패널에 공석 숫자 표시
- [ ] 테스트 계정 로그인 → 열람실 A 좌석 예약 → 착석 → LCD 1줄 `Welcome` 2초 후 끝 글자부터 지워짐
- [ ] LCD 2줄 `Use N Free M`, 녹색 배경 (네트워크 끊기면 빨간 배경 `Offline`)
- [ ] 라즈베리파이 `journalctl -u library-agent` 에 `cloud.ws_connected`, `lcd.connected`, `library_status.ok`
- [ ] GitHub Actions 의 Deploy Worker / Deploy Kiosk 최근 실행 성공

## 6. 알아둘 위험 요소
- **학교 서버 인증서 만료 2026-11-25**: 갱신 시 발급 기관이 바뀌면 중계가 실패할 수 있음 → `raspberry-pi/agent/certs/` 의 중간 인증서 교체 필요 (현재 RapidSSL TLS RSA CA G1, ~2027-11-02)
- **D1 Time Travel 보존 기간**: 무료 플랜 7일 → 그 이후에는 백업 SQL(3-3 방법 B) 사용
- 테스트 계정 안내 / 임시 상태 표시줄은 시연용 — 운영 전 `VITE_SHOW_TEST_ACCOUNTS=false`, `VITE_SHOW_SYSTEM_STATUS=false`, 테스트 계정 비밀번호 재설정
