/**
 * 열람실 선택 탭. 각 탭에 "남은 좌석 / 전체 좌석"을 표시한다.
 * @param {{ onSelect: (code: string) => void }} options
 */
export function createRoomTabs({ onSelect }) {
  const element = document.createElement('div');
  element.className = 'room-tabs';
  element.setAttribute('role', 'tablist');
  element.setAttribute('aria-label', '열람실 선택');

  let rooms = [];
  let selected = null;

  function render() {
    element.replaceChildren(
      ...rooms.map((room) => {
        const active = room.code === selected;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `room-tab${active ? ' is-active' : ''}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(active));

        const name = document.createElement('span');
        name.className = 'room-tab-name';
        name.textContent = room.name;

        const count = document.createElement('span');
        const full = Number(room.available) === 0;
        count.className = `room-tab-count${full ? ' is-full' : ''}`;
        count.textContent = full ? '만석' : `잔여 ${room.available}석`;

        button.append(name, count);
        button.setAttribute('aria-label', `${room.name}, 남은 좌석 ${room.available}석 / 전체 ${room.total}석`);
        button.addEventListener('click', () => onSelect(room.code));
        return button;
      }),
    );
  }

  return {
    element,
    update(nextRooms, selectedCode) {
      rooms = Array.isArray(nextRooms) ? nextRooms : [];
      selected = selectedCode;
      render();
    },
  };
}

/** 마지막으로 선택한 열람실 기억 (기기별 편의 기능, 실패해도 무방) */
export const roomPreference = {
  load(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  save(key, code) {
    try { localStorage.setItem(key, code); } catch { /* 저장 불가 환경 */ }
  },
};
