-- =====================================================================
-- Migration 0003_external_snapshots - 외부 데이터(경기대 중앙/금화도서관 공석) 캐시
--
-- 이용자 요청마다 학교 서버를 호출하지 않도록 마지막 조회 결과를 저장한다.
-- attempted_at 을 조건부 UPSERT 로 선점하여 동시에 여러 요청이 와도 1건만 외부 조회한다.
-- 개인정보 없음 (열람실별 좌석 수 / 운영 시간만 저장)
-- =====================================================================
CREATE TABLE external_snapshots (
    source          TEXT    PRIMARY KEY,
    payload         TEXT,                   -- 정규화된 JSON (마지막 성공 결과)
    fetched_at      TEXT,                   -- 마지막 성공 시각
    attempted_at    TEXT    NOT NULL,       -- 마지막 시도 시각 (동시 조회 방지용 선점)
    last_error      TEXT                    -- 마지막 실패 사유 (성공 시 NULL)
);
