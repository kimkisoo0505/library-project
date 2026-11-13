/**
 * 관리자: 예비 열람실로 쓰는 강의실 위치 (건물 + 호실)
 *
 * 저장 값은 서버 rooms.location 의 한 줄 글자 그대로다 (서버·DB 변경 없음, 최대 40자).
 *   강의동:     "5강의동 4405호"
 *   그 밖 건물: "제2공학관 1201호"
 *
 * 건물 목록: 경기대학교 수원캠퍼스 (2026-11 확인, 나무위키 '경기대학교/수원캠퍼스' 문서 기준).
 *   실내 공간이 없거나(운동장·정문·잔디광장), 철거(경기탑)·운영 종료(한우리관)된 곳은 뺐다.
 *   건물이 새로 생기거나 이름이 바뀌면 이 목록만 고치면 된다.
 */
export const ROOM_MAX_DIGITS = 5;

/**
 * id: 저장·선택용 고유 값, short: 학생 화면에 보이는 이름, name: 건물 이름(목록·옛 값 해석용)
 * @type {ReadonlyArray<{id: string, group: string, short: string, name?: string}>}
 */
export const BUILDINGS = Object.freeze([
  { id: 'L1', group: '강의동', short: '1강의동', name: '진리관' },
  { id: 'L2', group: '강의동', short: '2강의동', name: '성신관' },
  { id: 'L3', group: '강의동', short: '3강의동', name: '애경관' },
  { id: 'L4', group: '강의동', short: '4강의동', name: '예지관' },
  { id: 'L5', group: '강의동', short: '5강의동', name: '덕문관' },
  { id: 'L6', group: '강의동', short: '6강의동', name: '광교관' },
  { id: 'L7', group: '강의동', short: '7강의동', name: '집현관' },
  { id: 'L8', group: '강의동', short: '8강의동', name: '육영관' },
  { id: 'L9', group: '강의동', short: '9강의동', name: '호연관' },
  { id: 'general', group: '그 밖의 강의·교육 건물', short: '종합강의동' },
  { id: 'eng2', group: '그 밖의 강의·교육 건물', short: '제2공학관' },
  { id: 'englab', group: '그 밖의 강의·교육 건물', short: '공학실습동' },
  { id: 'yehak', group: '그 밖의 강의·교육 건물', short: '예학관', name: '조각실습동' },
  { id: 'mirae', group: '그 밖의 강의·교육 건물', short: '미래관', name: '교육관' },
  { id: 'planm', group: '그 밖의 강의·교육 건물', short: '이민규센터', name: 'KGU-PLANM' },
  { id: 'library', group: '도서관·학생·편의 시설', short: '중앙도서관' },
  { id: 'seminar', group: '도서관·학생·편의 시설', short: '중앙세미나실' },
  { id: 'student', group: '도서관·학생·편의 시설', short: '학생회관' },
  { id: 'eoullim', group: '도서관·학생·편의 시설', short: '어울림관' },
  { id: 'welfare1', group: '도서관·학생·편의 시설', short: '제1복지관' },
  { id: 'esquare', group: '도서관·학생·편의 시설', short: 'E-스퀘어' },
  { id: 'gamsung', group: '도서관·학생·편의 시설', short: '감성코어' },
  { id: 'museum', group: '도서관·학생·편의 시설', short: '소성박물관' },
  { id: 'dream', group: '도서관·학생·편의 시설', short: '경기드림타워', name: '기숙사' },
  { id: 'telecon', group: '연구·행정·기타', short: '텔레컨벤션센터' },
  { id: 'prof', group: '연구·행정·기타', short: '교수연구동' },
  { id: 'research', group: '연구·행정·기타', short: '리서치센터' },
  { id: 'iucf', group: '연구·행정·기타', short: '산학협력단' },
  { id: 'pr', group: '연구·행정·기타', short: '홍보관' },
  { id: 'ssireum', group: '연구·행정·기타', short: '수원광교씨름장' },
]);

/** 목록에 보이는 이름: "5강의동 덕문관", "미래관 (교육관)" */
export function buildingLabel(b) {
  if (!b.name) return b.short;
  return b.group === '강의동' ? `${b.short} ${b.name}` : `${b.short} (${b.name})`;
}

export function findBuilding(id) {
  return BUILDINGS.find((b) => b.id === id) ?? null;
}

export function isValidRoom(room) {
  return typeof room === 'string' && new RegExp(`^\\d{1,${ROOM_MAX_DIGITS}}$`).test(room);
}

/** 건물 + 호실 → 저장할 글자. 잘못된 값이면 null */
export function formatLocation(buildingId, room) {
  const b = findBuilding(buildingId);
  if (!b || !isValidRoom(room)) return null;
  return `${b.short} ${room}호`;
}

/**
 * 저장된 글자 → { buildingId, room }. 이 형식이 아니면 null (옛 자유 입력 값 등).
 * 너그럽게 읽는 예: "제 5강의동 5102호", "5강의동(덕문관) 5102", "덕문관 5102호", "제2공학관1201호"
 */
export function parseLocation(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  s = s.replace(/^제\s*(\d)\s*강의동/, '$1강의동'); // "제 5강의동" → "5강의동"
  const aliases = [];
  for (const b of BUILDINGS) {
    aliases.push([b.short, b]);
    if (b.name) aliases.push([b.name, b], [`${b.short}(${b.name})`, b], [`${b.short} (${b.name})`, b], [`${b.short} ${b.name}`, b]);
  }
  aliases.sort((x, y) => y[0].length - x[0].length); // 긴 이름부터 (예: "5강의동 덕문관" 이 "5강의동" 보다 먼저)
  for (const [alias, b] of aliases) {
    if (!s.startsWith(alias)) continue;
    const m = /^\s*(\d{1,5})\s*호?$/.exec(s.slice(alias.length));
    if (m && isValidRoom(m[1])) return { buildingId: b.id, room: m[1] };
  }
  return null;
}
