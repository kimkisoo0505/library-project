/**
 * 개인 사용 화면: 내 위치에서 가장 가까운 열람실 (예비 열람실 A·B·C + 중앙도서관)
 *
 * - 거리: 두 좌표 사이의 직선거리(하버사인). 실제 걷는 길은 카카오맵 길찾기 링크로 안내한다.
 * - 추천: 빈자리가 있는 곳 중 가장 가까운 곳. 지도 위치를 모르는 곳(강의실 위치 미입력 등)은 거리 계산에서 뺀다.
 * - 내 위치는 이 화면 안에서만 쓰고 서버로 보내지 않는다.
 */
import { CENTRAL_LIBRARY, locationPosition } from '../common/campus-buildings.js';

const EARTH_RADIUS_M = 6_371_000;
const WALK_M_PER_MIN = 70; // 걷는 속도 약 4.2km/h (안내용 어림값)

/** 두 좌표([위도, 경도]) 사이 직선거리 (미터) */
export function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "약 120m" / "약 1.2km" */
export function formatDistance(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 1000) return `약 ${Math.max(10, Math.round(m / 10) * 10)}m`;
  return `약 ${(m / 1000).toFixed(1)}km`;
}

/** 걸어서 몇 분 (직선거리 기준 어림값, 최소 1분) */
export function walkMinutes(m) {
  return Math.max(1, Math.round(m / WALK_M_PER_MIN));
}

/**
 * 비교할 장소 목록
 * @param {Array<{code: string, name: string, location?: string, available: number, total: number}>} rooms /api/seats 의 rooms
 * @param {{available: number, total: number} | null} central 중앙도서관(수원) 공석. 모르면 null
 */
export function buildPlaces(rooms, central) {
  const places = (rooms ?? []).map((r) => ({
    id: r.code,
    kind: 'room',
    name: r.name,
    sub: String(r.location ?? '').trim(),
    pos: locationPosition(r.location ?? ''),
    available: Number(r.available) || 0,
    total: Number(r.total) || 0,
  }));
  places.push({
    id: 'central',
    kind: 'central',
    name: CENTRAL_LIBRARY.name,
    sub: '수원캠퍼스',
    pos: CENTRAL_LIBRARY.pos,
    available: central ? Number(central.available) || 0 : null, // null = 정보 없음
    total: central ? Number(central.total) || 0 : null,
  });
  return places;
}

/**
 * 내 위치 기준으로 거리 순 정렬 + 추천 1곳
 * @returns {{ list: Array<object & {distance: number|null}>, best: object|null }}
 */
export function rankPlaces(places, here) {
  const list = places.map((p) => ({ ...p, distance: p.pos && here ? distanceMeters(here, p.pos) : null }));
  list.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  const best = list.find((p) => p.distance != null && p.available != null && p.available > 0) ?? null;
  return { list, best };
}

/** 카카오맵 길찾기 (웹·앱 모두 열림, 키 필요 없음) */
export function kakaoDirectionsUrl(place) {
  if (!place?.pos) return null;
  const label = place.sub && place.kind === 'room' ? `${place.name} ${place.sub}` : place.name;
  return `https://map.kakao.com/link/to/${encodeURIComponent(label)},${place.pos[0]},${place.pos[1]}`;
}
