/**
 * 관리자: 강의실 위치 선택 (건물 목록 + 호실 숫자 키패드)
 *
 * - 건물: 목록에서 고른다 (강의동 1~9 · 그 밖의 건물).
 * - 호실: 칸을 누르면 화면 위 숫자 키패드(0~9, ⌫, 확인)가 뜬다. PC 키보드로 숫자를 쳐도 된다.
 *   휴대폰·태블릿 기본 자판은 띄우지 않는다 (inputmode="none") — 화면 키패드만 쓴다.
 * - 결과는 한 줄 글자("5강의동 4405호")로 만들어 서버에 저장한다 (location-format.js).
 */
import {
  BUILDINGS, ROOM_MAX_DIGITS, buildingLabel, formatLocation, parseLocation,
} from '../location-format.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {{ idPrefix?: string, onChange?: () => void }} options
 */
export function createLocationPicker({ idPrefix = 'room-location', onChange } = {}) {
  const element = el('div', 'location-picker');

  // ----- 건물 -----
  const buildingField = el('div', 'lp-field');
  const buildingLabelEl = el('label', 'lp-label', '건물');
  const select = el('select', 'lp-select');
  select.id = `${idPrefix}-building`;
  buildingLabelEl.htmlFor = select.id;
  const placeholder = el('option', null, '건물 선택');
  placeholder.value = '';
  select.append(placeholder);
  const groups = new Map();
  for (const b of BUILDINGS) {
    if (!groups.has(b.group)) {
      const g = el('optgroup');
      g.label = b.group;
      groups.set(b.group, g);
      select.append(g);
    }
    const o = el('option', null, buildingLabel(b));
    o.value = b.id;
    groups.get(b.group).append(o);
  }
  buildingField.append(buildingLabelEl, select);

  // ----- 호실 -----
  const roomField = el('div', 'lp-field');
  const roomLabelEl = el('label', 'lp-label', '호실');
  const roomInput = el('input', 'lp-room');
  roomInput.id = `${idPrefix}-room`;
  roomLabelEl.htmlFor = roomInput.id;
  roomInput.type = 'text';
  roomInput.inputMode = 'none';          // 기기 자판 대신 화면 키패드
  roomInput.autocomplete = 'off';
  roomInput.maxLength = ROOM_MAX_DIGITS;
  roomInput.placeholder = '예: 4405';
  roomInput.setAttribute('aria-describedby', `${idPrefix}-keypad-hint`);
  const roomUnit = el('span', 'lp-unit', '호');
  const roomWrap = el('div', 'lp-room-wrap');
  roomWrap.append(roomInput, roomUnit);
  roomField.append(roomLabelEl, roomWrap);

  // ----- 숫자 키패드 -----
  const keypad = el('div', 'lp-keypad');
  keypad.hidden = true;
  keypad.setAttribute('role', 'group');
  keypad.setAttribute('aria-label', '호실 숫자 키패드');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'done'];
  for (const k of keys) {
    const label = k === 'back' ? '⌫' : k === 'done' ? '확인' : k;
    const b = el('button', `lp-key${k === 'done' ? ' is-done' : k === 'back' ? ' is-back' : ''}`, label);
    b.type = 'button';
    if (k === 'back') b.setAttribute('aria-label', '한 글자 지우기');
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // 칸의 포커스 유지
    b.addEventListener('click', () => press(k));
    keypad.append(b);
  }
  const keypadHint = el('p', 'lp-hint', `숫자만 ${ROOM_MAX_DIGITS}자리까지 입력할 수 있어요.`);
  keypadHint.id = `${idPrefix}-keypad-hint`;

  const preview = el('p', 'lp-preview');
  const legacy = el('p', 'lp-legacy');
  legacy.hidden = true;

  const row = el('div', 'lp-row');
  row.append(buildingField, roomField);
  element.append(row, keypad, keypadHint, preview, legacy);

  let dirty = false;

  function changed() {
    dirty = true;
    renderPreview();
    onChange?.();
  }

  function setRoom(next) {
    const digits = String(next).replace(/\D/g, '').slice(0, ROOM_MAX_DIGITS);
    if (digits !== roomInput.value) {
      roomInput.value = digits;
      changed();
    }
  }

  function press(k) {
    if (k === 'back') setRoom(roomInput.value.slice(0, -1));
    else if (k === 'done') { keypad.hidden = true; roomInput.blur(); }
    else setRoom(roomInput.value + k);
  }

  function renderPreview() {
    const value = formatLocation(select.value, roomInput.value);
    preview.textContent = value ? `학생 화면 표시: ${value}` : '건물과 호실을 모두 고르면 학생 화면에 표시됩니다.';
    preview.classList.toggle('is-ready', Boolean(value));
  }

  select.addEventListener('change', changed);
  roomInput.addEventListener('focus', () => { keypad.hidden = false; });
  roomInput.addEventListener('click', () => { keypad.hidden = false; });
  roomInput.addEventListener('input', () => setRoom(roomInput.value)); // 붙여넣기 등: 숫자만 남김
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { keypad.hidden = true; if (e.key === 'Escape') { e.preventDefault(); roomInput.blur(); } }
  });
  roomInput.addEventListener('beforeinput', (e) => {
    if (e.data && /\D/.test(e.data)) e.preventDefault(); // 숫자가 아닌 글자는 받지 않음
  });
  roomInput.addEventListener('blur', () => { keypad.hidden = true; });

  renderPreview();

  return {
    element,
    /** 저장된 값으로 채운다 (형식이 맞지 않으면 비우고 안내) */
    setValue(text) {
      const parsed = parseLocation(text ?? '');
      select.value = parsed?.buildingId ?? '';
      roomInput.value = parsed?.room ?? '';
      const raw = String(text ?? '').trim();
      legacy.hidden = Boolean(parsed) || !raw;
      legacy.textContent = raw && !parsed ? `지금 저장된 값 "${raw}" 은(는) 목록 형식이 아니에요. 건물과 호실을 다시 골라 저장하세요.` : '';
      dirty = false;
      keypad.hidden = true;
      renderPreview();
    },
    /** 저장할 글자. 건물·호실이 다 골라지지 않았으면 null */
    getValue() { return formatLocation(select.value, roomInput.value); },
    isDirty: () => dirty,
    markSaved() { dirty = false; },
    setDisabled(disabled) { select.disabled = disabled; roomInput.disabled = disabled; },
  };
}
