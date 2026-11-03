-- =====================================================================
-- Migration 0004_device_status - 현장 장치(라즈베리파이 / 아두이노)의 최근 상태
--
-- 장치가 30초마다 보고하는 최신 상태 1행만 유지한다 (이력은 events 테이블이 아닌 여기서 덮어씀).
-- 키오스크 임시 상태 표시줄(/api/system-status)에서 사용. IP 주소 등은 저장하지 않는다.
-- =====================================================================
CREATE TABLE device_status (
    device_id       TEXT    PRIMARY KEY,        -- X-Device-Id (예: library-server)
    room            TEXT    NOT NULL,           -- 담당 열람실 코드 (A/B/C)
    last_seen_at    TEXT    NOT NULL,
    payload         TEXT    NOT NULL            -- 정규화된 JSON (네트워크, LCD, 시리얼, 중계 결과)
);
CREATE INDEX ix_device_status_room ON device_status (room);
