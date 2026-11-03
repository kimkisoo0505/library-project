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
| `agent/event_handler.py` | 버튼 입력 → 클라우드 전달, 오프라인 시 거부, 상태 알림 |

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

## 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 정상 종료 |
| 1 | 실행 중 비정상 종료 (systemd가 재시작) |
| 2 | 설정 오류 (재시작하지 않음, `.env` 확인) |
