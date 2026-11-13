/**
 * 경기대학교 수원캠퍼스 건물 목록 · 강의실 위치 형식 · 지도 좌표 (공용)
 *
 * 관리자 화면(강의실 위치 선택)과 개인 사용 화면(가까운 열람실 지도)이 함께 쓴다.
 * 저장된 위치 글자("5강의동 4405호")를 두 화면이 같은 규칙으로 읽어야 지도 위치가 맞으므로 한 파일에 둔다.
 *
 * 저장 값은 서버 rooms.location 의 한 줄 글자 그대로다 (서버·DB 변경 없음, 최대 40자).
 *   강의동:     "5강의동 4405호"
 *   그 밖 건물: "제2공학관 1201호"
 *
 * 건물 목록: 경기대학교 수원캠퍼스 (2026-11 확인, 나무위키 '경기대학교/수원캠퍼스' 문서 기준).
 *   애매한 곳도 넣었다 (운영 종료된 한우리관, 위치가 불확실한 호연관·이민규센터 등 — 사용자 요청 2026-11-13).
 *   실내 공간이 없는 곳(운동장·정문·후문·잔디광장)과 철거된 경기탑만 뺐다.
 *   건물이 새로 생기거나 이름이 바뀌면 이 목록만 고치면 된다.
 *
 * 좌표(pos: [위도, 경도]): 카카오 장소 검색 결과를 우선 쓴다 (2026-11-13).
 *   카카오가 다른 장소를 찾은 예학관(주차장)·한우리관(드림타워)과 카카오에 없는 공학실습동은
 *   OpenStreetMap(Nominatim, © OpenStreetMap contributors, ODbL) 좌표를 쓴다. 두 자료는 대부분 2~17m 안에서 일치했다.
 *   pos 가 없는 곳(수원광교씨름장)은 지도·거리 계산에서 "위치 정보 없음"으로 나온다.
 */
export const ROOM_MAX_DIGITS = 5;

/**
 * id: 저장·선택용 고유 값, short: 학생 화면에 보이는 이름, name: 건물 이름(목록·옛 값 해석용), pos: [위도, 경도]
 * @type {ReadonlyArray<{id: string, group: string, short: string, name?: string, pos?: [number, number]}>}
 */
export const BUILDINGS = Object.freeze([
  { id: 'L1', group: '강의동', short: '1강의동', name: '진리관', pos: [37.300760, 127.033941] },
  { id: 'L2', group: '강의동', short: '2강의동', name: '성신관', pos: [37.299652, 127.033543] },
  { id: 'L3', group: '강의동', short: '3강의동', name: '애경관', pos: [37.299409, 127.034231] },
  { id: 'L4', group: '강의동', short: '4강의동', name: '예지관', pos: [37.300741, 127.036476] },
  { id: 'L5', group: '강의동', short: '5강의동', name: '덕문관', pos: [37.299984, 127.036769] },
  { id: 'L6', group: '강의동', short: '6강의동', name: '광교관', pos: [37.300997, 127.038358] },
  { id: 'L7', group: '강의동', short: '7강의동', name: '집현관', pos: [37.301343, 127.038809] },
  { id: 'L8', group: '강의동', short: '8강의동', name: '육영관', pos: [37.300840, 127.039319] },
  { id: 'L9', group: '강의동', short: '9강의동', name: '호연관', pos: [37.304188, 127.033956] },
  { id: 'general', group: '그 밖의 강의·교육 건물', short: '종합강의동', pos: [37.301314, 127.037320] },
  { id: 'eng2', group: '그 밖의 강의·교육 건물', short: '제2공학관', pos: [37.300246, 127.040000] },
  { id: 'englab', group: '그 밖의 강의·교육 건물', short: '공학실습동', pos: [37.301265, 127.039569] },
  { id: 'yehak', group: '그 밖의 강의·교육 건물', short: '예학관', name: '조각실습동', pos: [37.302930, 127.034073] },
  { id: 'mirae', group: '그 밖의 강의·교육 건물', short: '미래관', name: '교육관', pos: [37.300155, 127.033458] },
  { id: 'planm', group: '그 밖의 강의·교육 건물', short: '이민규센터', name: 'KGU-PLANM', pos: [37.303943, 127.035373] },
  { id: 'library', group: '도서관·학생·편의 시설', short: '중앙도서관', pos: [37.301160, 127.035647] },
  { id: 'seminar', group: '도서관·학생·편의 시설', short: '중앙세미나실', pos: [37.301214, 127.035213] },
  { id: 'student', group: '도서관·학생·편의 시설', short: '학생회관', pos: [37.302931, 127.036197] },
  { id: 'eoullim', group: '도서관·학생·편의 시설', short: '어울림관', pos: [37.303621, 127.035959] },
  { id: 'welfare1', group: '도서관·학생·편의 시설', short: '제1복지관', pos: [37.303082, 127.035802] },
  { id: 'esquare', group: '도서관·학생·편의 시설', short: 'E-스퀘어', pos: [37.300622, 127.037408] },
  { id: 'gamsung', group: '도서관·학생·편의 시설', short: '감성코어', pos: [37.301149, 127.036125] },
  { id: 'museum', group: '도서관·학생·편의 시설', short: '소성박물관', pos: [37.302616, 127.035778] },
  { id: 'dream', group: '도서관·학생·편의 시설', short: '경기드림타워', name: '기숙사', pos: [37.297529, 127.038607] },
  { id: 'hanwoori', group: '도서관·학생·편의 시설', short: '한우리관', name: '기숙사', pos: [37.297654, 127.033411] },
  { id: 'telecon', group: '연구·행정·기타', short: '텔레컨벤션센터', pos: [37.302331, 127.034925] },
  { id: 'prof', group: '연구·행정·기타', short: '교수연구동', pos: [37.301942, 127.036567] },
  { id: 'research', group: '연구·행정·기타', short: '리서치센터', pos: [37.300830, 127.040645] },
  { id: 'iucf', group: '연구·행정·기타', short: '산학협력단', pos: [37.300626, 127.038432] },
  { id: 'pr', group: '연구·행정·기타', short: '홍보관', pos: [37.302451, 127.033748] },
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

/** 경기대학교 중앙도서관 (수원) 지도 위치 — 개인 사용 화면 '가까운 열람실'에서 예비 열람실과 함께 비교 */
export const CENTRAL_LIBRARY = Object.freeze({ name: '중앙도서관', pos: findBuilding('library').pos });

/** 저장된 위치 글자 → 그 건물의 지도 좌표 [위도, 경도]. 모르면 null */
export function locationPosition(text) {
  const parsed = parseLocation(text);
  return parsed ? findBuilding(parsed.buildingId)?.pos ?? null : null;
}
