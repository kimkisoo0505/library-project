/**
 * 경기대 중앙도서관(수원) / 금화도서관(서울) 공석 현황 패널
 * 데이터는 우리 API(/api/central-library)가 1분 단위로 캐시한 값이며, 외부 데이터이므로 textContent 로만 표시한다.
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

function meter(available, total) {
  const bar = el('span', 'cl-meter');
  const ratio = total > 0 ? available / total : 0;
  const fill = el('span', `cl-meter-fill ${ratio === 0 ? 'is-full' : ratio < 0.2 ? 'is-low' : ''}`.trim());
  fill.style.width = `${Math.round(ratio * 100)}%`;
  bar.append(fill);
  bar.setAttribute('aria-hidden', 'true');
  return bar;
}

function roomRow(room) {
  const row = el('li', 'cl-room');
  row.append(
    el('span', 'cl-room-name', room.name),
    meter(room.available, room.total),
    el('span', 'cl-room-count', `${room.available} / ${room.total}`),
  );
  row.setAttribute('aria-label', `${room.name} 공석 ${room.available}석 / 전체 ${room.total}석`);
  return row;
}

function campusCard(campus, open) {
  const card = el('details', 'cl-campus');
  card.open = open;
  const summary = el('summary', 'cl-campus-summary');
  summary.append(
    el('span', 'cl-campus-name', `${campus.library}`),
    el('span', 'cl-campus-sub', campus.campus),
    meter(campus.available, campus.total),
    el('span', 'cl-campus-count', `공석 ${campus.available} / ${campus.total}`),
  );
  const hours = [...new Set(campus.rooms.map((r) => r.hours).filter(Boolean))];
  const list = el('ul', 'cl-room-list');
  campus.rooms.forEach((room) => list.append(roomRow(room)));
  card.append(summary);
  if (hours.length === 1) card.append(el('p', 'hint cl-hours', `운영 시간 ${hours[0]}`));
  card.append(list);
  return card;
}

export function createCentralLibraryPanel() {
  const element = el('section', 'central-library card');
  element.setAttribute('aria-label', '중앙도서관 · 금화도서관 공석 현황');
  const header = el('div', 'cl-header');
  const title = el('h2', null, '중앙도서관 · 금화도서관 공석 현황');
  const meta = el('span', 'hint cl-meta');
  header.append(title, meta);
  const body = el('div', 'cl-body');
  const footer = el('p', 'hint cl-source', '출처: 경기대학교 도서관 좌석 현황 (1분 단위 갱신)');
  element.append(header, body, footer);
  body.append(el('p', 'hint', '불러오는 중…'));

  const openState = new Map(); // 다시 그려도 펼침 상태 유지

  return {
    element,
    update(data) {
      meta.textContent = data?.fetched_at ? agoText(data.fetched_at) : '';
      body.replaceChildren();
      if (!data?.available) {
        body.append(el('p', 'hint', '중앙도서관 정보를 지금 불러올 수 없습니다.'));
        return;
      }
      if (data.stale || data.degraded) {
        body.append(el('p', 'cl-warning', data.stale
          ? '최신 정보를 받지 못해 이전에 받은 정보를 표시하고 있습니다.'
          : '일부 정보를 갱신하지 못했습니다. 표시된 시각을 확인하세요.'));
      }
      for (const campus of data.campuses) {
        const card = campusCard(campus, openState.get(campus.id) ?? false);
        card.addEventListener('toggle', () => openState.set(campus.id, card.open));
        body.append(card);
      }
    },
    showError() {
      body.replaceChildren(el('p', 'hint', '중앙도서관 정보를 지금 불러올 수 없습니다.'));
      meta.textContent = '';
    },
  };
}
