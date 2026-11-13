/**
 * 관리자: 열람실 좌석 배치 편집기 (드래그 앤 드롭)
 *
 * - 보기 모드: 학생 화면과 같은 배치도 미리보기 + [배치 편집]
 * - 편집 모드: 좌석·표시 블록(출입구/칠판·교탁/창가)을 끌어다 놓는다. 마우스·터치 모두 (Pointer Events)
 *     · 좌석을 빈칸에 놓으면 이동, 다른 좌석 위에 놓으면 서로 자리 바꿈
 *     · 표시 블록은 빈칸에만 놓을 수 있고, 선택 후 가로/세로 크기 조절·삭제
 *     · 키보드: 항목 선택 후 방향키로 한 칸씩 이동, Delete 로 표시 블록 삭제
 *     · 줄·칸 수 조절, 표시 블록 추가, [기본 배치로], [취소], [저장]
 * - 저장 전까지는 화면 안에서만 바뀐다. 최종 검증은 서버가 한다 (겹침·범위·좌석 누락).
 */
import { createSeatMap, createFixtureBlock, FIXTURE_LABELS } from './seat-map.js';

const GRID_MIN = 3;
const GRID_MAX = 15;
const FIXTURES_MAX = 12;
const CELL = 44;   // px (CSS .le-grid 와 같게)
const GAP = 4;     // px
const DRAG_THRESHOLD = 5;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * @param {{
 *   onSave: (roomCode: string, body: {version:number, layout:object}) => Promise<boolean>,
 *   onMessage: (text: string, kind?: string) => void,
 *   onDragEnd?: () => void,
 * }} options
 */
export function createLayoutEditor({ onSave, onMessage, onDragEnd }) {
  const element = el('section', 'layout-editor');
  element.setAttribute('aria-label', '좌석 배치 편집');

  let room = null;          // 서버의 열람실 요약 (layout, default_layout, layout_version 포함)
  let seats = [];           // 이 열람실 좌석 (label, state 표시용)
  let editing = false;
  let saving = false;
  let draft = null;         // { version, rows, cols, seats:[{seat_no,row,col}], fixtures:[{id,type,row,col,w,h}] }
  let original = '';        // 변경 여부 비교용
  let selected = null;      // 'seat:<no>' | 'fix:<id>'
  let drag = null;
  let nextFixtureId = 1;

  const preview = createSeatMap({});
  preview.setInteractive(false);

  // ----- 배치 데이터 다루기 -----
  function startDraft(layout, version) {
    nextFixtureId = 1;
    return {
      version,
      rows: layout.rows,
      cols: layout.cols,
      seats: layout.seats.map((s) => ({ seat_no: s.seat_no, row: s.row, col: s.col })),
      fixtures: layout.fixtures.map((f) => ({ id: nextFixtureId++, type: f.type, row: f.row, col: f.col, w: f.w, h: f.h })),
    };
  }

  const toApi = (d) => ({
    rows: d.rows,
    cols: d.cols,
    seats: d.seats.map(({ seat_no, row, col }) => ({ seat_no, row, col })),
    fixtures: d.fixtures.map(({ type, row, col, w, h }) => ({ type, row, col, w, h })),
  });
  const snapshot = (d) => JSON.stringify(toApi(d));

  function itemOf(key) {
    const [kind, id] = key.split(':');
    if (kind === 'seat') {
      const s = draft.seats.find((x) => x.seat_no === Number(id));
      return s ? { kind, ref: s, row: s.row, col: s.col, w: 1, h: 1 } : null;
    }
    const f = draft.fixtures.find((x) => x.id === Number(id));
    return f ? { kind, ref: f, row: f.row, col: f.col, w: f.w, h: f.h } : null;
  }

  /** "r,c" -> key (except 제외할 항목) */
  function occupancy(exceptKey = null) {
    const map = new Map();
    for (const s of draft.seats) {
      const key = `seat:${s.seat_no}`;
      if (key !== exceptKey) map.set(`${s.row},${s.col}`, key);
    }
    for (const f of draft.fixtures) {
      const key = `fix:${f.id}`;
      if (key === exceptKey) continue;
      for (let r = f.row; r < f.row + f.h; r += 1) for (let c = f.col; c < f.col + f.w; c += 1) map.set(`${r},${c}`, key);
    }
    return map;
  }

  /** 이동 가능 여부: { ok, swapWith?, reason? } */
  function checkMove(key, row, col) {
    const item = itemOf(key);
    if (!item) return { ok: false };
    if (row < 0 || col < 0 || row + item.h > draft.rows || col + item.w > draft.cols) return { ok: false, reason: '배치판 밖으로는 옮길 수 없습니다.' };
    const occ = occupancy(key);
    if (item.kind === 'seat') {
      const other = occ.get(`${row},${col}`);
      if (!other) return { ok: true };
      if (other.startsWith('seat:')) return { ok: true, swapWith: other };
      return { ok: false, reason: '출입구·칠판·창가 위에는 좌석을 놓을 수 없습니다.' };
    }
    for (let r = row; r < row + item.h; r += 1) {
      for (let c = col; c < col + item.w; c += 1) {
        if (occ.has(`${r},${c}`)) return { ok: false, reason: '표시 블록은 빈칸에만 놓을 수 있습니다.' };
      }
    }
    return { ok: true };
  }

  function applyMove(key, row, col) {
    const check = checkMove(key, row, col);
    if (!check.ok) {
      if (check.reason) onMessage(check.reason, 'error');
      return false;
    }
    const item = itemOf(key);
    if (check.swapWith) {
      const other = itemOf(check.swapWith).ref;
      other.row = item.row;
      other.col = item.col;
    }
    item.ref.row = row;
    item.ref.col = col;
    return true;
  }

  function resizeSelected(dw, dh) {
    const item = selected && itemOf(selected);
    if (!item || item.kind !== 'fix') return;
    const w = item.w + dw;
    const h = item.h + dh;
    if (w < 1 || h < 1) return;
    if (item.col + w > draft.cols || item.row + h > draft.rows) { onMessage('배치판 밖으로 넓힐 수 없습니다. 줄·칸을 먼저 늘리세요.', 'error'); return; }
    const occ = occupancy(selected);
    for (let r = item.row; r < item.row + h; r += 1) {
      for (let c = item.col; c < item.col + w; c += 1) {
        if (occ.has(`${r},${c}`)) { onMessage('넓히려는 칸에 다른 항목이 있습니다.', 'error'); return; }
      }
    }
    item.ref.w = w;
    item.ref.h = h;
    render();
  }

  function addFixture(type) {
    if (draft.fixtures.length >= FIXTURES_MAX) { onMessage(`표시 블록은 ${FIXTURES_MAX}개까지 놓을 수 있습니다.`, 'error'); return; }
    const occ = occupancy();
    for (let r = 0; r < draft.rows; r += 1) {
      for (let c = 0; c < draft.cols; c += 1) {
        if (!occ.has(`${r},${c}`)) {
          const f = { id: nextFixtureId++, type, row: r, col: c, w: 1, h: 1 };
          draft.fixtures.push(f);
          selected = `fix:${f.id}`;
          render();
          onMessage(`${FIXTURE_LABELS[type]} 블록을 빈칸에 추가했습니다. 원하는 곳으로 끌어다 놓으세요.`);
          return;
        }
      }
    }
    onMessage('빈칸이 없습니다. 줄·칸을 먼저 늘리세요.', 'error');
  }

  function removeSelected() {
    if (!selected?.startsWith('fix:')) return;
    draft.fixtures = draft.fixtures.filter((f) => `fix:${f.id}` !== selected);
    selected = null;
    render();
  }

  function resizeGrid(dRows, dCols) {
    const rows = draft.rows + dRows;
    const cols = draft.cols + dCols;
    if (rows < GRID_MIN || cols < GRID_MIN || rows > GRID_MAX || cols > GRID_MAX) {
      onMessage(`줄·칸 수는 ${GRID_MIN}~${GRID_MAX} 사이여야 합니다.`, 'error');
      return;
    }
    if (rows * cols < draft.seats.length) { onMessage('좌석이 모두 들어갈 칸이 부족합니다.', 'error'); return; }
    const occ = occupancy();
    for (const key of occ.keys()) {
      const [r, c] = key.split(',').map(Number);
      if (r >= rows || c >= cols) {
        onMessage(dRows ? '마지막 줄에 좌석이나 표시 블록이 있어 줄일 수 없습니다. 먼저 옮기세요.' : '마지막 칸에 좌석이나 표시 블록이 있어 줄일 수 없습니다. 먼저 옮기세요.', 'error');
        return;
      }
    }
    draft.rows = rows;
    draft.cols = cols;
    render();
  }

  // ----- 모드 전환 -----
  function beginEdit() {
    if (!room?.layout) return;
    draft = startDraft(room.layout, room.layout_version ?? 0);
    original = snapshot(draft);
    selected = null;
    editing = true;
    render();
  }

  function cancelEdit(askFirst = true) {
    if (askFirst && hasChanges() && !window.confirm('저장하지 않은 배치 변경을 버릴까요?')) return false;
    editing = false;
    draft = null;
    selected = null;
    drag = null;
    render();
    return true;
  }

  function loadDefault() {
    if (!room?.default_layout) return;
    if (!window.confirm('기본 배치(3석 + 통로 + 3석)를 불러올까요? [저장]을 눌러야 학생 화면에 반영됩니다.')) return;
    const version = draft.version;
    draft = startDraft(room.default_layout, version);
    selected = null;
    render();
  }

  async function save() {
    if (saving || !draft) return;
    saving = true;
    render();
    let ok = false;
    try {
      ok = await onSave(room.code, { version: draft.version, layout: toApi(draft) });
    } finally {
      saving = false;
    }
    if (ok) { editing = false; draft = null; selected = null; }
    render();
  }

  function hasChanges() {
    return Boolean(editing && draft && snapshot(draft) !== original);
  }

  // ----- 드래그 (Pointer Events: 마우스·터치·펜 공통) -----
  function cellFromPoint(grid, x, y) {
    const rect = grid.getBoundingClientRect();
    return {
      row: Math.floor((y - rect.top) / (CELL + GAP)),
      col: Math.floor((x - rect.left) / (CELL + GAP)),
    };
  }

  function bindDrag(node, key, grid, target) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || saving) return;
      const item = itemOf(key);
      const start = cellFromPoint(grid, e.clientX, e.clientY);
      drag = {
        key, node, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false,
        grabRow: Math.max(0, start.row - item.row), grabCol: Math.max(0, start.col - item.col),
        to: null,
      };
      node.setPointerCapture(e.pointerId);
      if (selected !== key) {
        selected = key;
        for (const n of grid.querySelectorAll('.le-item.is-selected')) n.classList.remove('is-selected');
        node.classList.add('is-selected');
        renderTools();
      }
      e.preventDefault();
    });
    node.addEventListener('pointermove', (e) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      node.classList.add('is-dragging');
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      const at = cellFromPoint(grid, e.clientX, e.clientY);
      const row = at.row - drag.grabRow;
      const col = at.col - drag.grabCol;
      const item = itemOf(key);
      const check = checkMove(key, row, col);
      drag.to = { row, col };
      target.hidden = false;
      target.className = `le-target ${check.ok ? (check.swapWith ? 'is-swap' : 'is-ok') : 'is-bad'}`;
      target.style.gridRow = `${Math.min(Math.max(row, 0), draft.rows - 1) + 1} / span ${item.h}`;
      target.style.gridColumn = `${Math.min(Math.max(col, 0), draft.cols - 1) + 1} / span ${item.w}`;
    });
    const finish = (e, commit) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      const { moved, to } = drag;
      drag = null;
      node.style.transform = '';
      node.classList.remove('is-dragging');
      target.hidden = true;
      if (commit && moved && to) applyMove(key, to.row, to.col);
      render();
      onDragEnd?.();
    };
    node.addEventListener('pointerup', (e) => finish(e, true));
    node.addEventListener('pointercancel', (e) => finish(e, false));
    node.addEventListener('keydown', (e) => {
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[e.key]) {
        e.preventDefault();
        const item = itemOf(key);
        selected = key;
        if (applyMove(key, item.row + moves[e.key][0], item.col + moves[e.key][1])) render();
        element.querySelector(`[data-key="${key}"]`)?.focus();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && key.startsWith('fix:')) {
        e.preventDefault();
        selected = key;
        removeSelected();
      }
    });
  }

  // ----- 그리기 -----
  const head = el('div', 'le-head');
  const body = el('div', 'le-body');
  const tools = el('div', 'le-tools');
  element.append(head, body);

  function button(text, className, onClick, disabled = false) {
    const b = el('button', `btn ${className}`, text);
    b.type = 'button';
    b.disabled = disabled || saving;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderTools() {
    tools.replaceChildren();
    if (!editing) return;
    const item = selected && itemOf(selected);

    const size = el('div', 'le-row');
    size.append(
      el('span', 'le-label', `줄 ${draft.rows}`), button('−', 'btn-ghost le-sq', () => resizeGrid(-1, 0)), button('+', 'btn-ghost le-sq', () => resizeGrid(1, 0)),
      el('span', 'le-label', `칸 ${draft.cols}`), button('−', 'btn-ghost le-sq', () => resizeGrid(0, -1)), button('+', 'btn-ghost le-sq', () => resizeGrid(0, 1)),
    );
    const add = el('div', 'le-row');
    add.append(el('span', 'le-label', '추가'));
    for (const type of ['door', 'board', 'window']) add.append(button(`+ ${FIXTURE_LABELS[type]}`, 'btn-ghost', () => addFixture(type)));

    const sel = el('div', 'le-row');
    if (item?.kind === 'fix') {
      sel.append(
        el('span', 'le-label', `선택: ${FIXTURE_LABELS[item.ref.type]} (${item.w}×${item.h})`),
        button('가로 −', 'btn-ghost', () => resizeSelected(-1, 0)), button('가로 +', 'btn-ghost', () => resizeSelected(1, 0)),
        button('세로 −', 'btn-ghost', () => resizeSelected(0, -1)), button('세로 +', 'btn-ghost', () => resizeSelected(0, 1)),
        button('삭제', 'btn-danger', removeSelected),
      );
    } else if (item?.kind === 'seat') {
      const s = seats.find((x) => x.seat_no === item.ref.seat_no);
      sel.append(el('span', 'le-label', `선택: 좌석 ${s?.label ?? item.ref.seat_no} — 끌어서 옮기거나 방향키로 한 칸씩 이동`));
    } else {
      sel.append(el('span', 'le-label hint', '항목을 눌러 선택하거나 끌어다 놓으세요. 좌석끼리 겹치면 서로 자리를 바꿉니다.'));
    }
    tools.append(size, add, sel);
  }

  function renderEditGrid() {
    const wrap = el('div', 'le-scroll');
    const grid = el('div', 'le-grid');
    grid.style.gridTemplateColumns = `repeat(${draft.cols}, ${CELL}px)`;
    grid.style.gridTemplateRows = `repeat(${draft.rows}, ${CELL}px)`;
    for (let r = 0; r < draft.rows; r += 1) {
      for (let c = 0; c < draft.cols; c += 1) {
        const cell = el('div', 'le-cell');
        cell.style.gridRow = String(r + 1);
        cell.style.gridColumn = String(c + 1);
        grid.append(cell);
      }
    }
    const target = el('div', 'le-target');
    target.hidden = true;
    const labelOf = new Map(seats.map((s) => [s.seat_no, s]));

    for (const f of draft.fixtures) {
      const key = `fix:${f.id}`;
      const node = createFixtureBlock(f);
      node.classList.add('le-item');
      node.dataset.key = key;
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', `${FIXTURE_LABELS[f.type]} ${f.row + 1}줄 ${f.col + 1}칸, 크기 ${f.w}×${f.h}`);
      if (selected === key) node.classList.add('is-selected');
      bindDrag(node, key, grid, target);
      grid.append(node);
    }
    for (const p of draft.seats) {
      const key = `seat:${p.seat_no}`;
      const s = labelOf.get(p.seat_no);
      const node = el('div', `le-item le-seat seat-${s?.state ?? 'unknown'}`, s?.label ?? String(p.seat_no));
      node.dataset.key = key;
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', `좌석 ${s?.label ?? p.seat_no} ${p.row + 1}줄 ${p.col + 1}칸`);
      node.style.gridRow = String(p.row + 1);
      node.style.gridColumn = String(p.col + 1);
      if (selected === key) node.classList.add('is-selected');
      bindDrag(node, key, grid, target);
      grid.append(node);
    }
    grid.append(target);
    wrap.append(grid);
    return wrap;
  }

  function render() {
    if (drag) return; // 끌고 있는 중에는 다시 그리지 않는다
    head.replaceChildren();
    body.replaceChildren();
    if (!room) return;
    const title = el('h3', 'le-title', `좌석 배치 · ${room.name}`);
    if (!editing) {
      const badge = el('span', 'soon', room.layout?.custom ? '직접 편집한 배치' : '기본 배치');
      title.append(badge);
      head.append(title, button('배치 편집', 'btn-primary', beginEdit, !room.layout));
      preview.update(seats, room.layout ?? null);
      body.append(el('p', 'hint', '학생 화면에 이렇게 보입니다. 좌석 번호와 개수는 바뀌지 않고 위치만 바꿀 수 있습니다.'), preview.element);
      return;
    }
    const actions = el('div', 'le-actions');
    actions.append(
      button('기본 배치로', 'btn-ghost', loadDefault),
      button('취소', 'btn-ghost', () => cancelEdit(true)),
      button(saving ? '저장 중…' : '저장', 'btn-primary', save, !hasChanges()),
    );
    head.append(title, actions);
    renderTools();
    body.append(tools, renderEditGrid(), el('p', 'hint', '저장하기 전까지는 학생 화면이 바뀌지 않습니다. 사용 중인 좌석을 옮겨도 예약에는 영향이 없습니다.'));
  }

  return {
    element,
    /** 서버에서 받은 열람실 요약과 그 열람실 좌석. 편집 중이면 배치 초안은 유지하고 좌석 표시만 갱신 */
    update(nextRoom, nextSeats) {
      const roomChanged = room?.code !== nextRoom?.code;
      room = nextRoom ?? null;
      seats = Array.isArray(nextSeats) ? nextSeats : [];
      if (roomChanged && editing) cancelEdit(false);
      render();
    },
    isEditing: () => editing,
    isDragging: () => Boolean(drag),
    hasChanges,
    cancel: () => cancelEdit(false),
  };
}
