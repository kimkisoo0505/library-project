// 좌석 배치(드래그 편집) 검증 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, parseLayout, resolveLayout, GRID_MAX, FIXTURES_MAX } from '../workers/layout.js';

const NOS = Array.from({ length: 30 }, (_, i) => i + 1);
const clone = (v) => JSON.parse(JSON.stringify(v));
const rejects = (layout, code = 'invalid_layout') =>
  assert.throws(() => parseLayout(layout, NOS), (e) => e.code === code);

test('기본 배치: 30석, 3석+통로+3석, 겹침 없음, 검증 통과', () => {
  const d = defaultLayout(NOS);
  assert.equal(d.rows, 6);
  assert.equal(d.cols, 8);
  assert.equal(d.seats.length, 30);
  assert.deepEqual(d.seats.slice(0, 7).map((s) => [s.row, s.col]), [[1, 0], [1, 1], [1, 2], [1, 4], [1, 5], [1, 6], [2, 0]]);
  assert.deepEqual(parseLayout(d, NOS), d);
});

test('좌석 이동·교환 결과는 통과하고, 좌석 번호순으로 정리된다', () => {
  const d = clone(defaultLayout(NOS));
  [d.seats[0].row, d.seats[0].col, d.seats[1].row, d.seats[1].col] = [d.seats[1].row, d.seats[1].col, d.seats[0].row, d.seats[0].col];
  d.seats.reverse();
  const out = parseLayout(d, NOS);
  assert.deepEqual(out.seats[0], { seat_no: 1, row: 1, col: 1 });
  assert.deepEqual(out.seats[1], { seat_no: 2, row: 1, col: 0 });
});

test('겹침 거부: 좌석끼리, 좌석과 표시 블록', () => {
  const a = clone(defaultLayout(NOS));
  a.seats[1].col = a.seats[0].col;
  rejects(a, 'layout_overlap');
  const b = clone(defaultLayout(NOS));
  b.fixtures[0] = { type: 'door', row: 1, col: 0, w: 1, h: 1 };
  rejects(b, 'layout_overlap');
});

test('좌석 누락·중복·없는 번호 거부', () => {
  const missing = clone(defaultLayout(NOS));
  missing.seats.pop();
  rejects(missing);
  const dup = clone(defaultLayout(NOS));
  dup.seats[29] = { ...dup.seats[29], seat_no: 1 };
  rejects(dup);
  const unknown = clone(defaultLayout(NOS));
  unknown.seats[29].seat_no = 31;
  rejects(unknown);
});

test('범위 밖 · 크기 거부', () => {
  for (const patch of [{ rows: 2 }, { cols: GRID_MAX + 1 }, { rows: 1.5 }, { cols: '8' }]) {
    rejects({ ...clone(defaultLayout(NOS)), ...patch });
  }
  const out = clone(defaultLayout(NOS));
  out.seats[0].col = 8;
  rejects(out);
  const wide = clone(defaultLayout(NOS));
  wide.fixtures[1].w = 8; // col 1 + 8 > 8칸
  rejects(wide);
});

test('표시 블록 종류·개수 제한', () => {
  const bad = clone(defaultLayout(NOS));
  bad.fixtures[0].type = 'stage';
  rejects(bad);
  const many = { rows: 15, cols: 15, seats: NOS.map((n) => ({ seat_no: n, row: Math.floor((n - 1) / 15), col: (n - 1) % 15 })), fixtures: [] };
  for (let i = 0; i <= FIXTURES_MAX; i += 1) many.fixtures.push({ type: 'door', row: 3 + Math.floor(i / 15), col: i % 15, w: 1, h: 1 });
  rejects(many);
  many.fixtures.pop();
  assert.equal(parseLayout(many, NOS).fixtures.length, FIXTURES_MAX);
});

test('형식이 아닌 값 거부', () => {
  for (const v of [null, undefined, 'x', [], { rows: 6, cols: 8 }]) rejects(v);
});

test('resolveLayout: 저장값 없음/깨짐 → 기본 배치, 정상 저장값 → 그대로', () => {
  assert.equal(resolveLayout(null, NOS).custom, false);
  assert.equal(resolveLayout('{not json', NOS).custom, false);
  const d = clone(defaultLayout(NOS));
  d.seats[0].row = 0; d.seats[0].col = 7; // 앞줄 오른쪽 빈칸으로
  const r = resolveLayout(JSON.stringify(d), NOS);
  assert.equal(r.custom, true);
  assert.deepEqual(r.seats[0], { seat_no: 1, row: 0, col: 7 });
  assert.equal(resolveLayout(JSON.stringify(d), NOS.slice(0, 29)).custom, false, '좌석 구성이 바뀌면 기본 배치');
});
