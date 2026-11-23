/**
 * 개인 사용 모드 학생 화면 (#/personal) — 본인 휴대폰·모바일 앱용.
 *
 * 키오스크 모드(src/kiosk/)와 완전히 별개의 코드다 (처음엔 같은 화면을 복제해 시작했다).
 * 개인 특화 기능은 여기에만 둔다: 블루투스 좌석 자동 연장(웹 블루투스·앱 연동), 블루투스 착석 확인. 자동 로그아웃 없음.
 *
 * 블루투스 착석 확인: 장치가 있는 열람실(PRESENCE_ROOMS, 현재 A)의 예약은 열람실 장치와 블루투스로
 * 연결되어 거리 안에 있을 때만 [착석] 버튼이 눌린다. 화면에서만 막는 기능이다(서버는 확인하지 않음 —
 * 사용자 결정). 장치가 없는 열람실과 키오스크 모드 화면은 예외로 지금처럼 착석할 수 있다.
 * 서버 통신(api.js, websocket.js)만 src/common/ 의 공용 코드를 쓴다.
 */
import './style.css';
import { api, ApiError, session } from '../common/api.js';
import { SeatSocket } from '../common/websocket.js';
import { TEST_STUDENTS } from '../common/test-accounts.js';
import { MODES, MODE_LABELS, switchMode } from '../common/usage-mode.js';
import { createLoginForm } from './components/login-form.js';
import { createSeatMap } from './components/seat-map.js';
import { STATE_LABELS } from './components/seat-card.js';
import { createRoomTabs, roomPreference } from './components/room-tabs.js';
import { createCentralLibraryPanel, congestionLevel, createLevelPill, seatUsage } from './components/central-library.js';
import { createSystemStatusBar, SHOW_SYSTEM_STATUS } from './components/system-status.js';
import { createNearbyCard } from './components/nearby-card.js';
import { IN_APP, PRESENCE_ROOMS, onAppPresence, postToApp } from './app-bridge.js';
import { createWebBlePresence, webBleSupport } from './web-ble.js';
import { createStudyStatsPanel } from '../common/study-stats.js';
import { createPopup } from '../common/popup.js';
import {
  notifySupport, notifyPermission, notifyEnabled, enableNotify, disableNotify, browserNotify, warmUpNotify,
} from '../common/browser-notify.js';
import {
  mineSnapshot, detectChange, dueWarning, reservedAlert, checkedInAlert, checkedOutAlert, cancelledAlert,
  remoteCheckInAlert, endedAlert,
} from '../common/seat-alerts.js';

/** 앱 모드: 재실 확인을 서버에 보내는 최소 간격 (서버는 남은 시간을 2시간으로 유지) */
const PRESENCE_REPORT_MS = 60_000;

const SYSTEM_STATUS_POLL_MS = 15_000;

const CENTRAL_LIBRARY_POLL_MS = 30_000;

const ROOM_PREF_KEY = 'library.kiosk.room';

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
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 이용 시간 선택지 (서버 규칙: 1~4시간) */
const USAGE_HOUR_CHOICES = [1, 2, 3, 4];
const USAGE_URGENT_MS = 10 * 60_000;     // 이용 종료 10분 전부터 강조
const EXPIRED_RELOAD_MS = 20_000;        // 종료 시각이 지난 뒤 서버 자동 퇴실(1분 주기)을 기다리며 다시 조회

/** 개인 사용 모드 학생 화면 */
export function renderPersonalHome(root) {
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
  // 강의실 위치(호수): 관리자가 입력한 값. 비어 있으면 표시하지 않는다.
  const roomPlace = (code) => String(state.rooms.find((r) => r.code === code)?.location ?? '').trim();
  const roomWithPlace = (code, sep = ' · ') => (roomPlace(code) ? `${roomName(code)}${sep}${roomPlace(code)}` : roomName(code));
  const seatsInRoom = () => state.seats.filter((s) => s.room === state.room);
  const mySeat = () => state.seats.find((s) => s.mine);

  // ----- 레이아웃: 상단 바 -----
  const header = el('header', 'topbar');
  const logo = el('img', 'logo');
  logo.src = '/kgu-logo.png'; // 경기대학교 로고 (web/kiosk/public/kgu-logo.png)
  logo.alt = '경기대학교';
  logo.decoding = 'async';
  const brand = el('div', 'brand', '열람실 좌석');
  brand.append(el('small', null, '열람실 A·B·C 실시간 현황'));
  const liveBadge = el('span', 'live is-offline', '연결 중');
  const userBox = el('div', 'user-box');

  // 사용 모드 토글: 이 화면은 개인 사용. [키오스크]를 누르면 키오스크 화면(#/kiosk)으로 이동한다. 앱에서는 숨김.
  const usageMode = 'personal';
  const modeToggle = el('div', 'mode-toggle');
  modeToggle.setAttribute('role', 'radiogroup');
  modeToggle.setAttribute('aria-label', '화면 선택: 개인 사용 · 키오스크 · 관리자');
  modeToggle.hidden = IN_APP;
  const modeButtons = {};
  for (const mode of MODES) {
    const b = el('button', null, MODE_LABELS[mode]);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.title = mode === 'personal' ? '본인 휴대폰: 블루투스 자동 연장 등 개인 기능 사용' : '입구의 공용 기기: 개인 기능 숨김';
    b.addEventListener('click', () => { if (mode !== usageMode) switchMode(mode); });
    modeButtons[mode] = b;
    modeToggle.append(b);
  }
  // 세 번째 칸: 관리자 화면 (예전에는 화면 맨 아래 링크였음). 관리자 화면은 별도 코드로 새로 열린다.
  const adminButton = el('button', null, '관리자');
  adminButton.type = 'button';
  adminButton.setAttribute('role', 'radio');
  adminButton.setAttribute('aria-checked', 'false');
  adminButton.title = '관리자 화면 (관리자 로그인 필요)';
  adminButton.addEventListener('click', () => { location.hash = '#/admin'; });
  modeToggle.append(adminButton);
  function renderModeToggle() {
    for (const [mode, b] of Object.entries(modeButtons)) {
      b.classList.toggle('on', mode === usageMode);
      b.setAttribute('aria-checked', String(mode === usageMode));
    }
  }
  renderModeToggle();
  header.append(logo, brand, modeToggle, liveBadge, userBox);

  // 알림 메시지 (토스트)
  const message = el('div', 'toast');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');

  // ----- 좌석 탭 -----
  const seatsView = el('main', 'view page view-seats');
  const hero = el('section', 'hero-slot');
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

  const centralLibrary = createCentralLibraryPanel();

  const systemStatus = SHOW_SYSTEM_STATUS ? createSystemStatusBar() : null;

  // 서버 상태 점검 (VITE_SHOW_SYSTEM_STATUS=true 일 때만): 화면 맨 아래 버튼. 기본은 숨김,
  // 누르면 상태 표시줄을 보여 주고 그동안만 15초마다 갱신한다 (닫혀 있을 때는 서버에 묻지 않음).
  const statusButton = systemStatus ? el('button', 'status-toggle', '서버 상태 점검') : null;
  let statusOpen = false;
  let statusTimer = null;
  if (systemStatus) {
    statusButton.type = 'button';
    statusButton.setAttribute('aria-expanded', 'false');
    systemStatus.element.hidden = true;
    statusButton.addEventListener('click', () => setStatusOpen(!statusOpen));
    footer.append(statusButton, systemStatus.element);
  }
  function setStatusOpen(open) {
    if (!systemStatus) return;
    statusOpen = open;
    systemStatus.element.hidden = !open;
    statusButton.textContent = open ? '서버 상태 점검 닫기' : '서버 상태 점검';
    statusButton.setAttribute('aria-expanded', String(open));
    clearInterval(statusTimer);
    statusTimer = null;
    if (open) {
      loadSystemStatus();
      statusTimer = setInterval(() => { if (!document.hidden) loadSystemStatus(); }, SYSTEM_STATUS_POLL_MS);
      systemStatus.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // 가까운 열람실 (개인 사용 화면 전용): 버튼을 누르면 위치를 묻고 A·B·C·중앙도서관 중 가까운 곳을 안내
  const nearbyCard = createNearbyCard({
    onShowRoom: (code) => {
      setTab('seats');
      selectRoom(code);
      mapSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    onShowCentral: () => setTab('central'),
  });

  seatsView.append(hero, nearbyCard.element, mapSection, miniCard, footer);

  // ----- 중앙도서관 탭 -----
  const centralView = el('main', 'view page view-central');
  centralView.hidden = true;
  const centralHead = el('div');
  centralHead.append(el('div', 'sec-title', '중앙도서관 혼잡도'), el('div', 'sec-sub', '경기대 도서관 좌석 현황을 30초마다 받아와요'));
  const tip = el('button', 'tip');
  tip.type = 'button';
  tip.hidden = true;
  tip.addEventListener('click', () => {
    if (tip.dataset.room) selectRoom(tip.dataset.room);
    setTab('seats');
  });
  centralView.append(centralHead, tip, centralLibrary.element);

  // ----- 내 이용 탭 -----
  const meView = el('main', 'view page view-me');
  meView.hidden = true;
  const meHead = el('div');
  const meSub = el('div', 'sec-sub');
  meHead.append(el('div', 'sec-title', '내 이용'), meSub);
  const meBody = el('div', 'stack');
  meView.append(meHead, meBody);
  // 공부 기록(총 공부 시간·최근 7일·이용 기록). 401 이면 로그아웃
  const studyPanel = createStudyStatsPanel({ onAuthError: () => logout(false) });
  let studyDirty = true; // 착석·퇴실 등으로 기록이 바뀌어 다시 불러와야 함

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

  // 주요 동작 알림 팝업 (+ 다른 화면을 보고 있으면 브라우저 알림)
  const popup = createPopup();
  root.append(header, seatsView, centralView, meView, tabbar, scrim, sheet, message, popup.element);

  /** 팝업을 띄우고, 이 화면을 보고 있지 않으면 브라우저 알림도 보낸다 */
  function announce(item) {
    popup.show(item);
    browserNotify(item);
  }

  // 서버(또는 다른 기기)가 바꾼 내 좌석 상태 감지용
  let prevMine = null;          // 직전 조회의 내 좌석
  let alertsReady = false;      // 로그인 후 첫 조회는 기준값만 잡는다 (화면을 열자마자 옛 변화로 팝업 X)
  const handled = new Map();    // 예약 id → 'occupied' | 'ended' (이 화면에서 직접 했거나 이미 알린 변화)
  const firedWarnings = new Set();

  function resetAlerts() {
    prevMine = null;
    alertsReady = false;
    handled.clear();
    firedWarnings.clear();
    popup.clear();
  }

  /** 좌석을 다시 불러올 때마다: 이전과 비교해 서버가 바꾼 변화를 알린다 */
  function checkSeatChange() {
    if (!state.user) { prevMine = null; alertsReady = false; return; }
    const next = mineSnapshot(mySeat());
    const change = alertsReady ? detectChange(prevMine, next, handled) : null;
    prevMine = next;
    alertsReady = true;
    if (!change) return;
    const snap = change.snap;
    if (change.type === 'checked_in') {
      handled.set(snap.id, 'occupied');
      announce(remoteCheckInAlert(snap, roomName(snap.room)));
      return;
    }
    handled.set(snap.id, 'ended');
    // 끝난 이유(미착석 자동 취소·시간 종료·관리자 해제 …)는 이용 기록에서 확인한다
    api.myHistory(5)
      .then((res) => res?.history?.find((h) => h.id === snap.id)?.end_reason ?? null)
      .catch(() => null)
      .then((reason) => { if (state.user) announce(endedAlert(snap, roomName(snap.room), reason)); });
  }

  /** 1초마다: 착석 마감 5분 전 · 이용 종료 10분 전 경고 */
  function checkWarnings() {
    if (!state.user) return;
    const mine = mySeat();
    const warning = dueWarning(mineSnapshot(mine), Date.now(), firedWarnings, {
      roomName: mine ? roomName(mine.room) : '',
      presenceRoom: Boolean(mine && PRESENCE_ROOMS.includes(mine.room)),
    });
    if (!warning) return;
    firedWarnings.add(warning.key);
    announce(warning);
  }

  /** 예약 완료 팝업의 [알림 받기] (아직 브라우저 알림을 켜지 않았을 때만) */
  function notifyOffer() {
    if (notifySupport() !== 'ok' || notifyEnabled() || notifyPermission() === 'denied') return undefined;
    return { label: '알림 받기', run: turnOnNotify };
  }

  async function turnOnNotify() {
    const result = await enableNotify();
    if (result === 'granted') showMessage('브라우저 알림을 켰어요. 다른 화면을 보고 있어도 알려 드려요.', 'success');
    else if (result === 'denied') showMessage('알림이 차단되어 있어요. 브라우저 사이트 설정에서 알림을 허용해 주세요.', 'error');
    else if (result === 'failed') showMessage('알림을 보내지 못했어요. 브라우저 설정을 확인해 주세요.', 'error');
    renderMe();
  }

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
    seatMap.update(seatsInRoom(), state.rooms.find((r) => r.code === state.room)?.layout ?? null); // 관리자가 저장한 배치
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
      checkSeatChange();
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
    studyPanel.clear();
    studyDirty = true;
    resetAlerts();
    seatMap.setSelected(null);
    closeSheet();
    setTab('seats');
    renderUserBox();
    await loadSeats();
  }

  /**
   * @param {() => Promise<any>} action
   * @param {string | ((data: any) => object)} success 문자열이면 짧은 안내(토스트), 함수면 응답으로 만든 팝업
   * @param {{ expect?: [number, 'occupied' | 'ended'] }} [options] 이 동작으로 바뀔 내 예약 (서버 변화 팝업과 겹치지 않게)
   * @returns {Promise<boolean>} 서버가 요청을 성공 처리했는지
   */
  async function runAction(action, success, { expect } = {}) {
    if (state.busy) return false;
    state.busy = true;
    renderPanel();
    let ok = false;
    // 실시간 갱신이 응답보다 먼저 올 수 있으므로 요청 전에 표시해 둔다
    const hadExpect = expect ? handled.get(expect[0]) : undefined;
    if (expect) handled.set(expect[0], expect[1]);
    try {
      const data = await action();
      ok = true;
      studyDirty = true;
      if (typeof success === 'function') announce(success(data));
      else showMessage(success, 'success');
    } catch (err) {
      if (expect) { if (hadExpect === undefined) handled.delete(expect[0]); else handled.set(expect[0], hadExpect); }
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
    notifyApp();
    syncWebBle();
  }

  // ----- 앱 모드: 블루투스 재실 확인 -----
  let lastPresenceReport = 0;
  let presenceInFlight = false;

  /** 블루투스가 필요한 상태: 장치가 있는 열람실에서 예약 중(착석 확인) 또는 이용 중(자동 연장) */
  function wantsBle(mine) {
    return Boolean(state.user && mine && (mine.state === 'occupied' || mine.state === 'reserved') && PRESENCE_ROOMS.includes(mine.room));
  }

  /**
   * 블루투스 착석 확인 (화면 전용). 장치가 없는 열람실은 확인 없이 착석할 수 있다.
   * @returns {{ needed: boolean, ok: boolean }}
   */
  function checkInGate(mine) {
    const needed = Boolean(mine && PRESENCE_ROOMS.includes(mine.room));
    return { needed, ok: !needed || state.appPresence?.inRange === true };
  }

  /** 앱이 블루투스를 켜야 하는지 판단할 정보만 보낸다 (토큰·학번은 보내지 않음) */
  function notifyApp() {
    if (!IN_APP) return;
    const mine = mySeat();
    postToApp({
      type: 'state',
      loggedIn: Boolean(state.user),
      seat: mine ? { room: mine.room, state: mine.state, usage_ends_at: mine.usage_ends_at ?? null } : null,
      // 이용 중(자동 연장) 또는 예약 중(블루투스 착석 확인)일 때 블루투스를 켠다
      presenceWanted: wantsBle(mine),
    });
  }

  async function maybeReportPresence() {
    const p = state.appPresence;
    const mine = mySeat();
    if (!p?.inRange || !state.user || !mine || mine.state !== 'occupied' || !PRESENCE_ROOMS.includes(mine.room)) return;
    if (presenceInFlight || Date.now() - lastPresenceReport < PRESENCE_REPORT_MS) return;
    presenceInFlight = true;
    lastPresenceReport = Date.now();
    try {
      const res = await api.presence();
      state.lastPresenceOk = Date.now();
      if (res?.extended) await loadSeats(); // 남은 시간 표시를 서버 값으로 갱신
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) await logout(false);
      // 409(이용 중 아님) 등은 다음 좌석 갱신 때 자연히 정리된다
    } finally {
      presenceInFlight = false;
    }
  }

  if (IN_APP) {
    document.body.classList.add('app-mode');
    onAppPresence((p) => {
      state.appPresence = p;
      renderHero();
      if (sheetState.kind === 'hours') renderSheet(); // 착석 버튼 활성/비활성
      maybeReportPresence();
    });
  }

  // ----- 모바일 웹: 브라우저 블루투스(Web Bluetooth)로 재실 확인 -----
  // 앱이 아닐 때만. 앱과 같은 상태 모양을 state.appPresence 에 넣어 같은 보고 경로(maybeReportPresence)를 쓴다.
  const WEB_BLE_SUPPORT = IN_APP ? 'app' : webBleSupport();
  const webBle = WEB_BLE_SUPPORT === 'ok'
    ? createWebBlePresence({
      onChange: (p) => {
        state.appPresence = p.status === 'idle' ? null : p;
        renderHero();
        if (sheetState.kind === 'hours') renderSheet(); // 착석 버튼 활성/비활성
        maybeReportPresence();
      },
    })
    : null;
  let webBleResumeTried = false;

  /** 열람실 A 에서 예약 중(착석 확인)·이용 중(자동 연장)일 때만 블루투스를 유지한다. 퇴실·취소·로그아웃하면 끊는다. */
  function syncWebBle() {
    if (!webBle) return;
    const mine = mySeat();
    const wanted = wantsBle(mine);
    if (!wanted) {
      if (webBle.active || state.appPresence) { webBle.stop(); state.appPresence = null; }
      return;
    }
    if (!webBleResumeTried) {
      webBleResumeTried = true;
      webBle.resume(); // 이미 허락한 기기면 선택 창 없이 다시 연결 (지원 브라우저만)
    }
  }

  /** @param {boolean} reserved 예약 중(착석 전)이면 착석 확인 문구 */
  function webPresenceBox(reserved = false) {
    const p = state.appPresence;
    const box = el('div', 'presence-web');
    const on = (text, cls = '') => box.append(el('span', `chip-glass ${cls}`.trim(), text));
    const btn = (text, onClick, cls = 'presence-btn') => {
      const b = el('button', cls, text);
      b.type = 'button';
      b.addEventListener('click', onClick);
      box.append(b);
    };
    const status = p?.status ?? 'idle';
    if (status === 'connected' && p.inRange) {
      on(reserved ? '📶 열람실 안에 있어요 · 착석할 수 있어요' : '📶 블루투스로 자리 확인됨 · 남은 시간이 2시간 아래로 줄지 않아요', 'presence-ok');
      if (!reserved) btn('끄기', () => webBle.stop(), 'presence-btn presence-btn-ghost'); // 착석 전에 끄면 착석할 수 없다
    } else if (status === 'connected') {
      on('📶 열람실 장치 응답 확인 중…', 'presence-weak');
    } else if (status === 'choosing' || status === 'connecting') {
      on('📶 열람실 장치에 연결하는 중…');
    } else if (status === 'reconnecting') {
      on(`📶 ${p.reason || '다시 연결하는 중'}${reserved ? '' : ' · 시간이 줄어들고 있어요'}`, 'presence-weak');
    } else {
      on(p?.reason ? `📵 ${p.reason}` : reserved
        ? '📵 착석하려면 열람실 안에서 블루투스로 열람실 장치에 연결하세요'
        : '📵 블루투스로 자리를 확인하면 자리에 있는 동안 자동 연장돼요', 'presence-off');
      btn(reserved ? '블루투스로 착석 확인 켜기' : '블루투스로 자리 확인 켜기', () => webBle.start());
    }
    box.append(el('span', 'presence-note', '화면을 켜 둔 동안 동작해요 · 열람실 장치(LIB-SEAT-PI)를 선택하세요'));
    return box;
  }

  /** 상태 카드 안의 블루투스 안내 (장치가 있는 열람실에서 예약 중·이용 중일 때만) */
  function presenceChip(mine) {
    if (!PRESENCE_ROOMS.includes(mine.room)) return null;
    const reserved = mine.state === 'reserved';
    if (!IN_APP) {
      if (webBle) return webPresenceBox(reserved);
      const why = WEB_BLE_SUPPORT === 'insecure' ? '' : ' (이 브라우저는 블루투스를 지원하지 않아요 · Android Chrome 에서 가능)';
      if (reserved) return el('span', 'chip-glass presence-off', `📵 이 화면에서는 착석 확인을 할 수 없어요${why}. 모바일 앱이나 입구 키오스크에서 착석하세요.`);
      return el('span', 'chip-glass', `📱 모바일 앱을 켜 두면 자리에 있는 동안 자동 연장돼요${why}`);
    }
    const p = state.appPresence;
    if (!p) return el('span', 'chip-glass', '📶 블루투스 확인 준비 중…');
    if (reserved) {
      if (p.inRange) return el('span', 'chip-glass presence-ok', `📶 열람실 안에 있어요${p.rssi != null ? ` (${p.rssi} dBm)` : ''} · 착석할 수 있어요`);
      if (p.piConnected) return el('span', 'chip-glass presence-weak', `📶 신호 약함${p.rssi != null ? ` (${p.rssi} dBm)` : ''} · 자리에 더 가까이 가면 착석할 수 있어요`);
      return el('span', 'chip-glass presence-off', '📵 열람실 장치를 찾는 중 · 열람실 안에서 착석할 수 있어요');
    }
    if (p.inRange) return el('span', 'chip-glass presence-ok', `📶 자리 확인됨${p.rssi != null ? ` (${p.rssi} dBm)` : ''} · 남은 시간이 2시간 아래로 줄지 않아요`);
    if (p.piConnected) return el('span', 'chip-glass presence-weak', `📶 신호 약함${p.rssi != null ? ` (${p.rssi} dBm)` : ''} · 시간이 줄어들고 있어요`);
    // 자세한 이유(권한·검색 실패 등)는 앱 상단 바에 표시된다
    return el('span', 'chip-glass presence-off', '📵 블루투스로 자리 확인 안 됨 · 시간이 줄어들고 있어요');
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
      success: () => cancelledAlert({ label: mine.label, roomName: roomName(mine.room) }),
      expect: [mine.reservation_id, 'ended'],
    });
  }

  function confirmCheckOut(mine) {
    openConfirm({
      reservationId: mine.reservation_id,
      title: '퇴실할까요?',
      desc: '퇴실하면 자리가 바로 다른 사람에게 돌아가요.',
      confirmText: '퇴실하기',
      run: () => api.checkOut(mine.reservation_id),
      success: () => checkedOutAlert({ label: mine.label, roomName: roomName(mine.room) }),
      expect: [mine.reservation_id, 'ended'],
    });
  }

  // ----- 남은 시간 표시 (표시 전용: 만료·자동 퇴실 판단은 서버가 한다) -----
  /** @type {Set<{node: HTMLElement, target: number, urgentMs: number}>} */
  const liveCountdowns = new Set();
  let lastExpiredReload = 0;

  function liveCountdown(targetIso, tag, className, urgentMs) {
    const target = Date.parse(targetIso ?? '');
    const node = el(tag, className, formatLeft(target - Date.now()));
    node.setAttribute('aria-hidden', 'true'); // 1초마다 바뀌는 숫자를 화면 낭독기가 읽지 않도록
    liveCountdowns.add({ node, target, urgentMs });
    return node;
  }

  function renderHero() {
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
        left.append(el('div', 'k', `예약 완료 · ${roomWithPlace(mine.room, ' ')}`), el('div', 'v', `${mine.label} 좌석`));
        const right = el('div', 'right');
        right.append(el('div', 'k', '착석까지'), liveCountdown(mine.expires_at, 'div', 'countdown', URGENT_MS));
        top.append(left, right);
        box.append(top, el('div', 'd', `${formatTime(mine.expires_at)}까지 착석하지 않으면 예약이 자동 취소됩니다.`));
        const chip = presenceChip(mine); // 블루투스 착석 확인 (장치가 있는 열람실만)
        if (chip) box.append(chip);
        const gate = checkInGate(mine);
        const checkIn = actionButton(gate.ok ? '착석했어요' : '열람실 안에서 착석', 'hbtn w', () => openHours(mine), !gate.ok);
        if (!gate.ok) checkIn.title = '열람실 장치와 블루투스로 연결되어 거리 안에 있어야 착석할 수 있어요';
        btns.append(
          checkIn,
          actionButton('예약 취소', 'hbtn g', () => confirmCancel(mine)),
        );
      } else if (mine.state === 'occupied') {
        left.append(el('div', 'k', `이용 중 · ${roomName(mine.room)}`), el('div', 'v', `${mine.label} 좌석`));
        top.append(left);
        if (mine.usage_ends_at) {
          const right = el('div', 'right');
          right.append(el('div', 'k', '남은 이용 시간'), liveCountdown(mine.usage_ends_at, 'div', 'countdown', USAGE_URGENT_MS));
          top.append(right);
          box.append(top, el('div', 'd', `${formatTime(mine.usage_ends_at)}까지 이용할 수 있어요. 시간이 끝나면 자동으로 퇴실돼요.`));
          const chip = presenceChip(mine);
          if (chip) box.append(chip);
        } else {
          box.append(top, el('div', 'd', '공부를 마치면 꼭 [퇴실]을 눌러 주세요. 다음 사람에게 바로 자리가 돌아가요.'));
        }
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
    checkWarnings();
    let anyExpired = false;
    for (const c of liveCountdowns) {
      if (!c.node.isConnected) { liveCountdowns.delete(c); continue; }
      const left = c.target - Date.now();
      c.node.textContent = formatLeft(left);
      c.node.classList.toggle('is-urgent', left < c.urgentMs);
      if (left <= 0) anyExpired = true;
    }
    // 만료·자동 퇴실은 서버가 처리한다(1분 주기). 화면은 시간이 지나면 서버 상태를 다시 조회할 뿐이다.
    if (anyExpired && Date.now() - lastExpiredReload > EXPIRED_RELOAD_MS) {
      lastExpiredReload = Date.now();
      loadSeats();
    }
  }

  function renderRoomHead() {
    const room = state.rooms.find((r) => r.code === state.room);
    roomTitle.textContent = roomPlace(state.room) || roomName(state.room); // 시안: 열람실 탭 아래에 강의실 호수
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
    // 가까운 열람실 카드: 열람실 빈자리·위치 + 중앙도서관(수원) 빈자리
    nearbyCard.update(state.rooms, campuses.find((c) => c.id === 1) ?? null);

    miniButton.replaceChildren();
    const ic = el('span', 'ic', '📚');
    ic.setAttribute('aria-hidden', 'true');
    const text = el('span');
    if (main) {
      const level = congestionLevel(seatUsage(main).used, seatUsage(main).usable);
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
    const crowded = congestionLevel(seatUsage(main).used, seatUsage(main).usable) === 'bad';
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
  /** 내 이용 탭: 브라우저 알림 켜기/끄기 */
  function notifyCard() {
    const card = el('section', 'card notify-card');
    card.append(el('div', 'card-title', '알림'));
    const support = notifySupport();
    const note = (text) => card.append(el('p', 'note', text));
    if (support === 'app') {
      note('예약·착석·자동 취소·이용 종료는 화면 팝업으로 알려 드려요. (앱 알림은 아직 지원하지 않아요)');
      return card;
    }
    if (support !== 'ok') {
      note('이 브라우저는 알림을 지원하지 않아요. 화면 팝업으로 알려 드려요. (Android Chrome·PC 브라우저에서 가능)');
      return card;
    }
    const permission = notifyPermission();
    if (notifyEnabled()) {
      note('브라우저 알림 켜짐 · 다른 탭이나 앱을 보고 있을 때 예약·착석·자동 취소·이용 종료를 알려 드려요. 이 화면이 열려 있는 동안만 동작해요.');
      card.append(actionButton('브라우저 알림 끄기', 'cta ghost', () => { disableNotify(); renderMe(); }));
    } else if (permission === 'denied') {
      note('알림이 차단되어 있어요. 주소창 옆 사이트 설정에서 알림을 허용한 뒤 다시 눌러 주세요.');
      card.append(actionButton('다시 시도', 'cta ghost', turnOnNotify));
    } else {
      note('켜 두면 다른 탭이나 앱을 보고 있을 때도 착석 마감 5분 전, 이용 종료 10분 전, 자동 취소·퇴실을 알려 드려요.');
      card.append(actionButton('브라우저 알림 켜기', 'cta', turnOnNotify));
    }
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
      if (mine.state === 'occupied' && mine.usage_ends_at) {
        const left = el('p', 'my-left');
        left.append('남은 이용 시간 ', liveCountdown(mine.usage_ends_at, 'b', 'inline-countdown', USAGE_URGENT_MS),
          ` · ${formatTime(mine.usage_ends_at)}까지`);
        now.append(left, el('p', 'note', '시간이 끝나면 자동으로 퇴실돼요.'));
      }
      now.append(actionButton('내 자리 보기', 'cta ghost', () => showMySeatOnMap(mine)));
    } else {
      now.append(el('p', 'note', '이용 중인 좌석이 없어요. 좌석 탭에서 예약할 수 있어요.'));
    }

    meBody.append(
      now,
      notifyCard(),
      studyPanel.element, // 같은 요소를 다시 붙인다 (다시 그려도 불러온 기록 유지)
      actionButton('로그아웃', 'cta ghost', () => logout(true)),
    );
    if (state.tab === 'me') { studyPanel.load(studyDirty); studyDirty = false; }
  }

  // ----- 탭 전환 -----
  function setTab(tab) {
    if (state.tab !== tab) closeSheet();
    state.tab = tab;
    seatsView.hidden = tab !== 'seats';
    centralView.hidden = tab !== 'central';
    meView.hidden = tab !== 'me';
    if (tab === 'me' && state.user) { studyPanel.load(studyDirty); studyDirty = false; }
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

  /** 착석 시 이용 시간 선택 (1~4시간) */
  function openHours(mine) {
    openSheet({ kind: 'hours', confirm: { reservationId: mine.reservation_id } });
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
    if (sheetState.kind === 'hours') {
      const c = sheetState.confirm;
      const mine = mySeat();
      if (!state.user || mine?.reservation_id !== c.reservationId || mine.state !== 'reserved') { closeSheet(); return; }
      const title = el('div', 'sh-title');
      title.append(el('b', 'small', '몇 시간 이용할까요?'));
      const gate = checkInGate(mine);
      const grid = el('div', 'hours-grid');
      for (const h of USAGE_HOUR_CHOICES) {
        grid.append(actionButton(`${h}시간`, 'cta', async () => {
          // 누르는 순간에도 다시 확인 (그사이 블루투스가 끊겼을 수 있음)
          if (!checkInGate(mySeat()).ok) {
            showMessage('열람실 장치와 블루투스 연결이 끊겼어요. 열람실 안에서 다시 시도하세요.', 'error');
            renderSheet();
            return;
          }
          const ok = await runAction(
            () => api.checkIn(c.reservationId, h),
            (data) => checkedInAlert({ label: mine.label, roomName: roomName(mine.room), hours: h, usageEndsAt: data?.reservation?.usage_ends_at }),
            { expect: [c.reservationId, 'occupied'] },
          );
          if (ok) closeSheet();
        }, !gate.ok));
      }
      const actions = el('div', 'actions');
      actions.append(actionButton('돌아가기', 'cta ghost', () => closeSheet()));
      sheetBody.replaceChildren(
        title,
        el('div', 'sh-sub', `${roomName(mine.room)} ${mine.label} 좌석 · 시간이 끝나면 자동으로 퇴실돼요. [퇴실]로 언제든 먼저 끝낼 수 있어요.`),
        grid,
        ...(gate.ok ? [] : [el('p', 'form-error', '블루투스로 열람실 안에 있는 것이 확인되어야 착석할 수 있어요.')]),
        actions,
      );
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
          await runAction(c.run, c.success, { expect: c.expect });
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
    const parts = [title, el('div', 'sh-sub', roomWithPlace(seat.room)), tags];
    if (seat.state === 'occupied' && seat.usage_ends_at) {
      const left = el('p', 'seat-left');
      left.append('남은 이용 시간 ', liveCountdown(seat.usage_ends_at, 'b', 'inline-countdown', USAGE_URGENT_MS),
        ` · ${formatTime(seat.usage_ends_at)}까지`);
      parts.push(left);
    }

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
          const ok = await runAction(
            () => api.createReservation(seat.id),
            (data) => ({
              ...reservedAlert({ label: seat.label, roomName: roomName(seat.room), expiresAt: data?.reservation?.expires_at }),
              action: notifyOffer(),
            }),
          );
          if (ok) { closeSheet(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        },
        offline,
      ));
      if (offline) actions.append(el('p', 'form-error', '서버와 연결되지 않아 예약할 수 없습니다.'));
    }
    parts.push(actions);
    return parts;
  }

  // 개인 사용 모드: 자동 로그아웃 없음 (본인 휴대폰)

  const onKeydown = (event) => { if (event.key === 'Escape' && sheetState.kind) closeSheet(); };
  document.addEventListener('keydown', onKeydown);
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  // 화면으로 돌아오면 블루투스 확인을 바로 한 번
  const onVisible = () => { if (!document.hidden) webBle?.pingNow(); };
  document.addEventListener('visibilitychange', onVisible);

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
  const countdownTimer = setInterval(updateCountdown, COUNTDOWN_TICK_MS);

  renderRoomHead();
  renderCentralExtras();
  renderPanel();
  warmUpNotify();
  restoreUser().then(() => loadSeats());

  return () => {
    socket.close();
    clearInterval(pollTimer);
    clearInterval(centralTimer);
    if (statusTimer) clearInterval(statusTimer);
    clearInterval(countdownTimer);
    clearTimeout(toastTimer);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisible);
    webBle?.stop();
  };
}
