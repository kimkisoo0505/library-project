/**
 * 경기대 중앙도서관(수원) / 금화도서관(서울) 공석 현황 패널
 * 데이터는 우리 API(/api/central-library)가 1분 단위로 캐시한 값이며, 외부 데이터이므로 textContent 로만 표시한다.
 * 혼잡도 표시는 화면용 계산일 뿐이다 (사용률 90% 이상 혼잡, 50% 이상 보통, 미만 여유).
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function agoText(iso) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return minutes < 1 ? '방금 갱신' : `${minutes}분 전 갱신`;
}

const LEVEL_LABELS = { bad: '혼잡', warn: '보통', ok: '여유' };

/** 사용 중 좌석 수 / 전체 좌석 수 → 'bad' | 'warn' | 'ok' */
export function congestionLevel(used, total) {
  const ratio = total > 0 ? used / total : 1;
  return ratio >= 0.9 ? 'bad' : ratio >= 0.5 ? 'warn' : 'ok';
}

export function createLevelPill(level) {
  return el('span', `pill p-${level}`, LEVEL_LABELS[level] ?? '');
}

function usedPercent(available, total) {
  return total > 0 ? Math.round(((total - available) / total) * 100) : 100;
}

function meter(available, total) {
  const bar = el('span', 'meter');
  const fill = el('span', `meter-fill lv-${congestionLevel(total - available, total)}`);
  fill.style.width = `${usedPercent(available, total)}%`;
  bar.append(fill);
  bar.setAttribute('aria-hidden', 'true');
  return bar;
}

function roomRow(room) {
  const row = el('li', 'cl-room');
  const count = el('span', 'cl-room-count');
  if (room.available === 0) {
    count.append(el('span', 'is-full', '만석'));
  } else {
    count.append(String(room.available), el('small', null, ` / ${room.total}`));
  }
  row.append(el('span', 'cl-room-name', room.name), meter(room.available, room.total), count);
  row.setAttribute('aria-label', `${room.name} 공석 ${room.available}석 / 전체 ${room.total}석`);
  return row;
}

function campusCard(campus, open) {
  const card = el('details', 'card campus');
  card.open = open;
  const summary = el('summary', 'campus-summary');

  const top = el('div', 'campus-top');
  const chev = el('span', 'chev', '⌄');
  chev.setAttribute('aria-hidden', 'true');
  top.append(
    el('span', 'nm', campus.library),
    el('span', 'cp', campus.campus),
    createLevelPill(congestionLevel(campus.total - campus.available, campus.total)),
    chev,
  );

  const num = el('div', 'campus-num');
  num.append(el('b', null, String(campus.available)), el('span', null, `석 남음 · 전체 ${campus.total}석`));

  const meterRow = el('div', 'campus-meter');
  meterRow.append(meter(campus.available, campus.total), el('span', 'pct', `${usedPercent(campus.available, campus.total)}% 사용`));

  summary.append(top, num, meterRow);
  summary.setAttribute('aria-label', `${campus.library} ${campus.campus} 공석 ${campus.available}석 / 전체 ${campus.total}석`);

  const list = el('ul', 'rooms-list');
  campus.rooms.forEach((room) => list.append(roomRow(room)));
  card.append(summary, list);

  const hours = [...new Set(campus.rooms.map((r) => r.hours).filter(Boolean))];
  if (hours.length === 1) card.append(el('p', 'cl-hours', `운영 시간 ${hours[0]}`));
  return card;
}

export function createCentralLibraryPanel() {
  const element = el('section', 'central-library');
  element.setAttribute('aria-label', '중앙도서관 · 금화도서관 공석 현황');
  const body = el('div', 'central-library');
  const footer = el('p', 'updated', '출처: 경기대학교 도서관 좌석 현황 (1분 단위 갱신)');
  element.append(body, footer);
  body.append(el('div', 'card hint', '불러오는 중…'));

  const openState = new Map(); // 다시 그려도 펼침 상태 유지

  function setFooter(fetchedAt) {
    const ago = fetchedAt ? agoText(fetchedAt) : '';
    footer.textContent = `${ago ? `${ago} · ` : ''}출처: 경기대학교 도서관 좌석 현황 (1분 단위 갱신)`;
  }

  return {
    element,
    update(data) {
      setFooter(data?.fetched_at);
      body.replaceChildren();
      if (!data?.available) {
        body.append(el('div', 'card hint', '중앙도서관 정보를 지금 불러올 수 없습니다.'));
        return;
      }
      if (data.stale || data.degraded) {
        body.append(el('p', 'cl-warning', data.stale
          ? '최신 정보를 받지 못해 이전에 받은 정보를 표시하고 있습니다.'
          : '일부 정보를 갱신하지 못했습니다. 표시된 시각을 확인하세요.'));
      }
      data.campuses.forEach((campus, index) => {
        const card = campusCard(campus, openState.get(campus.id) ?? index === 0);
        card.addEventListener('toggle', () => openState.set(campus.id, card.open));
        body.append(card);
      });
    },
    showError() {
      body.replaceChildren(el('div', 'card hint', '중앙도서관 정보를 지금 불러올 수 없습니다.'));
      setFooter(null);
    },
  };
}
