# raspberry-pi — 현장 하드웨어 에이전트

Raspberry Pi 3 B+ (`library-server`)에서 동작하며 Arduino와 클라우드를 연결합니다.

```
Arduino ──USB 시리얼──▶ agent ──HTTPS/WSS (외부 발신)──▶ Cloudflare Workers
```

## 모듈

| 파일 | 역할 |
|---|---|
| `agent/main.py` | 진입점. 작업(시리얼, 클라우드 WS, 하트비트, 주기 동기화) 실행 및 종료 처리 |
| `agent/config.py` | 환경 변수 로드·검증 (https 강제, 토큰 필수, `SERVO_ENABLED=true` 거부) |
| `agent/logger.py` | JSON 줄 로그 (stdout + `logs/agent.log` 회전), 비밀 값 마스킹 |
| `agent/serial_manager.py` | 시리얼 연결/재연결, 프로토콜 파싱·명령 생성 (SERVO 전송 금지) |
| `agent/cloud_client.py` | REST(좌석 조회, 장치 이벤트) 및 WebSocket 구독 |
| `agent/seat_manager.py` | 클라우드 좌석 상태 캐시. 단절 시 상태 유지 + 요청 차단 |
| `agent/event_handler.py` | 버튼 입력 → 클라우드 전달, 오프라인 시 거부, 상태 알림, 착석 알림 → Welcome |
| `agent/room_display.py` | 열람실 LCD 화면 내용 계산 (Welcome 2초 + 지우기 애니메이션, 사용중/공석) |
| `agent/lcd_display.py` | I2C 16x2 LCD 드라이버: Grove LCD RGB Backlight(기본) / PCF8574 백팩, 바뀐 글자만 다시 씀 |
| `agent/library_status.py` | 경기대 중앙/금화도서관 공석 중계 (중간 인증서 포함, 검증 유지) |
| `agent/remote_command.py` | 관리자 원격 명령(전원 끄기) 검증·실행 — `ALLOW_REMOTE_SHUTDOWN`, polkit 규칙 `system/50-library-agent-poweroff.rules` 필요 |
| `agent/ble_protocol.py` | BLE 명령 처리 (PING/ECHO/INFO, 형식 검증, 속도 제한). 순수 함수, 부작용 없음 |
| `agent/ble_server.py` | BLE GATT 서버 (bless/BlueZ). 모바일 앱 통신 시험용, **별도 서비스** `library-ble` |
| `agent/arduino_rooms.py` | **아두이노 담당 열람실 LCD (B/C)** — `ARDUINO_ROOMS` 로 켬. 아두이노를 없앨 때 이 파일만 삭제 (방법: `arduino/README.md`) |
| `agent/certs/` | 학교 서버가 빠뜨린 공개 중간 인증서 (RapidSSL TLS RSA CA G1, ~2027-11-02) |

## 안전 동작

- 클라우드 미연결 또는 좌석 정보가 `SEAT_STALE_SECONDS`보다 오래되면 버튼 입력을 **거부**하고 Arduino에 `STATUS,OFFLINE`을 보냅니다.
- 오프라인 중 입력을 저장했다가 나중에 반영하지 않습니다.
- Arduino 연결이 끊겨도 좌석 상태는 바뀌지 않습니다 (로그와 장치 이벤트만 기록).
- 서보모터 명령은 코드 수준에서 차단되어 있습니다.

## 개발 PC에서 테스트

하드웨어·네트워크·외부 패키지 없이 실행됩니다.

```powershell
cd raspberry-pi
python -m unittest discover -s tests -t . -v
```

## 라즈베리파이 설치 (아직 수행하지 않음)

```bash
# 저장소를 /home/pi/library-project 에 배치한 뒤
cd /home/pi/library-project/raspberry-pi
sudo apt install -y python3-venv
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp .env.example .env
chmod 600 .env
nano .env                      # LIBRARY_API_BASE_URL, LIBRARY_DEVICE_TOKEN 설정

sudo usermod -aG dialout pi    # 시리얼 포트 권한 (재로그인 필요)
mkdir -p logs

# 수동 실행
.venv/bin/python -m agent.main

# 서비스 등록
sudo cp systemd/library-agent.service.example /etc/systemd/system/library-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now library-agent
```

환경 점검: `bash ../scripts/check_raspberry_pi.sh`

## BLE GATT 서버 (모바일 앱 통신 시험)

모바일 앱(`mobile-app/`)과 BLE로 통신하는 별도 프로그램입니다. 명세: `docs/BLE_GATT_SPEC.md`.
좌석 에이전트와 다른 프로세스·서비스이며 Arduino·서보·좌석 상태·클라우드에 접근하지 않습니다.
명령은 부작용 없는 PING/ECHO/INFO 뿐이고, 로그는 journald 에만 남습니다 (ECHO 내용은 기록하지 않음).

```bash
cd ~/library-project && git pull
cd raspberry-pi
.venv/bin/pip install -r requirements-ble.txt
.venv/bin/python -m unittest discover -s tests -t .

# 블루투스 켜짐·권한 확인
sudo rfkill unblock bluetooth
systemctl is-active bluetooth          # active
id -nG | grep -wq bluetooth || sudo usermod -aG bluetooth pi

# 수동 실행으로 먼저 확인 (Ctrl+C 로 종료)
.venv/bin/python -m agent.ble_server

# 서비스 등록
sudo install -m 644 systemd/library-ble.service.example /etc/systemd/system/library-ble.service
sudo systemctl daemon-reload && sudo systemctl enable --now library-ble
journalctl -u library-ble -f           # ble.started, ble.subscribed, ble.command
```

- 광고 이름 `LIB-SEAT-PI` 로 Pi 의 블루투스 별칭(alias)이 바뀝니다.
- 끄기: `sudo systemctl disable --now library-ble` (좌석 에이전트에는 영향 없음)
- 보안: 페어링·암호화 없이 누구나 연결할 수 있으므로 상태를 바꾸는 명령은 넣지 않습니다. 추가하려면 `BLE_GATT_SPEC.md` 에 인증 방식을 먼저 설계합니다.

## 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 정상 종료 |
| 1 | 실행 중 비정상 종료 (systemd가 재시작) |
| 2 | 설정 오류 (재시작하지 않음, `.env` 확인) |
