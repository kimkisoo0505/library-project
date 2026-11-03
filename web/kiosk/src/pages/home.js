import { api, ApiError, session } from '../api.js';
import { SeatSocket } from '../websocket.js';
import { createLoginForm } from '../components/login-form.js';
import { createSeatMap } from '../components/seat-map.js';
import { STATE_LABELS } from '../components/seat-card.js';

const IDLE_LOGOUT_MS = 90_000;      // 공용 키오스크: 일정 시간 입력이 없으면 자동 로그아웃
const FALLBACK_POLL_MS = 30_000;    // WebSocket이 끊겼을 때 주기적 재조회

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

/** 학생용 키오스크 화면 */
export function renderHome(root) {
  const state = { seats: [], user: null, selectedSeatId: null, busy: false, live: false, loadFailed: false };

  // ----- 레이아웃 -----
  const header = el('header', 'page-header');
  const title = el('h1', null, '열람실 좌석 현황');
  const liveBadge = el('span', 'badge badge-offline', '연결 중');
  const userBox = el('div', 'user-box');
  header.append(title, liveBadge, userBox);

  const message = el('p', 'message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');

  const main = el('main', 'layout');
  const seatMap = createSeatMap({ onSelect: selectSeat });
  const panel = el('aside', 'panel');
  const legend = el('ul', 'legend');
  for (const key of ['available', 'reserved', 'occupied', 'maintenance']) {
    const item = el('li', `legend-item seat-${key}`, STATE_LABELS[key]);
    legend.append(item);
  }
  const mapSection = el('section', 'map-section');
  mapSection.append(seatMap.element, legend);
  main.append(mapSection, panel);

  const footer = el('footer', 'page-footer');
  const adminLink = el('a', null, '관리자');
  adminLink.href = '#/admin';
  footer.append(adminLink);

  root.append(header, message, main, footer);

  const loginForm = createLoginForm({
    title: '학생 로그인',
    idLabel: '학번',
    idName: 'student_no',
    onSubmit: async ({ id, password }) => {
      const result = await api.studentLogin(id, password);
      session.set('student', result.token);
      state.user = result.user;
      showMessage(`${result.user.display_name}님, 환영합니다.`, 'success');
      resetIdleTimer();
      await loadSeats();
    },
  });

  // ----- 동작 -----
  function showMessage(text, kind = 'info') {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  function selectSeat(seat) {
    state.selectedSeatId = seat.id;
    seatMap.setSelected(seat.id);
    renderPanel();
  }

  async function loadSeats() {
    try {
      const data = await api.listSeats();
      state.seats = data.seats;
      state.loadFailed = false;
      seatMap.update(state.seats);
      seatMap.setSelected(state.selectedSeatId);
    } catch (err) {
      state.loadFailed = true;
      showMessage(err.message, 'error');
    }
    renderPanel();
  }

  async function restoreUser() {
    if (!session.get('student')) return;
    try {
      const { user } = await api.me('student');
      state.user = user;
    } catch {
      session.clear('student');
      state.user = null;
    }
  }

  async function logout(notifyServer = true) {
    if (notifyServer && session.get('student')) {
      try { await api.logout('student'); } catch { /* 토큰은 로컬에서 제거 */ }
    }
    session.clear('student');
    state.user = null;
    state.selectedSeatId = null;
    seatMap.setSelected(null);
    renderUserBox();
    await loadSeats();
  }

  async function runAction(action, successText) {
    if (state.busy) return;
    state.busy = true;
    renderPanel();
    try {
      await action();
      showMessage(successText, 'success');
    } catch (err) {
      showMessage(err.message, 'error');
      if (err instanceof ApiError && err.status === 401) await logout(false);
    } finally {
      state.busy = false;
      await loadSeats(); // 성공/실패와 무관하게 서버 기준 상태로 다시 그린다
    }
  }

  function renderUserBox() {
    userBox.replaceChildren();
    if (!state.user) return;
    const name = el('span', null, `${state.user.display_name}님`);
    const button = el('button', 'btn btn-ghost', '로그아웃');
    button.type = 'button';
    button.addEventListener('click', () => logout(true));
    userBox.append(name, button);
  }

  function actionButton(text, className, onClick, disabled = false) {
    const button = el('button', `btn ${className}`, text);
    button.type = 'button';
    button.disabled = state.busy || disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderPanel() {
    renderUserBox();
    panel.replaceChildren();

    if (!state.user) {
      panel.append(loginForm.element, el('p', 'hint', '좌석 현황은 로그인 없이 볼 수 있습니다. 예약하려면 로그인하세요.'));
      return;
    }

    const mine = state.seats.find((s) => s.mine);
    if (mine) {
      const box = el('div', 'my-seat');
      box.append(el('h2', null, `내 좌석: ${mine.label}`), el('p', null, STATE_LABELS[mine.state] ?? ''));
      if (mine.state === 'reserved') {
        box.append(
          el('p', 'hint', `${formatTime(mine.expires_at)}까지 착석하지 않으면 예약이 자동 취소됩니다.`),
          actionButton('착석', 'btn-primary', () => runAction(() => api.checkIn(mine.reservation_id), '착석 처리되었습니다.')),
          actionButton('예약 취소', 'btn-danger', () => runAction(() => api.cancelReservation(mine.reservation_id), '예약이 취소되었습니다.')),
        );
      } else if (mine.state === 'occupied') {
        box.append(actionButton('퇴실', 'btn-danger', () => runAction(() => api.checkOut(mine.reservation_id), '퇴실 처리되었습니다.')));
      }
      panel.append(box);
      return;
    }

    const selected = state.seats.find((s) => s.id === state.selectedSeatId);
    if (!selected) {
      panel.append(el('p', 'hint', '예약할 좌석을 선택하세요.'));
      return;
    }

    const box = el('div', 'selected-seat');
    box.append(el('h2', null, `선택한 좌석: ${selected.label}`), el('p', null, STATE_LABELS[selected.state] ?? ''));
    // 네트워크가 불안정하면 예약 버튼을 막는다. 최종 승인은 항상 서버 응답으로만 판단한다.
    const offline = state.loadFailed || !navigator.onLine;
    const reserveButton = actionButton(
      '이 좌석 예약',
      'btn-primary',
      () => runAction(() => api.createReservation(selected.id), `${selected.label} 좌석이 예약되었습니다.`),
      selected.state !== 'available' || offline,
    );
    box.append(reserveButton);
    if (offline) box.append(el('p', 'form-error', '서버와 연결되지 않아 예약할 수 없습니다.'));
    panel.append(box);
  }

  // ----- 자동 로그아웃 -----
  let idleTimer = null;
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!state.user) return;
    idleTimer = setTimeout(() => {
      showMessage('일정 시간 사용하지 않아 자동 로그아웃되었습니다.', 'info');
      logout(true);
    }, IDLE_LOGOUT_MS);
  }
  const activityEvents = ['pointerdown', 'keydown'];
  activityEvents.forEach((name) => document.addEventListener(name, resetIdleTimer));

  // ----- 실시간 갱신 -----
  const socket = new SeatSocket({
    onMessage: (msg) => { if (msg.type === 'seats.changed') loadSeats(); },
    onStatusChange: (connected) => {
      state.live = connected;
      liveBadge.textContent = connected ? '실시간' : '연결 끊김';
      liveBadge.className = `badge ${connected ? 'badge-online' : 'badge-offline'}`;
      if (connected) loadSeats();
    },
  });
  socket.connect();
  const pollTimer = setInterval(() => { if (!state.live) loadSeats(); }, FALLBACK_POLL_MS);

  restoreUser().then(() => { resetIdleTimer(); return loadSeats(); });

  return () => {
    socket.close();
    clearInterval(pollTimer);
    clearTimeout(idleTimer);
    activityEvents.forEach((name) => document.removeEventListener(name, resetIdleTimer));
  };
}
