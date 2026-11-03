# 데이터베이스 설계 (Cloudflare D1)

- 엔진: Cloudflare D1 (SQLite 호환)
- 스키마 참조본: [cloudflare/database/schema.sql](../cloudflare/database/schema.sql)
- 마이그레이션: [cloudflare/database/migrations/](../cloudflare/database/migrations/) (번호 순 적용, 적용된 파일은 수정 금지)
- 시간 컬럼: UTC ISO 8601 문자열 (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` 및 JS `toISOString()`과 같은 형식이므로 문자열 비교 가능)

## ER 개요

```
rooms 1 ──< seats 1 ──< reservations >── 1 students
                                              │
                                              └── sessions (subject_type='student')
admins ──── sessions (subject_type='admin')
events (seat_id, reservation_id, actor_* 로 느슨하게 참조)
```

## 테이블

### students — 학생 계정
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INTEGER PK | 내부 ID |
| student_no | TEXT UNIQUE | 학번 (로그인 ID) |
| display_name | TEXT | 화면 표시 이름 |
| password_hash | TEXT | `pbkdf2_sha256$<반복>$<salt>$<hash>` |
| is_active | INTEGER | 1=사용, 0=정지 |
| created_at / updated_at | TEXT | |

> 실제 학생 데이터는 시드하지 않습니다. 학번+이름만으로 로그인할 수 없으며 비밀번호가 필요합니다.

### admins — 관리자 계정 (학생과 별도 테이블)
`id, username UNIQUE, password_hash, is_active, created_at`

### sessions — 로그인 세션
| 컬럼 | 설명 |
|---|---|
| token_hash | 토큰 원문이 아닌 SHA-256 해시 |
| subject_type | `student` / `admin` (권한 분리 기준) |
| subject_id | students.id 또는 admins.id |
| expires_at / revoked_at | 만료 및 로그아웃 |

### rooms — 열람실 (0002_rooms)
| 컬럼 | 설명 |
|---|---|
| id | 1, 2, 3 |
| code | `A` / `B` / `C` (대문자 한 글자) |
| name | `열람실 A` 등 화면 표시 이름 |
| sort_order | 표시 순서 |

### seats — 좌석 (3실 × 30석 = 90석)
| 컬럼 | 설명 |
|---|---|
| id | **전체에서 고유한 좌석 번호**. A=1~30, B=31~60, C=61~90. 예약 API의 `seat_id` |
| room_id | rooms.id |
| seat_no | 열람실 안의 좌석 번호 1~30 (`UNIQUE(room_id, seat_no)`) |
| label | `A01`~`A30`, `B01`~`B30`, `C01`~`C30` (UNIQUE) |
| status | `available` / `maintenance` — **관리 상태만** 저장 |

**1인 1좌석은 열람실 전체 기준**입니다. 열람실 A에 예약이 있으면 B·C에도 예약할 수 없습니다.

#### 0002_rooms 마이그레이션 주의
`seats.id`의 `CHECK (id BETWEEN 1 AND 30)`을 없애기 위해 테이블을 재생성합니다. `reservations`가 `seats`를 참조하므로
**백업 → 원본 DROP → 새 테이블 RENAME → 백업에서 INSERT** 순서로 해야 합니다. 복사 후 DROP/RENAME 하면
지연된 외래 키 위반이 해소되지 않아 커밋이 실패합니다(기존 예약이 있는 상태에서 재현 확인).
기존 30석은 id를 유지한 채 열람실 A가 되므로 예약 이력이 그대로 보존됩니다.
검증: `python cloudflare/tests/check_schema.py` (CI에서도 실행)

점유 상태(예약/착석)는 seats에 중복 저장하지 않고 `reservations`의 활성 행에서 파생합니다. 두 곳에 상태를 두지 않아 불일치가 생기지 않습니다.

### reservations — 예약/이용 기록
| 컬럼 | 설명 |
|---|---|
| status | `reserved` → `occupied` → `completed`, 또는 `cancelled` / `expired` |
| reserved_at, expires_at | 예약 시각, 착석 기한 |
| checked_in_at, checked_out_at | 착석/퇴실 시각 |
| ended_at, end_reason | 종료 시각, `user_cancelled` / `hold_timeout` / `checked_out` / `admin_release` |

상태 전이:
```
          ┌── cancel ──▶ cancelled
reserved ─┼── 기한 초과 ─▶ expired
          └── check-in ─▶ occupied ── check-out ─▶ completed
관리자 해제: reserved → cancelled, occupied → completed
```

### events — 감사 로그
`occurred_at, source(web/admin/device/system), event_type, actor_type, actor_id, seat_id, reservation_id, payload(JSON)`
비밀번호·토큰은 기록하지 않으며, 로그인 실패 시 존재하지 않는 학번은 저장하지 않습니다.

## 중복 예약 방지 (원자성)

```sql
CREATE UNIQUE INDEX ux_reservations_active_seat
  ON reservations (seat_id)    WHERE status IN ('reserved','occupied');
CREATE UNIQUE INDEX ux_reservations_active_student
  ON reservations (student_id) WHERE status IN ('reserved','occupied');
```

예약 생성은 단일 문장으로 수행합니다.
```sql
INSERT INTO reservations (seat_id, student_id, status, reserved_at, expires_at)
SELECT ?1, ?2, 'reserved', ?3, ?4
 WHERE EXISTS (SELECT 1 FROM seats WHERE id = ?1 AND status = 'available')
RETURNING id, ...;
```
- 동시에 같은 좌석을 요청하면 D1(SQLite)의 직렬화된 쓰기와 UNIQUE 인덱스에 의해 **하나만 성공**, 나머지는 `UNIQUE constraint failed` → 409.
- 점검 중 좌석은 `WHERE EXISTS` 조건으로 0행 삽입 → 409.
- 상태 전이도 `UPDATE ... WHERE status = '<이전>' RETURNING`으로 원자 처리합니다.

## 마이그레이션 명령

```powershell
cd cloudflare
npx wrangler d1 migrations apply library-seat-db --local     # 로컬
npx wrangler d1 migrations apply library-seat-db --remote    # 운영 (준비 후)
```

## 향후 고려

- 오래된 sessions / events 정리 정책 (보존 기간)
- 학생 개인정보 최소화: 표시 이름 대신 별칭 사용 검토
- 운영 시간, 좌석 구역 등 확장 컬럼
