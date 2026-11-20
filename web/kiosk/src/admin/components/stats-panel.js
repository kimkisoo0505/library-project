/**
 * 관리자 이용 통계 패널 — 기간(7/14/30일) 합계, 일별 공부 시간, 시간대별 평균 사용 좌석, 열람실별 표.
 *
 * 숫자는 서버(GET /admin/stats)가 한국 날짜 기준으로 계산한다. 학생별 순위·학번은 없다(개인정보 최소화).
 * 실시간 좌석 갱신(seats.changed)마다 다시 부르지 않는다: 처음 열 때, 기간을 바꿀 때, [새로고침] 때만.
 * 그래프는 한 계열 = 한 색(--kg), 막대마다 마우스/포커스 시 값 표시, 같은 숫자를 표로도 제공한다.
 */
import { api } from '../../common/api.js';

const PERIODS = [7, 14, 30];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function formatHours(min) {
  const m = Math.max(0, Math.floor(Number(min) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}분`;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}

function dayText(key) {
  const [y, mo, d] = String(key).split('-').map(Number);
  return `${mo}/${d}(${WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]})`;
}

/**
 * 막대 그래프 하나 (한 계열).
 * @param {{ label: string, items: Array<{ key: string, value: number, text: string, axis: string }>, axisEvery?: number, unit: string }} o
 */
function barChart({ label, items, axisEvery = 1, defaultText }) {
  const wrap = el('div', 'stats-chart-wrap');
  const readout = el('div', 'stats-readout', defaultText);
  readout.setAttribute('aria-live', 'polite');
  const chart = el('div', 'stats-chart');
  chart.style.gridTemplateColumns = `repeat(${items.length}, 1fr)`;
  chart.setAttribute('role', 'list');
  chart.setAttribute('aria-label', label);
  const max = Math.max(...items.map((i) => i.value), 0);
  const peakIndex = max > 0 ? items.findIndex((i) => i.value === max) : -1;
  items.forEach((item, i) => {
    const col = el('button', 'stats-col');
    col.type = 'button';
    col.setAttribute('role', 'listitem');
    col.setAttribute('aria-label', item.text);
    const track = el('span', 'stats-track');
    const bar = el('span', 'stats-bar');
    bar.style.height = item.value > 0 && max > 0 ? `${Math.max(3, (item.value / max) * 100)}%` : '0';
    if (i === peakIndex) track.append(el('span', 'stats-val', item.short)); // 최댓값에만 숫자
    track.append(bar);
    col.append(track, el('span', 'stats-axis', i % axisEvery === 0 ? item.axis : ''));
    const show = () => { readout.textContent = item.text; col.classList.add('is-active'); };
    const hide = () => { readout.textContent = defaultText; col.classList.remove('is-active'); };
    col.addEventListener('pointerenter', show);
    col.addEventListener('pointerleave', hide);
    col.addEventListener('focus', show);
    col.addEventListener('blur', hide);
    chart.append(col);
  });
  wrap.append(readout, chart);
  return wrap;
}

function table(headers, rows) {
  const t = el('table', 'data-table stats-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of headers) hr.append(el('th', null, h));
  thead.append(hr);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) tr.append(el('td', null, String(cell)));
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
}

/** @param {{ onError: (err: Error) => void }} options */
export function createAdminStatsPanel({ onError }) {
  const element = el('section', 'card stats-panel');
  let days = 7;
  let stats = null;
  let loading = false;
  let showTable = false;
  let tried = false; // 실패해도 자동으로 계속 다시 부르지 않는다 ([새로고침]으로만)
  let generation = 0;

  function header() {
    const head = el('div', 'stats-head');
    head.append(el('h2', null, '이용 통계'));
    const controls = el('div', 'stats-controls');
    const seg = el('div', 'stats-periods');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', '기간');
    for (const d of PERIODS) {
      const b = el('button', `btn ${d === days ? 'btn-primary' : 'btn-ghost'}`, `${d}일`);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(d === days));
      b.disabled = loading;
      b.addEventListener('click', () => { if (d !== days) { days = d; load(); } });
      seg.append(b);
    }
    const refresh = el('button', 'btn btn-ghost', loading ? '불러오는 중…' : '새로고침');
    refresh.type = 'button';
    refresh.disabled = loading;
    refresh.addEventListener('click', () => load());
    controls.append(seg, refresh);
    head.append(controls);
    return head;
  }

  function tiles() {
    const t = stats.totals;
    const grid = el('div', 'stats-tiles');
    const tile = (k, v, s) => {
      const box = el('div', 'stats-tile');
      box.append(el('div', 'k', k), el('div', 'v', v));
      if (s) box.append(el('div', 's', s));
      grid.append(box);
    };
    tile('총 공부 시간', formatHours(t.study_minutes), `평균 ${formatHours(t.average_session_minutes)} / 회`);
    tile('착석', `${t.check_ins}회`, `예약 ${t.reservations}건 · 이용 학생 ${t.unique_students}명`);
    tile('노쇼 (미착석 자동 취소)', `${t.no_shows}건`, `예약 대비 ${(t.no_show_rate * 100).toFixed(1)}%`);
    tile('예약 취소', `${t.cancelled}건`);
    return grid;
  }

  function render() {
    const parts = [header()];
    if (!stats) {
      parts.push(el('p', 'hint', loading ? '통계를 불러오는 중…' : '통계를 불러오지 못했습니다. [새로고침]을 눌러 주세요.'));
      element.replaceChildren(...parts);
      return;
    }
    parts.push(el('p', 'hint', `최근 ${stats.days}일 (한국 시간, ${dayText(stats.daily[0].date)} ~ 오늘) · 공부 시간은 착석부터 퇴실까지`));
    parts.push(tiles());

    const daily = stats.daily.map((d) => ({
      key: d.date,
      value: d.study_minutes,
      short: `${Math.round(d.study_minutes / 6) / 10}h`,
      axis: dayText(d.date).replace(/\(.\)/, ''),
      text: `${dayText(d.date)} · 공부 ${formatHours(d.study_minutes)} · 착석 ${d.check_ins}회 · 예약 ${d.reservations}건 · 노쇼 ${d.no_shows}건`,
    }));
    const dailyBox = el('div', 'stats-block');
    dailyBox.append(
      el('h3', null, '일별 공부 시간'),
      barChart({ label: '일별 공부 시간', items: daily, axisEvery: stats.days > 14 ? 5 : 1, defaultText: '막대에 마우스를 올리면 그날의 숫자가 보여요' }),
    );

    const hourly = stats.hourly.map((h) => ({
      key: String(h.hour),
      value: h.avg_occupied,
      short: `${h.avg_occupied}석`,
      axis: String(h.hour),
      text: `${h.hour}시~${h.hour + 1}시 · 평균 ${h.avg_occupied}석 사용 (전체 ${stats.totals.total_seats}석)`,
    }));
    const hourlyBox = el('div', 'stats-block');
    hourlyBox.append(
      el('h3', null, '시간대별 평균 사용 좌석'),
      barChart({ label: '시간대별 평균 사용 좌석 수', items: hourly, axisEvery: 3, defaultText: '기간 중 그 시간대에 평균 몇 자리가 사용됐는지 (막대에 마우스를 올려 보세요)' }),
    );

    const roomsBox = el('div', 'stats-block');
    roomsBox.append(
      el('h3', null, '열람실별'),
      table(['열람실', '좌석', '착석', '공부 시간'], stats.rooms.map((r) => [r.name, `${r.seats}석`, `${r.check_ins}회`, formatHours(r.study_minutes)])),
    );

    const toggle = el('button', 'btn btn-ghost', showTable ? '일별 표 닫기' : '일별 숫자 표로 보기');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(showTable));
    toggle.addEventListener('click', () => { showTable = !showTable; render(); });

    parts.push(dailyBox, hourlyBox, roomsBox, toggle);
    if (showTable) {
      parts.push(table(['날짜', '예약', '착석', '노쇼', '공부 시간'],
        stats.daily.map((d) => [dayText(d.date), d.reservations, d.check_ins, d.no_shows, formatHours(d.study_minutes)])));
    }
    element.replaceChildren(...parts);
  }

  async function load() {
    const myGen = ++generation;
    loading = true;
    tried = true;
    render();
    try {
      const res = await api.adminStats(days);
      if (myGen !== generation) return;
      stats = res.stats;
    } catch (err) {
      if (myGen !== generation) return;
      stats = null;
      onError?.(err);
    } finally {
      if (myGen === generation) { loading = false; render(); }
    }
  }

  render();
  return {
    element,
    load,
    /** 관리자 로그아웃 */
    clear() { generation += 1; stats = null; loading = false; tried = false; render(); },
    get loaded() { return tried; },
  };
}
