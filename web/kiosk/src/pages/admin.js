import { api, ApiError, session } from '../api.js';
import { SeatSocket } from '../websocket.js';
import { createLoginForm } from '../components/login-form.js';
import { STATE_LABELS } from '../components/seat-card.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR');
}

/** 관리자 화면: 학생 세션과 분리된 관리자 세션을 사용한다. */
export function renderAdmin(root) {
  const state = { admin: null, seats: [], events: [], busy: false };

  const header = el('header', 'page-header');
  const title = el('h1', null, '관리자');
  const userBox = el('div', 'user-box');
  const back = el('a', 'btn btn-ghost', '키오스크로');
  back.href = '#/';
  header.append(title, userBox, back);

  const message = el('p', 'message');
  message.setAttribute('role', 'status');
  const content = el('main', 'admin-content');
  root.append(header, message, content);

  const loginForm = createLoginForm({
    title: '관리자 로그인',
    idLabel: '관리자 아이디',
    idName: 'username',
    onSubmit: async ({ id, password }) => {
      const result = await api.adminLogin(id, password);
      session.set('admin', result.token);
      state.admin = result.user;
      await refresh();
    },
  });

  function showMessage(text, kind = 'info') {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  async function handleError(err) {
    showMessage(err.message, 'error');
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      session.clear('admin');
      state.admin = null;
      render();
    }
  }

  async function refresh() {
    if (!state.admin) { render(); return; }
    try {
      const [seats, events] = await Promise.all([api.adminListSeats(), api.adminEvents(50)]);
      state.seats = seats.seats;
      state.events = events.events;
    } catch (err) {
      await handleError(err);
    }
    render();
  }

  async function runAction(action, successText) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await action();
      showMessage(successText, 'success');
    } catch (err) {
      await handleError(err);
    } finally {
      state.busy = false;
      await refresh();
    }
  }

  function button(text, className, onClick) {
    const b = el('button', `btn ${className}`, text);
    b.type = 'button';
    b.disabled = state.busy;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderSeatTable() {
    const table = el('table', 'data-table');
    const head = el('tr');
    for (const h of ['좌석', '상태', '예약 ID', '예약/착석 시각', '작업']) head.append(el('th', null, h));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');

    for (const seat of state.seats) {
      const row = el('tr');
      const r = seat.reservation;
      row.append(
        el('td', null, seat.label),
        el('td', `cell-${seat.state}`, STATE_LABELS[seat.state] ?? seat.state),
        el('td', null, r ? String(r.id) : '-'),
        el('td', null, r ? formatDateTime(r.checked_in_at || r.reserved_at) : '-'),
      );
      const actions = el('td', 'cell-actions');
      if (r) {
        actions.append(button('예약 해제', 'btn-danger', () => {
          const reason = window.prompt(`${seat.label} 예약을 해제하는 사유를 입력하세요.`);
          if (!reason || !reason.trim()) return;
          runAction(() => api.adminReleaseReservation(r.id, reason.trim()), `${seat.label} 예약을 해제했습니다.`);
        }));
      } else if (seat.seat_status === 'maintenance') {
        actions.append(button('사용 재개', 'btn-primary', () =>
          runAction(() => api.adminSetSeatStatus(seat.id, 'available'), `${seat.label} 사용을 재개했습니다.`)));
      } else {
        actions.append(button('점검 전환', 'btn-ghost', () =>
          runAction(() => api.adminSetSeatStatus(seat.id, 'maintenance', 'admin'), `${seat.label}을(를) 점검 상태로 바꿨습니다.`)));
      }
      row.append(actions);
      body.append(row);
    }
    table.append(body);
    return table;
  }

  function renderEvents() {
    const list = el('ol', 'event-list');
    for (const e of state.events) {
      const item = el('li');
      const seat = e.seat_id ? ` · 좌석 ${e.seat_id}` : '';
      item.append(
        el('time', null, formatDateTime(e.occurred_at)),
        el('span', 'event-type', e.event_type),
        el('span', 'event-meta', `${e.source}${e.actor_type ? ` · ${e.actor_type}` : ''}${seat}`),
      );
      list.append(item);
    }
    if (state.events.length === 0) list.append(el('li', 'hint', '이벤트가 없습니다.'));
    return list;
  }

  function render() {
    userBox.replaceChildren();
    content.replaceChildren();
    if (!state.admin) {
      content.append(loginForm.element);
      return;
    }
    userBox.append(
      el('span', null, state.admin.username),
      button('로그아웃', 'btn-ghost', async () => {
        try { await api.logout('admin'); } catch { /* 로컬 토큰만 제거 */ }
        session.clear('admin');
        state.admin = null;
        render();
      }),
    );

    const seatSection = el('section', 'card');
    seatSection.append(el('h2', null, '좌석 관리'), renderSeatTable());
    const eventSection = el('section', 'card');
    eventSection.append(el('h2', null, '최근 이벤트 (50건)'), button('새로고침', 'btn-ghost', refresh), renderEvents());
    content.append(seatSection, eventSection);
  }

  const socket = new SeatSocket({
    onMessage: (msg) => { if (msg.type === 'seats.changed' && state.admin) refresh(); },
  });
  socket.connect();

  (async () => {
    if (session.get('admin')) {
      try {
        const { user } = await api.me('admin');
        state.admin = user.type === 'admin' ? user : null;
      } catch {
        session.clear('admin');
      }
    }
    await refresh();
  })();

  return () => socket.close();
}
