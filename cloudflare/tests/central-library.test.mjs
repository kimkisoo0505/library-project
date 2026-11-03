// 중앙/금화도서관 연동 단위 테스트 (가짜 응답 사용, 실제 학교 서버 호출 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMPUSES, fetchAllCampuses, ingestDevicePayload, normalizeCampus, toHours } from '../workers/central-library.js';

const SAMPLE = [
  { code: 8, name: '제1열람실', cnt: 200, available: 37, inUse: 150, fix: 10, unavailable: 2, disabled: 1, startTm: '0600', endTm: '2300' },
  { code: 9, name: '노트북열람실', cnt: 80, available: 0, inUse: 80, fix: 0, unavailable: 0, disabled: 0, startTm: '0900', endTm: '2200' },
];

test('toHours: HHMM -> HH:MM~HH:MM, 형식 오류는 null', () => {
  assert.equal(toHours('0600', '2300'), '06:00~23:00');
  assert.equal(toHours('6', '2300'), null);
  assert.equal(toHours(undefined, null), null);
});

test('normalizeCampus: 필드 변환과 합계', () => {
  const result = normalizeCampus(CAMPUSES[0], SAMPLE);
  assert.equal(result.library, '중앙도서관');
  assert.equal(result.total, 280);
  assert.equal(result.available, 37);
  assert.deepEqual(result.rooms[0], {
    code: 8, name: '제1열람실', total: 200, available: 37, in_use: 150, fixed: 10, unavailable: 3, hours: '06:00~23:00',
  });
});

test('normalizeCampus: 외부 입력 방어 (음수/문자/과대값/제어문자/긴 이름)', () => {
  const result = normalizeCampus(CAMPUSES[1], [
    { code: 'x', name: `<script>\u0007${'가'.repeat(100)}`, cnt: 10, available: 999, inUse: -5, fix: 'a', startTm: '9999x' },
    null,
  ]);
  const [room, empty] = result.rooms;
  assert.equal(room.code, 0);
  assert.equal(room.available, 10, '공석은 전체 좌석을 넘지 않음');
  assert.equal(room.in_use, 0);
  assert.equal(room.fixed, 0);
  assert.equal(room.hours, null);
  assert.ok(room.name.length <= 60 && !room.name.includes('\u0007'));
  assert.equal(empty.name, '이름 없음');
  assert.throws(() => normalizeCampus(CAMPUSES[0], { not: 'array' }));
  assert.equal(normalizeCampus(CAMPUSES[0], new Array(80).fill(SAMPLE[0])).rooms.length, 50);
});

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, ua: init?.headers?.['User-Agent'] });
    const campusId = Number(url.split('/').pop());
    const handler = handlers[campusId];
    if (handler instanceof Error) throw handler;
    return { ok: handler.status === 200, status: handler.status, json: async () => handler.body };
  };
  return { impl, calls };
}

test('fetchAllCampuses: 두 캠퍼스 모두 성공', async () => {
  const { impl, calls } = fakeFetch({
    1: { status: 200, body: { code: 1, data: SAMPLE } },
    2: { status: 200, body: { code: 1, data: [SAMPLE[1]] } },
  });
  const { campuses, errors } = await fetchAllCampuses(null, impl);
  assert.deepEqual(errors, []);
  assert.deepEqual(campuses.map((c) => c.library), ['중앙도서관', '금화도서관']);
  assert.ok(campuses.every((c) => c.fetched_at));
  assert.deepEqual(calls.map((c) => c.url), [
    'https://libgate.kyonggi.ac.kr/libraries/lib-status/1',
    'https://libgate.kyonggi.ac.kr/libraries/lib-status/2',
  ]);
  assert.match(calls[0].ua, /^KGU-Reserve-Library\//, '서비스 이름을 밝히는 User-Agent');
});

test('fetchAllCampuses: 한 캠퍼스 실패 시 그 캠퍼스는 이전 결과 유지', async () => {
  const previous = { campuses: [{ id: 2, library: '금화도서관', total: 1, available: 1, rooms: [], fetched_at: '2026-01-01T00:00:00.000Z' }] };
  const { impl } = fakeFetch({
    1: { status: 200, body: { code: 1, data: SAMPLE } },
    2: new Error('tls_failed'),
  });
  const { campuses, errors } = await fetchAllCampuses(previous, impl);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /금화도서관: tls_failed/);
  assert.equal(campuses.find((c) => c.id === 2).fetched_at, '2026-01-01T00:00:00.000Z');
});

test('fetchAllCampuses: HTTP 오류 / API 오류 코드 처리', async () => {
  const { impl } = fakeFetch({
    1: { status: 503, body: null },
    2: { status: 200, body: { code: -1, message: 'error' } },
  });
  const { campuses, errors } = await fetchAllCampuses(null, impl);
  assert.equal(campuses.length, 0);
  assert.deepEqual(errors, ['중앙도서관: http_503', '금화도서관: api_error']);
});

test('ingestDevicePayload: 라즈베리파이 원본을 정규화하고 장치 오류를 기록', () => {
  const { campuses, errors, received } = ingestDevicePayload(
    { campuses: [{ id: 1, data: SAMPLE }, { id: 2, data: [SAMPLE[1]] }], errors: [] },
    null,
  );
  assert.equal(received, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(campuses.map((c) => [c.library, c.available, c.total]), [['중앙도서관', 37, 280], ['금화도서관', 0, 80]]);
});

test('ingestDevicePayload: 장치 입력도 신뢰하지 않음 (모르는 캠퍼스/중복/형식 오류/긴 오류문)', () => {
  const previous = { campuses: [{ id: 2, library: '금화도서관', total: 5, available: 5, rooms: [], fetched_at: 'old' }] };
  const { campuses, errors, received } = ingestDevicePayload(
    {
      campuses: [{ id: 99, data: SAMPLE }, { id: 1, data: 'not-array' }, { id: 1, data: SAMPLE }],
      errors: ['금화도서관: ' + 'x'.repeat(500), 1, 2, 3, 4, 5, 6],
    },
    previous,
  );
  assert.equal(received, 0, '첫 id=1 항목이 형식 오류면 같은 id 의 뒤 항목은 무시 (중복 차단)');
  assert.ok(errors.includes('중앙도서관: invalid_payload'));
  assert.ok(errors.every((e) => e.length <= 120));
  assert.ok(errors.length <= 6);
  assert.deepEqual(campuses.map((c) => [c.id, c.fetched_at]), [[2, 'old']], '실패한 캠퍼스는 이전 결과 유지');
});

test('ingestDevicePayload: 빈/잘못된 본문', () => {
  assert.deepEqual(ingestDevicePayload({}, null), { campuses: [], errors: [], received: 0 });
  assert.deepEqual(ingestDevicePayload({ campuses: 'x', errors: 'y' }, null), { campuses: [], errors: [], received: 0 });
});
