-- =====================================================================
-- Migration 0007_room_layout - 열람실 좌석 배치(관리자 드래그 편집)
--
-- - layout: 줄·칸 수, 좌석별 위치(seat_no → 줄/칸), 출입구·칠판·창가 표시 블록을 담은 JSON.
--   NULL = 기본 배치(3석 + 통로 + 3석). 형식 검증은 서버(workers/layout.js)가 한다.
-- - layout_version: 저장할 때마다 1 증가. 저장 요청은 편집을 시작한 버전과 같을 때만 반영되어
--   두 관리자가 동시에 편집해도 한쪽 변경을 모르고 덮어쓰지 않는다.
-- - 좌석 수·번호(seats)는 바뀌지 않는다. 위치만 저장한다.
-- =====================================================================
ALTER TABLE rooms ADD COLUMN layout TEXT CHECK (layout IS NULL OR length(layout) <= 8000);
ALTER TABLE rooms ADD COLUMN layout_version INTEGER NOT NULL DEFAULT 0;
