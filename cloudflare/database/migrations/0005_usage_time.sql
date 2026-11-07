-- =====================================================================
-- Migration 0005_usage_time - 좌석 이용 시간 / 자동 퇴실 / 재실 확인
--
-- - 착석 시 학생이 1~4시간 중 이용 시간을 고른다 (usage_hours).
-- - usage_ends_at 이 지나면 Cron(1분)이 자동 퇴실 처리한다 (end_reason = 'time_expired').
-- - 모바일 앱이 열람실 안(블루투스)임을 보고하면 남은 시간이 2시간 미만일 때
--   usage_ends_at 을 "지금 + 2시간"으로 올린다. 마지막 보고 시각은 last_presence_at.
--   위치·이동 기록은 저장하지 않는다 (마지막 시각 1개만 덮어씀).
--
-- 배포 시점에 이미 착석 중인 좌석(이용 시간 개념이 없던 예약)은 지금부터 4시간으로 채운다.
-- =====================================================================
ALTER TABLE reservations ADD COLUMN usage_hours INTEGER CHECK (usage_hours IS NULL OR usage_hours BETWEEN 1 AND 4);
ALTER TABLE reservations ADD COLUMN usage_ends_at TEXT;
ALTER TABLE reservations ADD COLUMN last_presence_at TEXT;

CREATE INDEX ix_reservations_status_usage_ends ON reservations (status, usage_ends_at);

UPDATE reservations
   SET usage_hours = 4,
       usage_ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+4 hours')
 WHERE status = 'occupied' AND usage_ends_at IS NULL;
