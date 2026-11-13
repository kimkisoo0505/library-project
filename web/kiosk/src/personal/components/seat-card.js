export const STATE_LABELS = {
  available: '이용 가능',
  reserved: '예약됨',
  occupied: '사용 중',
  maintenance: '점검 중',
  unknown: '확인 중',
};

/**
 * 좌석 카드 버튼.
 * @param {{id:number,label:string,state:string,mine?:boolean}} seat
 */
export function createSeatCard(seat, { onSelect, selected = false, interactive = true } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  const state = STATE_LABELS[seat.state] ? seat.state : 'unknown';
  button.className = ['seat-card', `seat-${state}`, seat.mine ? 'seat-mine' : '', selected ? 'is-selected' : '']
    .filter(Boolean)
    .join(' ');
  button.dataset.seatId = String(seat.id);

  const label = document.createElement('span');
  label.className = 'seat-label';
  label.textContent = seat.label;

  const status = document.createElement('span');
  status.className = 'seat-status';
  status.textContent = seat.mine ? '내 좌석' : STATE_LABELS[state];

  button.append(label, status);
  button.setAttribute('aria-label', `${seat.label} ${status.textContent}`);
  button.setAttribute('aria-pressed', String(selected));
  button.disabled = !interactive;
  if (onSelect) button.addEventListener('click', () => onSelect(seat));
  return button;
}
