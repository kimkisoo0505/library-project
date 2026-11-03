# API 명세 v0.1

Base URL: `https://<worker>.workers.dev/api` (로컬: `http://127.0.0.1:8787/api`)

## 공통

- 요청/응답 본문: `application/json; charset=utf-8`
- 시간: UTC ISO 8601 (`2026-01-01T09:00:00.000Z`)
- 인증 헤더: `Authorization: Bearer <token>`
- 오류 형식:
  ```json
  { "error": { "code": "seat_already_reserved", "message": "이미 다른 사용자가 예약한 좌석입니다." } }
  ```

| 인증 종류 | 발급 | 사용 범위 |
|---|---|---|
| 학생 세션 | `POST /auth/login` | 예약 관련 API |
| 관리자 세션 | `POST /admin/login` | `/admin/*` |
| 장치 토큰 | Workers secret `DEVICE_TOKEN` | `/device/*`, `/ws?role=device` |

학생 토큰으로 관리자 API 호출 시 `403 forbidden`, 그 반대도 마찬가지입니다.

## 상태 코드

| 코드 | 의미 |
|---|---|
| 200 / 201 / 202 | 성공 / 생성됨 / 접수됨(기록만) |
| 400 | 입력 형식 오류 |
| 401 | 인증 필요 또는 세션 만료 |
| 403 | 권한 없음 (주체 종류 불일치) |
| 404 / 405 | 경로 없음 / 메서드 불가 |
| 409 | 상태 충돌 (중복 예약, 잘못된 상태 전이) |
| 413 / 415 | 본문 과대 / Content-Type 오류 |
| 503 | 서버 설정 미완료 (예: DEVICE_TOKEN 없음) |

---

## 1. 상태

### `GET /health`
```json
{ "ok": true, "service": "library-seat-api", "time": "..." }
```

## 2. 인증

### `POST /auth/login` — 학생 로그인
요청 `{ "student_no": "TEST-0001", "password": "..." }`
응답 `{ "token": "...", "expires_at": "...", "user": { "type": "student", "id": 1, "display_name": "..." } }`
오류: `400 invalid_credentials_format`, `401 invalid_credentials`

### `POST /admin/login` — 관리자 로그인
요청 `{ "username": "admin01", "password": "..." }`
응답 `{ "token": "...", "expires_at": "...", "user": { "type": "admin", "id": 1, "username": "admin01" } }`

### `POST /auth/logout` — 현재 세션 폐기 (학생/관리자 공통)
### `GET /auth/me` — 현재 세션 사용자 정보

## 3. 좌석

### `GET /seats?room=A` — 좌석 현황 (인증 선택)
`room`(선택): `A` / `B` / `C`. 생략하면 전체 90석. 없는 열람실 `404 room_not_found`, 형식 오류 `400`.
`rooms`는 필터와 관계없이 항상 전체 열람실 요약입니다.
```json
{
  "rooms": [
    { "code": "A", "name": "열람실 A", "total": 30, "available": 28 },
    { "code": "B", "name": "열람실 B", "total": 30, "available": 30 },
    { "code": "C", "name": "열람실 C", "total": 30, "available": 30 }
  ],
  "seats": [
    { "id": 1, "room": "A", "seat_no": 1, "label": "A01", "state": "available", "mine": false },
    { "id": 2, "room": "A", "seat_no": 2, "label": "A02", "state": "reserved", "mine": true, "reservation_id": 10, "expires_at": "..." }
  ],
  "generated_at": "..."
}
```
`state`: `available | reserved | occupied | maintenance`
다른 학생의 식별 정보는 포함되지 않습니다.

### `GET /central-library` — 경기대 중앙도서관(수원) · 금화도서관(서울) 공석 (인증 불필요)
출처 `libgate.kyonggi.ac.kr/libraries/lib-status/{1|2}`를 서버가 대신 조회하여 D1에 1분 단위로 캐시합니다.
이용자 요청마다 학교 서버를 호출하지 않으며, 동시에 여러 요청이 와도 외부 호출은 1건입니다.
```json
{
  "source": "경기대학교 도서관 (libgate.kyonggi.ac.kr)",
  "available": true,
  "fetched_at": "2026-11-03T15:25:25.030Z",
  "stale": false,
  "degraded": false,
  "campuses": [
    { "id": 1, "campus": "수원캠퍼스", "library": "중앙도서관", "total": 421, "available": 421, "fetched_at": "...",
      "rooms": [ { "code": 8, "name": "3F 제1열람실_플로어", "total": 50, "available": 50, "in_use": 0, "fixed": 0, "unavailable": 0, "hours": "06:00~00:00" } ] },
    { "id": 2, "campus": "서울캠퍼스", "library": "금화도서관", "total": 127, "available": 122, "rooms": [] }
  ]
}
```
- `stale`: 마지막 성공이 10분 이상 지남 / `degraded`: 최근 조회 일부·전부 실패 (사유는 관리자 이벤트 로그 `external.central_library_failed`)
- 한 캠퍼스만 실패하면 그 캠퍼스는 이전 결과를 유지합니다.

## 4. 예약 (학생 세션)

| 메서드 | 경로 | 설명 | 상태 전이 |
|---|---|---|---|
| POST | `/reservations` | 예약 생성 `{ "seat_id": 35 }` (전체 고유 좌석 id, 35 = B05) → 201 | (없음) → reserved |
| GET | `/reservations/me` | 내 활성 예약 (`room`, `room_name`, `seat_label` 포함, `reservation: null` 가능) | — |
| DELETE | `/reservations/:id` | 예약 취소 | reserved → cancelled |
| POST | `/reservations/:id/check-in` | 착석 (기한 내) | reserved → occupied |
| POST | `/reservations/:id/check-out` | 퇴실 | occupied → completed |

예약 생성 오류:
- `409 seat_already_reserved` — 다른 사용자가 먼저 예약
- `409 student_has_active_reservation` — 이미 활성 예약 보유 (1인 1좌석, **열람실 전체 기준**)
- `404 seat_not_found` — 존재하지 않는 좌석
- `409 seat_unavailable` — 점검 중인 좌석

상태 전이 오류: `409 invalid_reservation_state`

예약 후 `RESERVATION_HOLD_MINUTES`(기본 15분) 안에 착석하지 않으면 `expired` 처리됩니다.

## 5. 관리자 (관리자 세션)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/admin/seats?room=A` | 열람실 요약 + 좌석 + 활성 예약 상세 (`room` 생략 시 전체) |
| POST | `/admin/seats/:id/status` | `{ "status": "maintenance" \| "available", "reason": "..." }` 활성 예약이 있으면 `409 seat_in_use` |
| POST | `/admin/reservations/:id/release` | 활성 예약 강제 해제 `{ "reason": "..." }` (사유 필수) |
| GET | `/admin/events?limit=50&before_id=` | 이벤트 로그 최신순 (limit 1~200) |

## 6. 장치 (장치 토큰)

### `POST /device/events`
헤더: `Authorization: Bearer <DEVICE_TOKEN>`, `X-Device-Id: library-server`
요청:
```json
{ "type": "button", "button_id": 1, "action": "PRESS" }
```
`type`: `agent_started | heartbeat | serial_connected | serial_disconnected | serial_hello | protocol_error | button`
응답 `202 { "accepted": true, "action": "logged_only" }` — 현재는 기록만 하며 좌석 상태를 바꾸지 않습니다.

### `POST /device/central-library` — 중앙/금화도서관 공석 중계 (장치 토큰)
라즈베리파이가 1분마다 libgate 를 **인증서 검증을 켠 채로** 조회해 원본을 올립니다.
서버는 장치 입력도 다시 검증·정규화합니다 (모르는 캠퍼스·중복·형식 오류 무시, 실패한 캠퍼스는 이전 결과 유지).
```json
{ "campuses": [ { "id": 1, "data": [ { "code": 8, "name": "...", "cnt": 50, "available": 12, "inUse": 38, "fix": 0, "startTm": "0600", "endTm": "2400" } ] } ],
  "errors": ["금화도서관: ConnectError: ..."] }
```
응답 `202 { "accepted": true, "received": 1, "errors": 1 }`, 본문 최대 64KB.
`CENTRAL_LIBRARY_MODE=relay`(기본)이면 `GET /central-library` 는 학교 서버를 직접 호출하지 않습니다.

## 7. WebSocket

### `GET /ws` (Upgrade: websocket)
- 일반 클라이언트: 인증 없이 연결 (알림에 개인정보 없음)
- 장치: `/ws?role=device` + `Authorization` 헤더

서버 → 클라이언트:
```json
{ "type": "hello", "role": "viewer", "at": "..." }
{ "type": "seats.changed", "seat_id": 3, "reason": "reservation.created", "at": "..." }
{ "type": "pong", "at": "..." }
```
클라이언트 → 서버: `{ "type": "ping" }` 만 허용 (그 외 무시)

## 8. 미구현 / 예정

- 로그인 시도 횟수 제한 (rate limiting)
- 학생/관리자 계정 발급 API 또는 CLI
- 버튼 입력 → 착석 확인 등 현장 동작 매핑
- 운영 시간, 이용 시간 제한 정책
