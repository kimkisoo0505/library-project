# 시스템 아키텍처

## 1. 전체 구성

```
 ┌──────────────────────┐        HTTPS / WSS         ┌───────────────────────────────────────┐
 │ 웹 키오스크 / 관리자  │ ─────────────────────────▶ │        Cloudflare Workers (API)        │
 │ (Cloudflare Pages)   │ ◀──── seats.changed ────── │  router · auth · seats · reservations │
 └──────────────────────┘                            │        │                    │          │
                                                     │        ▼                    ▼          │
                                                     │   ┌─────────┐      ┌──────────────────┐│
                                                     │   │   D1    │      │ Durable Object   ││
                                                     │   │ (기준)  │      │ SeatRoom (WS 중계)││
                                                     │   └─────────┘      └──────────────────┘│
                                                     └───────────────────────▲───────────────┘
                                                                             │ HTTPS / WSS
                                                                             │ (외부 발신만)
 ┌──────────────────────┐   USB 시리얼 115200bps    ┌──────────────────────────┴──┐
 │   Arduino UNO R3     │ ◀───────────────────────▶ │ Raspberry Pi 3 B+ 에이전트   │
 │ 버튼 / (서보: 예정)   │   줄 단위 ASCII 프로토콜   │ library-server (Python 3.13)│
 └──────────────────────┘                           └─────────────────────────────┘
```

## 2. 구성요소별 책임

| 구성요소 | 책임 | 상태 보유 |
|---|---|---|
| D1 | 학생/관리자/세션/좌석/예약/이벤트 저장. **좌석 상태의 유일한 기준** | 영구 |
| Workers | 인증, 입력 검증, 원자적 예약 처리, 이벤트 기록, 변경 알림 트리거 | 없음 (stateless) |
| Durable Object `SeatRoom` | WebSocket 연결 보관, 변경 알림 브로드캐스트 | 연결 목록만 |
| 웹 키오스크 | 좌석 표시, 로그인, 예약 요청 | 화면 캐시 |
| Raspberry Pi 에이전트 | Arduino ↔ 클라우드 중계, 좌석 캐시, 장애 감지/로그 | 캐시 (읽기 전용) |
| Arduino | 버튼 입력 감지, (향후) 서보/LED 제어 | 연결 상태 플래그 |

## 3. 주요 통신 흐름

### 3.1 좌석 예약 (웹)
```
키오스크 ──POST /api/reservations {seat_id}──▶ Workers
Workers: 학생 세션 확인 → 만료 예약 정리
         INSERT ... SELECT ... WHERE 좌석 available   ← 부분 UNIQUE 인덱스가 동시 요청 중 1건만 허용
         ├ 성공  → events 기록 → SeatRoom 브로드캐스트 → 201
         └ 충돌  → events 기록(reservation.conflict) → 409
SeatRoom ──{"type":"seats.changed"}──▶ 모든 키오스크 / 에이전트 → GET /api/seats 재조회
```

### 3.2 착석 / 퇴실 / 취소
`UPDATE reservations SET ... WHERE id=? AND student_id=? AND status='<이전 상태>' RETURNING`
조건을 만족할 때만 원자적으로 상태가 바뀌며, 결과가 없으면 409를 반환합니다.

### 3.3 예약 만료
Cron(1분) 및 예약 생성 직전에 `status='reserved' AND expires_at <= now` 예약을 `expired`로 전환합니다.

### 3.4 버튼 입력 (현장)
```
Arduino ──BTN,1,PRESS──▶ 에이전트
에이전트: 클라우드 연결 + 좌석 정보 최신?
         ├ 예 → POST /api/device/events (장치 토큰) → 서버가 기록 (현재는 기록만, 상태 변경 없음)
         └ 아니오 → 입력 거부, 로컬 로그, Arduino에 STATUS,OFFLINE
```

### 3.5 실시간 동기화
- 클라이언트는 `/api/ws`로 WebSocket을 열고 `seats.changed` 알림을 받으면 REST로 전체 목록을 다시 받습니다.
- 알림에는 개인정보가 없습니다. 개인별 정보(내 좌석)는 인증된 REST 응답에만 포함됩니다.
- WebSocket이 끊기면 키오스크는 30초, 에이전트는 `SEAT_SYNC_SECONDS` 간격으로 폴링하여 복구합니다.

## 4. 장애 시나리오

| 장애 | 동작 |
|---|---|
| 키오스크 네트워크 단절 | 예약 버튼 비활성, 재연결 후 서버 상태로 재표시 |
| 라즈베리파이 ↔ 클라우드 단절 | 버튼 입력 거부(로컬 승인 없음), 좌석 캐시는 마지막 값 유지 + stale 처리, 지수 백오프 재연결 |
| Arduino USB 단절 | 좌석 상태 변경 없음, 로그/장치 이벤트 기록, 5초 간격 재연결 |
| 브로드캐스트 실패 | DB에는 영향 없음, 클라이언트 주기 재조회로 복구 |
| 에이전트 프로세스 비정상 종료 | systemd `Restart=on-failure` |
| 설정 오류 | 종료 코드 2, 재시작하지 않음 |

## 5. 보안 경계

- 학생 세션 / 관리자 세션 / 장치 토큰 세 가지 인증 주체를 분리합니다.
- 세션 토큰은 DB에 SHA-256 해시로만 저장합니다.
- 장치 토큰(`DEVICE_TOKEN`)은 Workers secret과 Pi의 `.env`(권한 600)에만 존재합니다.
- 라즈베리파이는 인바운드 포트를 열지 않습니다 (포트포워딩 금지).
- CORS는 `ALLOWED_ORIGINS`에 등록된 Origin만 허용합니다.
