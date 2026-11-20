-- =====================================================================
-- Migration 0008_stats_indexes - 이용 기록 · 통계 조회용 인덱스
--
-- - 학생 본인 이용 기록(최신순)과 통계: reservations (student_id, id)
-- - 관리자 기간 통계: reserved_at / ended_at 범위 조회
-- 테이블 구조는 바뀌지 않는다 (공부 시간은 checked_in_at ~ 퇴실 시각으로 계산).
-- =====================================================================
CREATE INDEX IF NOT EXISTS ix_reservations_student ON reservations (student_id, id);
CREATE INDEX IF NOT EXISTS ix_reservations_reserved_at ON reservations (reserved_at);
CREATE INDEX IF NOT EXISTS ix_reservations_ended_at ON reservations (ended_at);
