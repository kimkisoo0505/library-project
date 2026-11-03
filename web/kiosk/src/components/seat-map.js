import { createSeatCard } from './seat-card.js';

/**
 * 열람실 하나의 좌석 배치도 (30석 기준 6열 x 5행).
 * 실제 열람실 배치가 확정되면 columns 또는 좌석별 위치 정보를 반영한다.
 */
export function createSeatMap({ onSelect, columns = 6 } = {}) {
  const element = document.createElement('div');
  element.className = 'seat-map';
  element.style.setProperty('--columns', String(columns));
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', '좌석 배치도');

  let seats = [];
  let selectedId = null;
  let interactive = true;

  function render() {
    if (seats.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'seat-map-empty';
      empty.textContent = '좌석 정보를 불러오는 중입니다…';
      element.replaceChildren(empty);
      return;
    }
    element.replaceChildren(
      ...seats.map((seat) => createSeatCard(seat, { onSelect, selected: seat.id === selectedId, interactive })),
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
