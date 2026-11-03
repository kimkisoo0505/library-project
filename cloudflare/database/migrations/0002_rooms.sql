-- =====================================================================
-- Migration 0002_rooms - 열람실 3개(A/B/C) x 30석 = 90석
--
-- seats 의 CHECK (id BETWEEN 1 AND 30) 제약을 바꾸려면 테이블을 재생성해야 한다.
-- reservations.seat_id 가 seats(id)를 참조하므로 순서가 중요하다:
--   백업 -> 원본 DROP -> 새 테이블을 seats 로 RENAME -> 백업에서 다시 INSERT
-- (복사 후 DROP/RENAME 하면 지연된 외래 키 위반이 해소되지 않아 커밋이 실패한다)
-- 기존 좌석 1~30(A01~A30)은 id 를 유지한 채 열람실 A 로 편입되므로 예약 이력이 보존된다.
-- =====================================================================
PRAGMA defer_foreign_keys = true;

CREATE TABLE rooms (
    id              INTEGER PRIMARY KEY,
    code            TEXT    NOT NULL UNIQUE CHECK (length(code) = 1 AND code BETWEEN 'A' AND 'Z'),
    name            TEXT    NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO rooms (id, code, name, sort_order) VALUES
    (1, 'A', '열람실 A', 1),
    (2, 'B', '열람실 B', 2),
    (3, 'C', '열람실 C', 3);

CREATE TABLE seats_backup AS SELECT id, label, status, updated_at FROM seats;

CREATE TABLE seats_new (
    id              INTEGER PRIMARY KEY,
    room_id         INTEGER NOT NULL REFERENCES rooms (id),
    seat_no         INTEGER NOT NULL CHECK (seat_no >= 1),
    label           TEXT    NOT NULL UNIQUE,
    status          TEXT    NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (room_id, seat_no)
);

DROP TABLE seats;
ALTER TABLE seats_new RENAME TO seats;

-- 기존 30석 -> 열람실 A (id, 라벨, 관리 상태 유지)
INSERT INTO seats (id, room_id, seat_no, label, status, updated_at)
SELECT id, 1, id, label, status, updated_at FROM seats_backup;

DROP TABLE seats_backup;

-- 열람실 B (id 31~60), C (id 61~90)
INSERT INTO seats (id, room_id, seat_no, label)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
SELECT 30 + i, 2, i, printf('B%02d', i) FROM n;

INSERT INTO seats (id, room_id, seat_no, label)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
SELECT 60 + i, 3, i, printf('C%02d', i) FROM n;

CREATE INDEX ix_seats_room ON seats (room_id, seat_no);

PRAGMA defer_foreign_keys = false;
