import { createSeatCard } from './seat-card.js';

/**
 * 열람실 하나의 좌석 배치도 (30석 기준 6열 x 5행).
 * 강의실 모양(시안 기준): 앞쪽에 출입구 · 칠판/교탁 · 창가, 3석 + 가운데 통로 + 3석, 뒤쪽 표시.
 * 좌석 위치는 seat_no 로 정한다 (1번 = 앞줄 왼쪽, 한 줄에 6석). seat_no 가 없으면 받은 순서를 쓴다.
 * 출입구·창가 위치는 시안의 임시 배치이며, 실제 열람실 구조가 확정되면 여기만 바꾼다.
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
  let selectedId = null;
  let interactive = true;

  function place(card, seat, index) {
    const n = Number.isInteger(seat.seat_no) && seat.seat_no > 0 ? seat.seat_no - 1 : index;
    const col = n % columns;
    card.style.gridRow = String(Math.floor(n / columns) + 1);
    card.style.gridColumn = String(col < aisleAfter ? col + 1 : col + 2); // 통로 칸을 건너뛴다
    return card;
  }

  function render() {
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
    update(next) { seats = Array.isArray(next) ? next : []; render(); },
    setSelected(id) { selectedId = id; render(); },
    setInteractive(value) { interactive = Boolean(value); render(); },
  };
}
