import { api, ApiError, session } from '../api.js';
import { SeatSocket } from '../websocket.js';
import { createLoginForm } from '../components/login-form.js';
import { createSeatMap } from '../components/seat-map.js';
import { STATE_LABELS } from '../components/seat-card.js';
import { createRoomTabs, roomPreference } from '../components/room-tabs.js';
import { TEST_STUDENTS } from '../test-accounts.js';
import { createCentralLibraryPanel, congestionLevel, createLevelPill } from '../components/central-library.js';
import { createSystemStatusBar, SHOW_SYSTEM_STATUS } from '../components/system-status.js';

const SYSTEM_STATUS_POLL_MS = 15_000;

const CENTRAL_LIBRARY_POLL_MS = 60_000;

const ROOM_PREF_KEY = 'library.kiosk.room';

const IDLE_LOGOUT_MS = 90_000;      // 공용 키오스크: 일정 시간 입력이 없으면 자동 로그아웃
const FALLBACK_POLL_MS = 30_000;    // WebSocket이 끊겼을 때 주기적 재조회

const COUNTDOWN_TICK_MS = 1_000;    // 착석 마감까지 남은 시간 표시 (표시 전용, 만료 판단은 서버)
const URGENT_MS = 3 * 60_000;
const TOAST_MS = 2_800;
const TOAST_ERROR_MS = 5_000;

const SVG_NS = 'http://www.w3.org/2000/svg';
const TAB_ICONS = {
  seats: [['rect', { x: 4, y: 4, width: 16, height: 10, rx: 3 }], ['path', { d: 'M7 14v6M17 14v6M4 10h16' }]],
  central: [['path', { d: 'M3 10l9-6 9 6' }], ['path', { d: 'M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18' }]],
  me: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6' }]],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const [tag, shapeAttrs] of TAB_ICONS[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(shapeAttrs)) shape.setAttribute(k, String(v));
    svg.append(shape);
  }
  return svg;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function formatLeft(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** 학생용 키오스크 화면 */
export function renderHome(root) {
  const state = {
    rooms: [],
    seats: [],          // 전체 열람실 좌석 (내 좌석이 다른 열람실에 있어도 찾을 수 있도록)
    room: roomPreference.load(ROOM_PREF_KEY) || 'A',
    user: null,
    selectedSeatId: null,
    busy: false,
    live: false,
    loadFailed: false,
    tab: 'seats',       // 하단 탭: seats | central | me
    central: null,      // 마지막으로 받은 중앙도서관 데이터 (미니 카드·안내 문구용)
  };

  const roomName = (code) => state.rooms.find((r) => r.code === code)?.name ?? `열람실 ${code}`;
  const seatsInRoom = () => state.seats.filter((s) => s.room === state.room);
  const mySeat = () => state.seats.find((s) => s.mine);

  // ----- 레이아웃: 상단 바 -----
  const header = el('header', 'topbar');
  const logo = el('div', 'logo', 'KGU');
  logo.setAttribute('aria-hidden', 'true');
  const brand = el('div', 'brand', '열람실 좌석');
  brand.append(el('small', null, '열람실 A·B·C 실시간 현황'));
  const liveBadge = el('span', 'live is-offline', '연결 중');
  const userBox = el('div', 'user-box');
  header.append(logo, brand, liveBadge, userBox);

  // 알림 메시지 (토스트)
  const message = el('div', 'toast');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');

  // ----- 좌석 탭 -----
  const seatsView = el('main', 'view page');
  const hero = el('section');
  hero.setAttribute('aria-label', '내 이용 상태');

  const seatMap = createSeatMap({ onSelect: selectSeat });
  const legend = el('ul', 'legend');
  for (const key of ['available', 'reserved', 'occupied', 'maintenance', 'mine']) {
    const item = el('li', 'legend-item');
    item.append(el('i', `swatch swatch-${key}`), key === 'mine' ? '내 좌석' : STATE_LABELS[key]);
    legend.append(item);
  }
  const roomTabs = createRoomTabs({ onSelect: selectRoom });
  const roomHead = el('div', 'room-head');
  const roomTitle = el('h3');
  const roomCount = el('span', 'cnt');
  roomHead.append(roomTitle, roomCount);
  const mapSection = el('section', 'card map-section');
  mapSection.append(roomTabs.element, roomHead, buildFilters(), seatMap.element, legend);

  const miniCard = el('section', 'card mini-card');
  const miniButton = el('button', 'mini-cl');
  miniButton.type = 'button';
  miniButton.addEventListener('click', () => setTab('central'));
  miniCard.append(miniButton);

  const footer = el('footer', 'page-footer');
  const adminLink = el('a', null, '관리자');
  adminLink.href = '#/admin';
  footer.append(adminLink);

  const centralLibrary = createCentralLibraryPanel();

  const systemStatus = SHOW_SYSTEM_STATUS ? createSystemStatusBar() : null;

  seatsView.append(hero, mapSection, miniCard, ...(systemStatus ? [systemStatus.element] : []), footer);

  // ----- 중앙도서관 탭 -----
  const centralView = el('main', 'view page');
  centralView.hidden = true;
  const centralHead = el('div');
  centralHead.append(el('div', 'sec-title', '중앙도서관 혼잡도'), el('div', 'sec-sub', '경기대 도서관 좌석 현황을 1분마다 받아와요'));
  const tip = el('button', 'tip');
  tip.type = 'button';
  tip.hidden = true;
  tip.addEventListener('click', () => {
    if (tip.dataset.room) selectRoom(tip.dataset.room);
    setTab('seats');
  });
  centralView.append(centralHead, tip, centralLibrary.element);

  // ----- 내 이용 탭 -----
  const meView = el('main', 'view page');
  meView.hidden = true;
  const meHead = el('div');
  const meSub = el('div', 'sec-sub');
  meHead.append(el('div', 'sec-title', '내 이용'), meSub);
  const meBody = el('div', 'stack');
  meView.append(meHead, meBody);

  // ----- 하단 탭 -----
  const tabbar = el('nav', 'tabbar');
  tabbar.setAttribute('aria-label', '화면 전환');
  const tabButtons = {};
  for (const [key, label] of [['seats', '좌석'], ['central', '중앙도서관'], ['me', '내 이용']]) {
    const b = el('button', key === state.tab ? 'on' : '');
    b.type = 'button';
    b.append(icon(key), label);
    b.addEventListener('click', () => setTab(key));
    tabButtons[key] = b;
    tabbar.append(b);
  }

  // ----- 바텀시트 (좌석 상세 · 로그인 · 확인) -----
  const scrim = el('div', 'scrim');
  scrim.addEventListener('click', () => closeSheet());
  const sheet = el('div', 'sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-hidden', 'true');
  const sheetBody = el('div');
  sheet.append(el('div', 'grab'), sheetBody);

  root.append(header, seatsView, centralView, meView, tabbar, scrim, sheet, message);

  async function loadSystemStatus() {
    if (!systemStatus) return;
    try {
      systemStatus.update(await api.systemStatus());
    } catch {
      systemStatus.showError();
    }
  }

  // 중앙/금화도서관 공석 (예약 기능과 독립: 실패해도 다른 화면에 영향 없음)
  async function loadCentralLibrary() {
    try {
      const data = await api.centralLibrary();
      state.central = data;
      centralLibrary.update(data);
    } catch {
      state.central = null;
      centralLibrary.showError();
    }
    renderCentralExtras();
  }

  const loginForm = createLoginForm({
    title: '학생 로그인',
    idLabel: '학번',
    idName: 'student_no',
    onSubmit: async ({ id, password }) => {
      // 좌석을 누른 뒤 로그인했다면 로그인 후 그 좌석 시트를 다시 연다
      const nextSeatId = sheetState.kind === 'login' ? sheetState.thenSeatId : null;
      const result = await api.studentLogin(id, password);
      session.set('student', result.token);
      state.user = result.user;
      showMessage(`${result.user.display_name}님, 환영합니다.`, 'success');
      resetIdleTimer();
      await loadSeats();
      closeSheet();
      const nextSeat = state.seats.find((s) => s.id === nextSeatId);
      if (nextSeat) selectSeat(nextSeat);
      else renderPanel();
    },
  });

  // ----- 테스트 계정 안내 (VITE_SHOW_TEST_ACCOUNTS=true 일 때만) -----
  const testAccountsBox = TEST_STUDENTS.length ? buildTestAccountsBox() : null;

  function buildTestAccountsBox() {
    const box = el('section', 'test-accounts');
    box.setAttribute('aria-label', '테스트 계정 안내');
    box.append(
      el('h3', null, '테스트 계정'),
      el('p', 'hint', '시험용 가짜 계정입니다. 누르면 로그인 정보가 입력됩니다.'),
    );
    const list = el('ul', 'test-account-list');
    for (const account of TEST_STUDENTS) {
      const button = el('button', 'test-account');
      button.type = 'button';
      button.append(
        el('span', 'test-account-id', account.studentNo),
        el('span', 'test-account-name', account.name),
        el('code', 'test-account-pw', account.password),
      );
      button.setAttribute('aria-label', `${account.name} (${account.studentNo}) 로그인 정보 입력`);
      button.addEventListener('click', () => {
        loginForm.fill(account.studentNo, account.password);
        showMessage(`${account.name} 계정 정보를 입력했습니다. 로그인 버튼을 누르세요.`, 'info');
      });
      const item = el('li');
      item.append(button);
      list.append(item);
    }
    box.append(list);
    return box;
  }

  // 좌석 조건 필터 (시안 기능: 좌석 속성 데이터가 아직 없어 "기능 추가 예정")
  function buildFilters() {
    const box = el('div', 'filters');
    for (const [key, label] of [['all', '전체'], ['outlet', '⚡ 콘센트'], ['window', '🪟 창가'], ['quiet', '🤫 조용한 구역']]) {
      const b = el('button', key === 'all' ? 'filter on' : 'filter is-soon', label);
      b.type = 'button';
      if (key !== 'all') {
        b.setAttribute('aria-disabled', 'true');
        b.title = '기능 추가 예정';
        b.addEventListener('click', () => showMessage('좌석 조건 필터(콘센트·창가·조용한 구역)는 기능 추가 예정입니다.', 'info'));
      }
      box.append(b);
    }
    box.append(el('span', 'soon', '필터 · 기능 추가 예정'));
    return box;
  }

  // ----- 동작 -----
  let toastTimer = null;
  function showMessage(text, kind = 'info') {
    message.textContent = text;
    message.dataset.kind = kind;
    message.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => message.classList.remove('show'), kind === 'error' ? TOAST_ERROR_MS : TOAST_MS);
  }

  function selectSeat(seat) {
    state.selectedSeatId = seat.id;
    seatMap.setSelected(seat.id);
    openSheet({ kind: 'seat' });
    renderPanel();
  }

  function renderMap() {
    roomTabs.update(state.rooms, state.room);
    seatMap.update(seatsInRoom());
    seatMap.setSelected(state.selectedSeatId);
    renderRoomHead();
    renderCentralExtras();
  }

  function selectRoom(code) {
    if (code === state.room) return;
    state.room = code;
    state.selectedSeatId = null;
    roomPreference.save(ROOM_PREF_KEY, code);
    renderMap();
    renderPanel();
  }

  async function loadSeats() {
    try {
      const data = await api.listSeats();
      state.rooms = data.rooms ?? [];
      state.seats = data.seats;
      state.loadFailed = false;
      if (!state.rooms.some((r) => r.code === state.room) && state.rooms.length) {
        state.room = state.rooms[0].code;
      }
      if (!seatsInRoom().some((s) => s.id === state.selectedSeatId)) state.selectedSeatId = null;
      renderMap();
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
    closeSheet();
    setTab('seats');
    renderUserBox();
    await loadSeats();
  }

  /** @returns {Promise<boolean>} 서버가 요청을 성공 처리했는지 */
  async function runAction(action, successText) {
    if (state.busy) return false;
    state.busy = true;
    renderPanel();
    let ok = false;
    try {
      await action();
      ok = true;
      showMessage(successText, 'success');
    } catch (err) {
      showMessage(err.message, 'error');
      if (err instanceof ApiError && err.status === 401) await logout(false);
    } finally {
      state.busy = false;
      await loadSeats(); // 성공/실패와 무관하게 서버 기준 상태로 다시 그린다
    }
    return ok;
  }

  function renderUserBox() {
    userBox.replaceChildren();
    const button = el('button', state.user ? 'userbtn' : 'userbtn login', state.user ? `${state.user.display_name}님` : '로그인');
    button.type = 'button';
    button.addEventListener('click', () => (state.user ? setTab('me') : openLogin()));
    userBox.append(button);
  }

  function actionButton(text, className, onClick, disabled = false) {
    const button = el('button', `btn ${className}`, text);
    button.type = 'button';
    button.disabled = state.busy || disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  /** 상태가 바뀔 때마다 호출: 상단 사용자 버튼, 상태 카드, 열린 시트, 내 이용 탭 */
  function renderPanel() {
    renderUserBox();
    renderHero();
    renderSheet();
    renderMe();
  }

  function showMySeatOnMap(seat) {
    setTab('seats');
    selectRoom(seat.room);
    mapSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function confirmCancel(mine) {
    openConfirm({
      reservationId: mine.reservation_id,
      title: '예약을 취소할까요?',
      desc: `${roomName(mine.room)} ${mine.label} 좌석이 바로 다른 사람에게 돌아가요.`,
      confirmText: '예약 취소하기',
      run: () => api.cancelReservation(mine.reservation_id),
      successText: '예약이 취소되었습니다.',
    });
  }

  function confirmCheckOut(mine) {
    openConfirm({
      reservationId: mine.reservation_id,
      title: '퇴실할까요?',
      desc: '퇴실하면 자리가 바로 다른 사람에게 돌아가요.',
      confirmText: '퇴실하기',
      run: () => api.checkOut(mine.reservation_id),
      successText: '퇴실 처리되었습니다.',
    });
  }

  // ----- 상태(히어로) 카드 -----
  let countdownEl = null;
  let countdownTarget = NaN;
  let expiryReloadRequested = false;

  function renderHero() {
    countdownEl = null;
    const box = el('div', 'hero');

    if (!state.user) {
      box.append(
        el('div', 'k', '열람실 좌석 현황'),
        el('div', 'v', state.rooms.length ? `지금 ${state.rooms.reduce((sum, r) => sum + (Number(r.available) || 0), 0)}자리 비어 있어요` : '좌석 정보를 불러오는 중…'),
        el('div', 'd', '좌석 현황은 로그인 없이 볼 수 있습니다. 예약하려면 로그인하세요.'),
      );
      const btns = el('div', 'hero-btns');
      btns.append(actionButton('학번으로 로그인', 'hbtn w', () => openLogin()));
      box.append(btns);
      hero.replaceChildren(box);
      return;
    }

    const mine = mySeat();
    if (mine) {
      const top = el('div', 'row');
      const left = el('div');
      const btns = el('div', 'hero-btns');
      if (mine.state === 'reserved') {
        left.append(el('div', 'k', `예약 완료 · ${roomName(mine.room)}`), el('div', 'v', `${mine.label} 좌석`));
        const right = el('div', 'right');
        const target = Date.parse(mine.expires_at ?? '');
        if (target !== countdownTarget) { countdownTarget = target; expiryReloadRequested = false; }
        countdownEl = el('div', 'countdown', formatLeft(target - Date.now()));
        countdownEl.setAttribute('aria-hidden', 'true');
        right.append(el('div', 'k', '착석까지'), countdownEl);
        top.append(left, right);
        box.append(top, el('div', 'd', `${formatTime(mine.expires_at)}까지 착석하지 않으면 예약이 자동 취소됩니다.`));
        btns.append(
          actionButton('착석했어요', 'hbtn w', () => runAction(() => api.checkIn(mine.reservation_id), '착석 처리되었습니다.')),
          actionButton('예약 취소', 'hbtn g', () => confirmCancel(mine)),
        );
        updateCountdown();
      } else if (mine.state === 'occupied') {
        left.append(el('div', 'k', `이용 중 · ${roomName(mine.room)}`), el('div', 'v', `${mine.label} 좌석`));
        top.append(left);
        box.append(top, el('div', 'd', '공부를 마치면 꼭 [퇴실]을 눌러 주세요. 다음 사람에게 바로 자리가 돌아가요.'));
        btns.append(
          actionButton('퇴실하기', 'hbtn w', () => confirmCheckOut(mine)),
          actionButton('내 자리 보기', 'hbtn g', () => showMySeatOnMap(mine)),
        );
      } else {
        left.append(el('div', 'k', `내 좌석 · ${roomName(mine.room)}`), el('div', 'v', `${mine.label} 좌석`));
        top.append(left);
        box.append(top, el('div', 'd', STATE_LABELS[mine.state] ?? ''));
      }
      if (mine.state === 'reserved' && mine.room !== state.room) {
        btns.append(actionButton('내 자리 보기', 'hbtn g', () => showMySeatOnMap(mine)));
      }
      if (btns.childElementCount) box.append(btns);
      hero.replaceChildren(box);
      return;
    }

    box.append(
      el('div', 'k', `${state.user.display_name}님, 안녕하세요`),
      el('div', 'v', '원하는 자리를 골라 주세요'),
      el('div', 'd', '아래 배치도에서 좌석을 누르면 예약할 수 있어요.'),
      el('span', 'chip-glass', '✨ 자주 앉던 자리 추천 · 기능 추가 예정'),
    );
    hero.replaceChildren(box);
  }

  function updateCountdown() {
    if (!countdownEl || !countdownEl.isConnected) return;
    const left = countdownTarget - Date.now();
    countdownEl.textContent = formatLeft(left);
    countdownEl.classList.toggle('is-urgent', left < URGENT_MS);
    // 만료 처리는 서버가 한다. 화면은 시간이 지나면 서버 상태를 한 번 다시 조회할 뿐이다.
    if (left <= 0 && !expiryReloadRequested) {
      expiryReloadRequested = true;
      loadSeats();
    }
  }

  function renderRoomHead() {
    const room = state.rooms.find((r) => r.code === state.room);
    roomTitle.textContent = roomName(state.room);
    roomCount.replaceChildren();
    if (!room) return;
    if (Number(room.available) === 0) {
      roomCount.append(el('b', 'full', '만석'), ` · ${room.total}석`);
    } else {
      roomCount.append('이용 가능 ', el('b', null, String(room.available)), ` / ${room.total}`);
    }
  }

  // ----- 중앙도서관 미니 카드 · 안내 문구 -----
  function renderCentralExtras() {
    const campuses = state.central?.available ? state.central.campuses ?? [] : [];
    const main = campuses.find((c) => c.id === 1) ?? campuses[0];

    miniButton.replaceChildren();
    const ic = el('span', 'ic', '📚');
    ic.setAttribute('aria-hidden', 'true');
    const text = el('span');
    if (main) {
      const level = congestionLevel(main.total - main.available, main.total);
      text.append(el('span', 't', `${main.library}(${String(main.campus).replace('캠퍼스', '')}) 지금`));
      const v = el('span', 'v');
      v.append(createLevelPill(level), `잔여 ${main.available}석`, el('span', 'v-total', `/ ${main.total}`));
      text.append(v);
    } else {
      text.append(el('span', 't', '중앙도서관 · 금화도서관'), el('span', 'v', '공석 현황 보기'));
    }
    const arrow = el('span', 'arrow', '›');
    arrow.setAttribute('aria-hidden', 'true');
    miniButton.append(ic, text, arrow);

    const best = [...state.rooms].sort((a, b) => (Number(b.available) || 0) - (Number(a.available) || 0))[0];
    if (!main || !best) { tip.hidden = true; return; }
    const crowded = congestionLevel(main.total - main.available, main.total) === 'bad';
    const tipIc = el('span', 'ic', '💡');
    tipIc.setAttribute('aria-hidden', 'true');
    const tipText = el('span');
    tipText.append(
      el('div', 't', crowded ? `${main.library}이 거의 꽉 찼어요` : `${main.library}에 자리가 있어요`),
      el('div', 'd', `${best.name}에는 ${best.available}자리가 남아 있어요 · 좌석 보기 ›`),
    );
    tip.replaceChildren(tipIc, tipText);
    tip.dataset.room = best.code;
    tip.hidden = false;
  }

  // ----- 내 이용 탭 -----
  function soonCard(title, note) {
    const card = el('section', 'card');
    const h = el('div', 'card-title', title);
    h.append(el('span', 'soon', '기능 추가 예정'));
    card.append(h, el('p', 'note', note));
    return card;
  }

  function renderMe() {
    meBody.replaceChildren();
    if (!state.user) {
      meSub.textContent = '로그인하면 내 좌석과 이용 정보를 볼 수 있어요';
      const card = el('div', 'card empty');
      const ic = el('div', 'ic', '🔒');
      ic.setAttribute('aria-hidden', 'true');
      card.append(ic, el('div', null, '로그인하면 내 좌석 상태를 볼 수 있어요'), actionButton('학번으로 로그인', 'cta', () => openLogin()));
      meBody.append(card);
      return;
    }
    meSub.textContent = `${state.user.display_name}님`;

    const mine = mySeat();
    const now = el('section', 'card');
    now.append(el('div', 'card-title', '지금 내 좌석'));
    if (mine) {
      now.append(el('p', 'my-now', `${roomName(mine.room)} ${mine.label} · ${STATE_LABELS[mine.state] ?? ''}`));
      now.append(actionButton('내 자리 보기', 'cta ghost', () => showMySeatOnMap(mine)));
    } else {
      now.append(el('p', 'note', '이용 중인 좌석이 없어요. 좌석 탭에서 예약할 수 있어요.'));
    }

    const stats = el('div', 'stats');
    for (const label of ['이용 횟수', '누적 공부 시간']) {
      const stat = el('div', 'stat');
      const k = el('div', 'k', label);
      k.append(el('span', 'soon', '추가 예정'));
      stat.append(k, el('div', 'v', '—'));
      stats.append(stat);
    }

    meBody.append(
      now,
      stats,
      soonCard('자주 앉는 자리', '이용 기록을 바탕으로 자주 앉는 자리와 비슷한 조건의 빈자리를 추천하는 기능은 추가 예정입니다.'),
      soonCard('최근 이용', '날짜별 이용 기록(좌석, 시작 시각, 이용 시간)을 보여 주는 기능은 추가 예정입니다.'),
      actionButton('로그아웃', 'cta ghost', () => logout(true)),
    );
  }

  // ----- 탭 전환 -----
  function setTab(tab) {
    if (state.tab !== tab) closeSheet();
    state.tab = tab;
    seatsView.hidden = tab !== 'seats';
    centralView.hidden = tab !== 'central';
    meView.hidden = tab !== 'me';
    for (const [key, b] of Object.entries(tabButtons)) {
      b.classList.toggle('on', key === tab);
      if (key === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
  }

  // ----- 바텀시트 -----
  const sheetState = { kind: null, thenSeatId: null, confirm: null };

  function openSheet(next) {
    sheetState.kind = next.kind;
    sheetState.thenSeatId = next.thenSeatId ?? null;
    sheetState.confirm = next.confirm ?? null;
    renderSheet(true);
    scrim.classList.add('show');
    sheet.classList.add('show');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closeSheet() {
    const wasOpen = sheetState.kind !== null;
    sheetState.kind = null;
    sheetState.thenSeatId = null;
    sheetState.confirm = null;
    scrim.classList.remove('show');
    sheet.classList.remove('show');
    sheet.setAttribute('aria-hidden', 'true');
    if (wasOpen && state.selectedSeatId != null) {
      state.selectedSeatId = null;
      seatMap.setSelected(null);
    }
  }

  function openLogin(thenSeatId = null) {
    openSheet({ kind: 'login', thenSeatId });
    setTimeout(() => { if (sheetState.kind === 'login') loginForm.focus(); }, 300);
  }

  function openConfirm(confirm) {
    openSheet({ kind: 'confirm', confirm });
  }

  function renderSheet(force = false) {
    if (sheetState.kind === 'login') {
      if (state.user) { closeSheet(); return; }
      if (!force) return; // 입력 중인 폼을 다시 그리지 않는다
      sheetBody.replaceChildren(loginForm.element, el('p', 'hint', '좌석 현황은 로그인 없이 볼 수 있습니다. 예약하려면 로그인하세요.'));
      if (testAccountsBox) sheetBody.append(testAccountsBox);
      return;
    }
    if (sheetState.kind === 'seat') {
      const seat = state.seats.find((s) => s.id === state.selectedSeatId);
      if (!seat) { closeSheet(); return; }
      sheetBody.replaceChildren(...seatSheetContent(seat));
      return;
    }
    if (sheetState.kind === 'confirm') {
      const c = sheetState.confirm;
      // 예약이 이미 끝났으면(만료, 다른 기기에서 처리 등) 확인 창을 닫는다
      if (!state.user || mySeat()?.reservation_id !== c.reservationId) { closeSheet(); return; }
      const title = el('div', 'sh-title');
      title.append(el('b', 'small', c.title));
      const actions = el('div', 'actions');
      actions.append(
        actionButton(c.confirmText, 'cta danger', async () => {
          await runAction(c.run, c.successText);
          closeSheet();
        }),
        actionButton('돌아가기', 'cta ghost', () => closeSheet()),
      );
      sheetBody.replaceChildren(title, el('div', 'sh-sub', c.desc), actions);
    }
  }

  function seatSheetContent(seat) {
    const stateLabel = STATE_LABELS[seat.state] ?? STATE_LABELS.unknown;
    const title = el('div', 'sh-title');
    title.append(el('b', null, seat.label), el('span', `sh-state state-${seat.mine ? 'mine' : seat.state}`, seat.mine ? '내 좌석' : stateLabel));
    const tags = el('div', 'tags');
    tags.append(el('span', 'tag', '좌석 정보(콘센트·창가 등) · 기능 추가 예정'));
    const parts = [title, el('div', 'sh-sub', roomName(seat.room)), tags];

    const actions = el('div', 'actions');
    const mine = mySeat();
    // 네트워크가 불안정하면 예약 버튼을 막는다. 최종 승인은 항상 서버 응답으로만 판단한다.
    const offline = state.loadFailed || !navigator.onLine;
    if (seat.mine) {
      actions.append(actionButton('닫기', 'cta ghost', () => closeSheet()));
    } else if (seat.state !== 'available') {
      actions.append(actionButton(`${stateLabel}인 자리예요`, 'cta', () => {}, true));
    } else if (!state.user) {
      actions.append(actionButton('로그인하고 예약하기', 'cta', () => openLogin(seat.id)));
    } else if (mine) {
      actions.append(
        actionButton(`이미 ${mine.label} 좌석을 이용 중이에요`, 'cta', () => {}, true),
        el('p', 'note', '한 사람당 한 자리만 예약할 수 있어요'),
      );
    } else {
      parts.push(el('p', 'rules', '예약 후 정해진 시간 안에 자리에 앉아 [착석]을 눌러야 해요. 시간이 지나면 자동으로 취소돼요.'));
      actions.append(actionButton(
        `${seat.label} 예약하기`,
        'cta',
        async () => {
          const ok = await runAction(() => api.createReservation(seat.id), `${roomName(seat.room)} ${seat.label} 좌석이 예약되었습니다.`);
          if (ok) { closeSheet(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        },
        offline,
      ));
      if (offline) actions.append(el('p', 'form-error', '서버와 연결되지 않아 예약할 수 없습니다.'));
    }
    parts.push(actions);
    return parts;
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

  const onKeydown = (event) => { if (event.key === 'Escape' && sheetState.kind) closeSheet(); };
  document.addEventListener('keydown', onKeydown);
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });

  // ----- 실시간 갱신 -----
  const socket = new SeatSocket({
    onMessage: (msg) => { if (msg.type === 'seats.changed') loadSeats(); },
    onStatusChange: (connected) => {
      state.live = connected;
      liveBadge.textContent = connected ? '실시간' : '연결 끊김';
      liveBadge.className = `live ${connected ? 'is-online' : 'is-offline'}`;
      if (connected) loadSeats();
    },
  });
  socket.connect();
  const pollTimer = setInterval(() => { if (!state.live) loadSeats(); }, FALLBACK_POLL_MS);
  loadCentralLibrary();
  const centralTimer = setInterval(() => { if (!document.hidden) loadCentralLibrary(); }, CENTRAL_LIBRARY_POLL_MS);
  loadSystemStatus();
  const statusTimer = systemStatus ? setInterval(() => { if (!document.hidden) loadSystemStatus(); }, SYSTEM_STATUS_POLL_MS) : null;
  const countdownTimer = setInterval(updateCountdown, COUNTDOWN_TICK_MS);

  renderRoomHead();
  renderCentralExtras();
  renderPanel();
  restoreUser().then(() => { resetIdleTimer(); return loadSeats(); });

  return () => {
    socket.close();
    clearInterval(pollTimer);
    clearInterval(centralTimer);
    if (statusTimer) clearInterval(statusTimer);
    clearInterval(countdownTimer);
    clearTimeout(idleTimer);
    clearTimeout(toastTimer);
    activityEvents.forEach((name) => document.removeEventListener(name, resetIdleTimer));
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('scroll', onScroll);
  };
}
