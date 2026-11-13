// 개인 사용 화면: 가까운 열람실 (거리·추천·길찾기 링크·위치 오류) 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, formatDistance, walkMinutes, buildPlaces, rankPlaces, kakaoDirectionsUrl } from '../src/personal/nearby.js';
import { getCurrentPosition, GEO_ERRORS } from '../src/personal/geo.js';
import { CENTRAL_LIBRARY, locationPosition, findBuilding } from '../src/common/campus-buildings.js';

const L5 = findBuilding('L5').pos;      // 5강의동 덕문관
const L9 = findBuilding('L9').pos;      // 9강의동 호연관
const ENG2 = findBuilding('eng2').pos;  // 제2공학관

test('직선거리: 같은 점 0m, 캠퍼스 안 건물 사이는 수백 m', () => {
  assert.equal(Math.round(distanceMeters(L5, L5)), 0);
  const d = distanceMeters(L5, CENTRAL_LIBRARY.pos);
  assert.ok(d > 50 && d < 500, String(d));
  assert.ok(Math.abs(distanceMeters(L5, L9) - distanceMeters(L9, L5)) < 1e-6, '대칭');
  // 위도 0.001도 ≈ 111m
  assert.ok(Math.abs(distanceMeters([37.3, 127.0], [37.301, 127.0]) - 111.2) < 1);
});

test('거리·도보 시간 표시', () => {
  assert.equal(formatDistance(3), '약 10m');
  assert.equal(formatDistance(124), '약 120m');
  assert.equal(formatDistance(1530), '약 1.5km');
  assert.equal(formatDistance(NaN), '');
  assert.equal(walkMinutes(10), 1);
  assert.equal(walkMinutes(700), 10);
});

test('장소 목록: 열람실 위치 글자 → 좌표, 중앙도서관 포함', () => {
  const places = buildPlaces([
    { code: 'A', name: '열람실 A', location: '제 5강의동 5102호', available: 10, total: 30 },
    { code: 'B', name: '열람실 B', location: '', available: 30, total: 30 },
    { code: 'C', name: '열람실 C', location: '00관 000호', available: 5, total: 30 },
  ], { available: 400, total: 421 });
  assert.deepEqual(places.map((p) => p.id), ['A', 'B', 'C', 'central']);
  assert.deepEqual(places[0].pos, L5);
  assert.equal(places[1].pos, null, '위치 미입력');
  assert.equal(places[2].pos, null, '목록 형식이 아닌 위치');
  assert.deepEqual(places[3].pos, CENTRAL_LIBRARY.pos);
  assert.equal(places[3].available, 400);
  assert.equal(buildPlaces([], null)[0].available, null, '중앙도서관 정보 없음');
  assert.deepEqual(locationPosition('제2공학관 1201호'), ENG2);
});

test('추천: 빈자리 있는 곳 중 가장 가까운 곳 (만석·위치 모름·정보 없음 제외)', () => {
  const rooms = [
    { code: 'A', name: '열람실 A', location: '5강의동 5102호', available: 0, total: 30 },   // 가장 가깝지만 만석
    { code: 'B', name: '열람실 B', location: '제2공학관 1201호', available: 7, total: 30 },
    { code: 'C', name: '열람실 C', location: '', available: 30, total: 30 },               // 위치 모름
  ];
  const here = L5;
  const { list, best } = rankPlaces(buildPlaces(rooms, { available: 3, total: 421 }), here);
  assert.equal(list[0].id, 'A', '거리 순 정렬: 바로 앞 A가 첫째');
  assert.equal(list.at(-1).id, 'C', '위치 모르는 곳은 맨 뒤');
  assert.equal(best.id, 'central', '만석 A 를 건너뛰고, B(제2공학관)보다 가까운 중앙도서관');
  const noCentral = rankPlaces(buildPlaces(rooms, null), here);
  assert.equal(noCentral.best.id, 'B', '중앙도서관 정보가 없으면 B');
  const allFull = rankPlaces(buildPlaces(rooms.map((r) => ({ ...r, available: 0 })), { available: 0, total: 1 }), here);
  assert.equal(allFull.best, null);
});

test('카카오맵 길찾기 링크 (키 필요 없음)', () => {
  const [p] = buildPlaces([{ code: 'A', name: '열람실 A', location: '5강의동 5102호', available: 1, total: 30 }], null);
  const url = kakaoDirectionsUrl(p);
  assert.ok(url.startsWith('https://map.kakao.com/link/to/'));
  assert.ok(url.includes(encodeURIComponent('열람실 A 5강의동 5102호')));
  assert.ok(url.endsWith(`,${L5[0]},${L5[1]}`));
  assert.equal(kakaoDirectionsUrl({ name: 'x', pos: null }), null);
});

test('현재 위치: 성공 · 권한 거부 · 시간 초과 · https 아님 · 지원 안 함', async () => {
  const geo = (fn) => ({ getCurrentPosition: fn });
  const ok = await getCurrentPosition({ secure: true, geolocation: geo((s) => s({ coords: { latitude: 37.3, longitude: 127.03, accuracy: 12 } })) });
  assert.deepEqual(ok, { pos: [37.3, 127.03], accuracy: 12 });
  const fails = [
    [{ secure: true, geolocation: geo((_s, e) => e({ code: 1 })) }, 'denied'],
    [{ secure: true, geolocation: geo((_s, e) => e({ code: 3 })) }, 'timeout'],
    [{ secure: true, geolocation: geo((_s, e) => e({ code: 2 })) }, 'unavailable'],
    [{ secure: false, geolocation: geo(() => {}) }, 'insecure'],
    [{ secure: true, geolocation: undefined }, 'unsupported'],
  ];
  for (const [opts, code] of fails) {
    await assert.rejects(getCurrentPosition(opts), (e) => e.code === code && e.message === GEO_ERRORS[code], code);
  }
});
