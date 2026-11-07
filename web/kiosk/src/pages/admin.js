import { api, ApiError, session } from '../api.js';
import { SeatSocket } from '../websocket.js';
import { createLoginForm } from '../components/login-form.js';
import { STATE_LABELS } from '../components/seat-card.js';
import { createRoomTabs, roomPreference } from '../components/room-tabs.js';
import { TEST_ADMIN } from '../test-accounts.js';

const ROOM_PREF_KEY = 'library.admin.room';

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
  const state = { admin: null, rooms: [], seats: [], events: [], devices: [], busy: false, room: roomPreference.load(ROOM_PREF_KEY) || 'A' };
  const roomTabs = createRoomTabs({
    onSelect: (code) => {
      state.room = code;
      roomPreference.save(ROOM_PREF_KEY, code);
      render();
    },
  });

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
      const [seats, events, status] = await Promise.all([
        api.adminListSeats(),
        api.adminEvents(50),
        api.systemStatus().catch(() => null),
      ]);
      state.devices = status?.devices ?? [];
      state.rooms = seats.rooms ?? [];
      state.seats = seats.seats;
      state.events = events.events;
      if (!state.rooms.some((r) => r.code === state.room) && state.rooms.length) state.room = state.rooms[0].code;
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

  // ----- 강의실 위치(호수) 입력: 학생 화면의 열람실 이름 자리에 표시된다 -----
  // 입력란은 한 번만 만들어 두어, 실시간 갱신으로 다시 그려져도 입력 중인 글자가 지워지지 않게 한다.
  const locationInput = el('input', 'location-input');
  locationInput.type = 'text';
  locationInput.maxLength = 40;
  locationInput.placeholder = '예: 00관 000호';
  locationInput.id = 'room-location';
  let locationRoom = null;
  let locationDirty = false;
  locationInput.addEventListener('input', () => { locationDirty = true; });

  function renderLocationForm() {
    const room = state.rooms.find((r) => r.code === state.room);
    if (locationRoom !== state.room || !locationDirty) {
      locationInput.value = room?.location ?? '';
      locationRoom = state.room;
      locationDirty = false;
    }
    const form = el('form', 'location-form');
    const label = el('label', null, `${room?.name ?? state.room} 강의실 위치 (호수)`);
    label.htmlFor = 'room-location';
    const save = el('button', 'btn btn-primary', '저장');
    save.type = 'submit';
    save.disabled = state.busy;
    form.append(label, locationInput, save, el('p', 'hint', '학생 화면의 좌석 배치도 위에 표시됩니다. 비워 두고 저장하면 열람실 이름이 표시됩니다.'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = state.room;
      const value = locationInput.value;
      runAction(async () => {
        await api.adminSetRoomLocation(code, value);
        locationDirty = false;
      }, `${room?.name ?? code} 위치를 저장했습니다.`);
    });
    return form;
  }

  function renderSeatTable() {
    const table = el('table', 'data-table');
    const head = el('tr');
    for (const h of ['좌석', '상태', '예약 ID', '예약/착석 시각', '작업']) head.append(el('th', null, h));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');

    for (const seat of state.seats.filter((s) => s.room === state.room)) {
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

  async function shutdownDevice(device) {
    const first = window.confirm([
      `${device.label}의 전원을 끕니다.`,
      '',
      '• 열람실 A 의 LCD 와 중앙도서관 정보 중계가 멈춥니다.',
      '• 다시 켜려면 현장에서 전원 케이블을 뽑았다가 다시 꽂아야 합니다.',
      '',
      '계속할까요?',
    ].join('\n'));
    if (!first) return;
    const typed = window.prompt('확인을 위해 "끄기" 를 입력하세요.');
    if ((typed ?? '').trim() !== '끄기') {
      showMessage('입력이 일치하지 않아 취소했습니다.', 'info');
      return;
    }
    await runAction(
      () => api.adminShutdownDevice(device.room),
      `${device.label}에 종료 명령을 보냈습니다. LCD 에 "Shutting down" 이 보이고 약 30초 후 꺼집니다. 다시 켜려면 전원을 뽑았다 꽂으세요.`,
    );
  }

  function renderDevices() {
    const list = el('ul', 'device-list');
    if (state.devices.length === 0) list.append(el('li', 'hint', '장치 상태를 불러오지 못했습니다.'));
    for (const d of state.devices) {
      const item = el('li', `device-item ${d.online ? 'is-online' : 'is-offline'}`);
      const net = d.network?.type === 'wifi' ? ` · Wi-Fi ${d.network.ssid ?? ''}` : d.network?.type === 'ethernet' ? ' · 유선' : '';
      item.append(
        el('span', 'device-dot'),
        el('span', 'device-name', d.label),
        el('span', 'device-meta', d.online ? `연결됨${net}` : '연결 안 됨'),
      );
      if (d.kind === 'raspberry-pi') {
        const off = button('라즈베리파이 끄기', 'btn-danger', () => shutdownDevice(d));
        off.disabled = state.busy || !d.online;
        if (!d.online) off.title = '연결되어 있지 않아 끌 수 없습니다';
        item.append(off);
      }
      list.append(item);
    }
    return list;
  }

  function renderAdminAccountNotice() {
    if (!TEST_ADMIN) return null;
    const box = el('section', 'test-accounts');
    box.setAttribute('aria-label', '테스트 관리자 계정 안내');
    box.append(
      el('h3', null, '테스트 관리자 계정 (시연용)'),
      el('p', 'hint', '시연 기간 임시 안내입니다. 누르면 로그인 정보가 입력됩니다.'),
    );
    const b = el('button', 'test-account');
    b.type = 'button';
    b.append(el('span', 'test-account-id', TEST_ADMIN.username), el('span', 'test-account-name', '관리자'),
      el('code', 'test-account-pw', TEST_ADMIN.password));
    b.addEventListener('click', () => {
      loginForm.fill(TEST_ADMIN.username, TEST_ADMIN.password);
      showMessage('관리자 계정 정보를 입력했습니다. 로그인 버튼을 누르세요.', 'info');
    });
    const list = el('ul', 'test-account-list');
    const li = el('li');
    li.append(b);
    list.append(li);
    box.append(list);
    return box;
  }

  function renderEvents() {
    const list = el('ol', 'event-list');
    for (const e of state.events) {
      const item = el('li');
      const seatLabel = state.seats.find((s) => s.id === e.seat_id)?.label;
      const seat = e.seat_id ? ` · 좌석 ${seatLabel ?? e.seat_id}` : '';
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
      const notice = renderAdminAccountNotice();
      if (notice) content.append(notice);
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
    roomTabs.update(state.rooms, state.room);
    seatSection.append(el('h2', null, '좌석 관리'), roomTabs.element, renderLocationForm(), renderSeatTable());
    const deviceSection = el('section', 'card');
    deviceSection.append(el('h2', null, '현장 장치'), renderDevices());
    const eventSection = el('section', 'card');
    eventSection.append(el('h2', null, '최근 이벤트 (50건)'), button('새로고침', 'btn-ghost', refresh), renderEvents());
    content.append(deviceSection, seatSection, eventSection);
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
