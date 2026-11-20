/**
 * 내 공부 기록 패널 — "내 이용" 탭 (개인 사용 · 키오스크 화면 공용).
 *
 * 총 공부 시간 · 오늘 · 최근 7일 · 연속 공부일, 최근 7일 막대 그래프, 자주 앉는 자리, 이용 기록(더 보기).
 * 숫자는 모두 서버(GET /reservations/me/stats, /history)가 계산한 값이다. 날짜는 한국 시간으로 표시한다.
 * 사용자 데이터는 textContent 로만 넣는다.
 */
import './study-stats.css';
import { api } from './api.js';
import { formatMinutes, shortMinutes, dayLabel, historyStatusLabel } from './study-format.js';

export { formatMinutes, shortMinutes, dayLabel, historyStatusLabel };

const TZ = 'Asia/Seoul';
const HISTORY_PAGE = 10;
const STALE_MS = 30_000; // 탭을 다시 열었을 때 이보다 오래된 값이면 다시 불러온다

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmtDate(iso) {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return '';
  const md = d.toLocaleDateString('ko-KR', { timeZone: TZ, month: 'numeric', day: 'numeric' });
  const wd = d.toLocaleDateString('ko-KR', { timeZone: TZ, weekday: 'short' });
  return `${md}(${wd})`;
}

function fmtTime(iso) {
  const d = new Date(iso ?? '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * @param {{ onAuthError?: (err: Error) => void }} [options] 401 이면 호출 (로그아웃 처리용)
 */
export function createStudyStatsPanel({ onAuthError } = {}) {
  const element = el('div', 'study stack');
  let stats = null;
  let history = [];
  let nextBeforeId = null;
  let loadedAt = 0;
  let loading = false;
  let failed = false;
  let generation = 0; // 로그아웃 뒤 늦게 온 응답을 버리기 위한 번호

  function tile(label, value, sub) {
    const t = el('div', 'study-tile');
    t.append(el('div', 'k', label), el('div', 'v', value));
    if (sub) t.append(el('div', 's', sub));
    return t;
  }

  function renderTiles() {
    const grid = el('div', 'study-tiles');
    if (!stats) {
      for (const label of ['총 공부 시간', '오늘', '최근 7일', '연속 공부']) grid.append(tile(label, loading ? '…' : '—'));
      return grid;
    }
    grid.append(
      tile('총 공부 시간', formatMinutes(stats.total_study_minutes), `이용 ${stats.sessions}회`),
      tile('오늘', formatMinutes(stats.today_minutes)),
      tile('최근 7일', formatMinutes(stats.week_minutes)),
      tile('연속 공부', `${stats.streak_days}일`, `공부한 날 ${stats.study_days}일`),
    );
    return grid;
  }

  function renderChart() {
    const card = el('section', 'card study-chart-card');
    card.append(el('div', 'card-title', '최근 7일 공부 시간'));
    const days = stats?.daily ?? [];
    if (!days.length) {
      card.append(el('p', 'note', loading ? '불러오는 중…' : '기록이 없어요.'));
      return card;
    }
    const max = Math.max(60, ...days.map((d) => d.minutes));
    const peak = Math.max(...days.map((d) => d.minutes));
    const readout = el('div', 'study-readout');
    readout.setAttribute('aria-live', 'polite');
    const defaultText = `최근 7일 합계 ${formatMinutes(stats.week_minutes)} · 막대를 누르면 날짜별 시간이 보여요`;
    readout.textContent = defaultText;

    const chart = el('div', 'study-chart');
    chart.setAttribute('role', 'list');
    chart.setAttribute('aria-label', '최근 7일 날짜별 공부 시간');
    days.forEach((d, i) => {
      const { md, wd } = dayLabel(d.date);
      const isToday = i === days.length - 1;
      const col = el('button', `study-col${isToday ? ' is-today' : ''}`);
      col.type = 'button';
      col.setAttribute('role', 'listitem');
      const text = `${md}(${wd})${isToday ? ' 오늘' : ''} · ${formatMinutes(d.minutes)}`;
      col.setAttribute('aria-label', text);
      const track = el('span', 'study-track');
      const bar = el('span', 'study-bar');
      bar.style.height = d.minutes > 0 ? `${Math.max(4, (d.minutes / max) * 100)}%` : '0';
      // 값 표시는 가장 많이 한 날과 오늘에만 (모든 막대에 숫자를 달지 않는다)
      if (d.minutes > 0 && (isToday || d.minutes === peak)) track.append(el('span', 'study-val', shortMinutes(d.minutes)));
      track.append(bar);
      col.append(track, el('span', 'study-day', isToday ? '오늘' : wd));
      const show = () => { readout.textContent = text; col.classList.add('is-active'); };
      const hide = () => { readout.textContent = defaultText; col.classList.remove('is-active'); };
      col.addEventListener('pointerenter', show);
      col.addEventListener('pointerleave', hide);
      col.addEventListener('focus', show);
      col.addEventListener('blur', hide);
      col.addEventListener('click', show);
      chart.append(col);
    });
    card.append(readout, chart);
    return card;
  }

  function renderDetails() {
    const card = el('section', 'card');
    card.append(el('div', 'card-title', '나의 이용 습관'));
    if (!stats) {
      card.append(el('p', 'note', loading ? '불러오는 중…' : '—'));
      return card;
    }
    const list = el('dl', 'study-facts');
    const fact = (k, v) => { list.append(el('dt', null, k), el('dd', null, v)); };
    const fav = stats.favorite_seat;
    fact('자주 앉는 자리', fav ? `${fav.label} (${fav.count}회)` : '아직 없어요');
    fact('평균 이용 시간', stats.sessions ? formatMinutes(stats.average_session_minutes) : '—');
    fact('가장 오래 이용', stats.sessions ? formatMinutes(stats.longest_session_minutes) : '—');
    fact('예약 횟수', `${stats.reservations}회`);
    fact('미착석 자동 취소', `${stats.no_shows}회`);
    card.append(list);
    return card;
  }

  function renderHistory() {
    const card = el('section', 'card');
    card.append(el('div', 'card-title', '최근 이용 기록'));
    if (!history.length) {
      card.append(el('p', 'note', loading ? '불러오는 중…' : '아직 이용 기록이 없어요.'));
      return card;
    }
    const list = el('ul', 'study-history');
    for (const item of history) {
      const li = el('li', `study-h study-h-${item.status}`);
      const main = el('div', 'study-h-main');
      main.append(el('b', null, `${item.seat_label}`), el('span', 'study-h-date', fmtDate(item.checked_in_at ?? item.reserved_at)));
      const range = item.checked_in_at
        ? `${fmtTime(item.checked_in_at)}–${item.status === 'occupied' ? '이용 중' : fmtTime(item.ended_at)}`
        : `예약 ${fmtTime(item.reserved_at)}`;
      main.append(el('span', 'study-h-range', range));
      const side = el('div', 'study-h-side');
      side.append(
        el('span', 'study-h-min', item.study_minutes > 0 ? formatMinutes(item.study_minutes) : '—'),
        el('span', 'study-h-state', historyStatusLabel(item)),
      );
      li.append(main, side);
      list.append(li);
    }
    card.append(list);
    if (nextBeforeId) {
      const more = el('button', 'btn cta ghost study-more', '더 보기');
      more.type = 'button';
      more.disabled = loading;
      more.addEventListener('click', loadMore);
      card.append(more);
    }
    return card;
  }

  function render() {
    const parts = [renderTiles(), renderChart(), renderDetails(), renderHistory()];
    if (failed) {
      const retry = el('button', 'btn cta ghost', '다시 불러오기');
      retry.type = 'button';
      retry.addEventListener('click', () => load(true));
      const box = el('div', 'card study-error');
      box.append(el('p', 'note', '공부 기록을 불러오지 못했어요.'), retry);
      parts.unshift(box);
    }
    element.replaceChildren(...parts);
  }

  async function load(force = false) {
    if (loading) return;
    if (!force && stats && Date.now() - loadedAt < STALE_MS) return;
    loading = true;
    const myGen = generation;
    render();
    try {
      const [s, h] = await Promise.all([api.myStats(), api.myHistory(HISTORY_PAGE)]);
      if (myGen !== generation) return;
      stats = s.stats;
      history = h.history ?? [];
      nextBeforeId = h.next_before_id ?? null;
      loadedAt = Date.now();
      failed = false;
    } catch (err) {
      if (myGen !== generation) return;
      failed = true;
      if (err?.status === 401) onAuthError?.(err);
    } finally {
      if (myGen === generation) { loading = false; render(); }
    }
  }

  async function loadMore() {
    if (loading || !nextBeforeId) return;
    loading = true;
    const myGen = generation;
    render();
    try {
      const h = await api.myHistory(HISTORY_PAGE, nextBeforeId);
      if (myGen !== generation) return;
      history = history.concat(h.history ?? []);
      nextBeforeId = h.next_before_id ?? null;
    } catch (err) {
      if (myGen === generation && err?.status === 401) onAuthError?.(err);
    } finally {
      if (myGen === generation) { loading = false; render(); }
    }
  }

  /** 로그아웃: 이전 학생의 기록을 지운다 */
  function clear() {
    generation += 1;
    stats = null;
    history = [];
    nextBeforeId = null;
    loadedAt = 0;
    loading = false;
    failed = false;
    element.replaceChildren();
  }

  render();
  return {
    element,
    /** 탭을 열 때 (30초 안에 불러온 값이면 그대로) */
    load,
    /** 착석·퇴실 등 기록이 바뀌었을 때 */
    refresh: () => load(true),
    clear,
  };
}
