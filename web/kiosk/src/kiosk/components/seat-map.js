import { createSeatCard } from './seat-card.js';

/** 배치도의 표시 블록 (출입구 · 칠판/교탁 · 창가). 관리자 배치 편집기와 공용 */
export const FIXTURE_LABELS = Object.freeze({ door: '🚪 출입구', board: '칠판 · 교탁', window: '🪟 창가' });

export function createFixtureBlock(fixture) {
  const block = document.createElement('div');
  block.className = `fixture fixture-${fixture.type}${fixture.h > fixture.w ? ' is-tall' : ''}`;
  block.textContent = FIXTURE_LABELS[fixture.type] ?? '';
  block.style.gridRow = `${fixture.row + 1} / span ${fixture.h}`;
  block.style.gridColumn = `${fixture.col + 1} / span ${fixture.w}`;
  return block;
}

/**
 * 열람실 하나의 좌석 배치도 (30석 기준 6열 x 5행).
 * 강의실 모양(시안 기준): 앞쪽에 출입구 · 칠판/교탁 · 창가, 3석 + 가운데 통로 + 3석, 뒤쪽 표시.
 * 좌석 위치는 seat_no 로 정한다 (1번 = 앞줄 왼쪽, 한 줄에 6석). seat_no 가 없으면 받은 순서를 쓴다.
 * 서버가 열람실 배치(관리자 드래그 편집, rooms[].layout)를 보내면 그 배치대로 그리고,
 * 없으면(구버전 서버 등) 아래 고정 배치(시안)를 쓴다.
 */
export function createSeatMap({ onSelect, columns = 6, aisleAfter = 3 } = {}) {
  const element = document.createElement('div');
  element.className = 'room-frame';

  const front = document.createElement('div');
  front.className = 'room-front';
  front.setAttribute('aria-hidden', 'true');
  const door = document.createElement('span');
  door.className = 'room-door';
  door.textContent = '🚪 출입구';
  const board = document.createElement('div');
  board.className = 'room-board';
  board.textContent = '칠판 · 교탁';
  const windowSide = document.createElement('span');
  windowSide.className = 'room-window';
  windowSide.textContent = '창가 →';
  front.append(door, board, windowSide);

  const grid = document.createElement('div');
  grid.className = 'seat-map';
  grid.style.setProperty('--columns', String(columns));
  grid.style.setProperty('--left', String(aisleAfter));
  grid.style.setProperty('--right', String(columns - aisleAfter));
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', '좌석 배치도 (앞쪽이 칠판)');

  const back = document.createElement('div');
  back.className = 'room-back';
  back.setAttribute('aria-hidden', 'true');
  back.textContent = '뒤쪽';

  element.append(front, grid, back);

  let seats = [];
  let layout = null;   // 서버가 보낸 열람실 배치 (관리자 편집). 없으면 아래 고정 배치
  let selectedId = null;
  let interactive = true;

  function place(card, seat, index) {
    const n = Number.isInteger(seat.seat_no) && seat.seat_no > 0 ? seat.seat_no - 1 : index;
    const col = n % columns;
    card.style.gridRow = String(Math.floor(n / columns) + 1);
    card.style.gridColumn = String(col < aisleAfter ? col + 1 : col + 2); // 통로 칸을 건너뛴다
    return card;
  }

  /** 관리자가 저장한 배치대로 그린다. 좌석도 표시 블록도 없는 줄·칸은 좁게(통로) 보인다. */
  function renderCustom() {
    const usedRows = new Set();
    const usedCols = new Set();
    const mark = (r, c, h = 1, w = 1) => {
      for (let i = 0; i < h; i += 1) usedRows.add(r + i);
      for (let i = 0; i < w; i += 1) usedCols.add(c + i);
    };
    const seatRows = new Set(layout.seats.map((p) => p.row));
    layout.seats.forEach((p) => mark(p.row, p.col));
    layout.fixtures.forEach((f) => mark(f.row, f.col, f.h, f.w));
    grid.style.gridTemplateColumns = Array.from({ length: layout.cols }, (_, c) => (usedCols.has(c) ? 'minmax(0, 1fr)' : '14px')).join(' ');
    grid.style.gridTemplateRows = Array.from({ length: layout.rows }, (_, r) => (seatRows.has(r) ? 'minmax(46px, auto)' : usedRows.has(r) ? 'minmax(26px, auto)' : '10px')).join(' ');
    grid.classList.toggle('is-dense', usedCols.size > 8);

    const pos = new Map(layout.seats.map((p) => [p.seat_no, p]));
    const cards = seats.map((seat) => {
      const card = createSeatCard(seat, { onSelect, selected: seat.id === selectedId, interactive });
      const p = pos.get(seat.seat_no);
      if (p) {
        card.style.gridRow = String(p.row + 1);
        card.style.gridColumn = String(p.col + 1);
      }
      return card;
    });
    grid.replaceChildren(...layout.fixtures.map(createFixtureBlock), ...cards);
  }

  function render() {
    const custom = Boolean(layout) && seats.length > 0;
    element.classList.toggle('is-custom', custom);
    front.hidden = custom;
    back.hidden = custom;
    if (custom) { renderCustom(); return; }
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';
    grid.classList.remove('is-dense');
    if (seats.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'seat-map-empty';
      empty.textContent = '좌석 정보를 불러오는 중입니다…';
      grid.replaceChildren(empty);
      return;
    }
    grid.replaceChildren(
      ...seats.map((seat, i) => place(createSeatCard(seat, { onSelect, selected: seat.id === selectedId, interactive }), seat, i)),
    );
  }

  render();
  return {
    element,
    /** @param {object[]} next 좌석 목록  @param {object} [nextLayout] 열람실 배치 (rooms[].layout) */
    update(next, nextLayout = null) {
      seats = Array.isArray(next) ? next : [];
      layout = nextLayout && Array.isArray(nextLayout.seats) && Array.isArray(nextLayout.fixtures) ? nextLayout : null;
      render();
    },
    setSelected(id) { selectedId = id; render(); },
    setInteractive(value) { interactive = Boolean(value); render(); },
  };
}
