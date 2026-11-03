-- =====================================================================
-- Migration 0001_initial - 최초 스키마 (적용 후 이 파일은 수정하지 않습니다)
-- 이후 변경은 0002_*.sql 처럼 새 파일로 추가하고 schema.sql도 함께 갱신합니다.
-- 시간 값은 모두 UTC ISO 8601 문자열 (예: 2026-01-01T00:00:00.000Z)
-- =====================================================================

-- 학생 계정 (실제 개인정보 시드 금지)
CREATE TABLE IF NOT EXISTS students (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_no      TEXT    NOT NULL UNIQUE,
    display_name    TEXT    NOT NULL,
    password_hash   TEXT    NOT NULL,             -- pbkdf2_sha256$<iter>$<salt_b64>$<hash_b64>
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 관리자 계정 (학생과 완전히 분리)
CREATE TABLE IF NOT EXISTS admins (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE,
    password_hash   TEXT    NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 로그인 세션 (토큰 원문은 저장하지 않고 SHA-256 해시만 저장)
CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash      TEXT    NOT NULL UNIQUE,
    subject_type    TEXT    NOT NULL CHECK (subject_type IN ('student', 'admin')),
    subject_id      INTEGER NOT NULL,
    created_at      TEXT    NOT NULL,
    expires_at      TEXT    NOT NULL,
    revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_subject ON sessions (subject_type, subject_id);

-- 좌석 (30석 고정). 점유 여부는 reservations에서 파생하며 여기에는 관리 상태만 저장
CREATE TABLE IF NOT EXISTS seats (
    id              INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 30),
    label           TEXT    NOT NULL UNIQUE,
    status          TEXT    NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 예약 및 이용 기록
--   reserved  : 예약됨 (expires_at 이전에 착석 필요)
--   occupied  : 착석 중
--   completed : 퇴실 완료
--   cancelled : 취소됨 (학생 또는 관리자)
--   expired   : 착석 시간 초과로 자동 만료
CREATE TABLE IF NOT EXISTS reservations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    seat_id         INTEGER NOT NULL REFERENCES seats (id),
    student_id      INTEGER NOT NULL REFERENCES students (id),
    status          TEXT    NOT NULL CHECK (status IN ('reserved', 'occupied', 'completed', 'cancelled', 'expired')),
    reserved_at     TEXT    NOT NULL,
    expires_at      TEXT    NOT NULL,
    checked_in_at   TEXT,
    checked_out_at  TEXT,
    ended_at        TEXT,
    end_reason      TEXT
);

-- [중복 예약 방지 핵심] 활성 예약은 좌석당 1건, 학생당 1건만 허용 (DB가 원자적으로 보장)
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_active_seat
    ON reservations (seat_id) WHERE status IN ('reserved', 'occupied');
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_active_student
    ON reservations (student_id) WHERE status IN ('reserved', 'occupied');
CREATE INDEX IF NOT EXISTS ix_reservations_status_expires
    ON reservations (status, expires_at);

-- 감사/이벤트 로그 (비밀번호, 토큰은 절대 기록하지 않음)
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at     TEXT    NOT NULL,
    source          TEXT    NOT NULL CHECK (source IN ('web', 'admin', 'device', 'system')),
    event_type      TEXT    NOT NULL,
    actor_type      TEXT    CHECK (actor_type IN ('student', 'admin', 'device', 'system')),
    actor_id        TEXT,
    seat_id         INTEGER,
    reservation_id  INTEGER,
    payload         TEXT                          -- JSON 문자열
);
CREATE INDEX IF NOT EXISTS ix_events_occurred ON events (occurred_at);
CREATE INDEX IF NOT EXISTS ix_events_type ON events (event_type);

-- 좌석 30개 기본 데이터 (개인정보 아님)
INSERT OR IGNORE INTO seats (id, label)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
SELECT i, printf('A%02d', i) FROM n;
