-- =====================================================================
-- Migration 0006_room_location - 열람실 위치(강의실 호수)
--
-- - 관리자가 관리자 화면에서 입력한다 (예: "00관 000호"). 빈 문자열 = 미입력.
-- - 키오스크는 /api/seats 의 rooms[].location 으로 받아 열람실 이름 옆에 표시한다.
-- =====================================================================
ALTER TABLE rooms ADD COLUMN location TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 40);
