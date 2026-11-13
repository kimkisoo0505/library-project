/**
 * 개인 사용 화면: "가까운 열람실" 카드 (좌석 탭 맨 위, 상태 카드 아래)
 *
 * [내 위치로 찾기] 를 눌렀을 때만 위치(GPS)를 묻는다. 위치는 이 화면 안에서만 쓰고 서버로 보내지 않는다.
 * 예비 열람실 A·B·C 와 중앙도서관 중 빈자리가 있는 가장 가까운 곳을 추천하고, 카카오맵 길찾기 링크를 준다.
 * 카카오맵 키(VITE_KAKAO_MAP_KEY)가 있으면 지도도 그린다.
 */
import { buildPlaces, rankPlaces, formatDistance, walkMinutes, kakaoDirectionsUrl } from '../nearby.js';
import { getCurrentPosition } from '../geo.js';
import { KAKAO_MAP_KEY, renderKakaoMap } from '../kakao-map.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const seatsText = (p) => (p.available == null ? '빈자리 정보 없음' : p.available === 0 ? '만석' : `빈자리 ${p.available}석`);

/**
 * @param {{ onShowRoom: (code: string) => void, onShowCentral: () => void, getPosition?: Function }} options
 */
export function createNearbyCard({ onShowRoom, onShowCentral, getPosition = getCurrentPosition }) {
  const element = el('section', 'card nearby-card');
  element.setAttribute('aria-label', '가까운 열람실 찾기');

  let rooms = [];
  let central = null;
  let here = null;          // [위도, 경도]
  let accuracy = null;
  let status = 'idle';      // idle | locating | ready | error
  let errorText = '';
  let mapSignature = '';
  let mapError = '';

  const mapBox = el('div', 'nearby-map');
  mapBox.setAttribute('role', 'img');
  mapBox.setAttribute('aria-label', '내 위치와 열람실 위치 지도');

  async function locate() {
    status = 'locating';
    render();
    try {
      const r = await getPosition();
      here = r.pos;
      accuracy = r.accuracy;
      status = 'ready';
      mapSignature = '';
    } catch (err) {
      status = 'error';
      errorText = err?.message || '위치를 확인할 수 없어요.';
    }
    render();
  }

  function goTo(place) {
    if (place.kind === 'central') onShowCentral();
    else onShowRoom(place.id);
  }

  function placeRow(p, isBest) {
    const li = el('li', `nearby-item${isBest ? ' is-best' : ''}${p.available === 0 ? ' is-full' : ''}`);
    const main = el('button', 'nearby-item-main');
    main.type = 'button';
    main.addEventListener('click', () => goTo(p));
    const name = el('span', 'nearby-name', p.name);
    if (p.sub && p.kind === 'room') name.append(el('small', null, p.sub));
    const meta = el('span', 'nearby-meta', `${p.distance == null ? (p.pos ? '' : '위치 정보 없음') : formatDistance(p.distance)} · ${seatsText(p)}`);
    main.append(name, meta);
    li.append(main);
    const url = kakaoDirectionsUrl(p);
    if (url) {
      const a = el('a', 'nearby-route', '길찾기');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', `${p.name} 카카오맵 길찾기 (새 창)`);
      li.append(a);
    }
    return li;
  }

  async function drawMap(list, best) {
    if (!KAKAO_MAP_KEY) return;
    const sig = JSON.stringify([here, list.map((p) => [p.id, p.available, p.pos]), best?.id]);
    if (sig === mapSignature) return;
    mapSignature = sig;
    try {
      mapError = '';
      mapBox.replaceChildren();
      await renderKakaoMap(mapBox, { here, places: list, bestId: best?.id ?? null });
    } catch (err) {
      mapError = err?.message || '지도를 불러오지 못했어요.';
      mapBox.replaceChildren(el('p', 'nearby-map-note', mapError));
    }
  }

  function render() {
    const head = el('div', 'nearby-head');
    head.append(el('h3', 'nearby-title', '📍 가까운 열람실'));
    const body = [];

    if (status === 'idle' || status === 'locating' || status === 'error') {
      const btn = el('button', 'btn nearby-find', status === 'locating' ? '위치 확인 중…' : '내 위치로 가까운 열람실 찾기');
      btn.type = 'button';
      btn.disabled = status === 'locating';
      btn.addEventListener('click', locate);
      body.push(el('p', 'nearby-desc', '예비 열람실 A·B·C 와 중앙도서관 중 빈자리가 있는 가장 가까운 곳을 지도로 알려 드려요.'));
      if (status === 'error') body.push(el('p', 'nearby-error', errorText));
      body.push(btn, el('p', 'nearby-privacy', '위치는 이 휴대폰에서 거리 계산에만 쓰고 서버로 보내지 않아요.'));
      element.replaceChildren(head, ...body);
      return;
    }

    // ready
    const { list, best } = rankPlaces(buildPlaces(rooms, central), here);
    const again = el('button', 'nearby-again', '다시 찾기');
    again.type = 'button';
    again.addEventListener('click', locate);
    head.append(again);

    if (best) {
      const rec = el('div', 'nearby-best');
      rec.append(
        el('div', 'nearby-best-k', '빈자리가 있는 가장 가까운 곳'),
        el('div', 'nearby-best-v', best.kind === 'room' && best.sub ? `${best.name} · ${best.sub}` : best.name),
        el('div', 'nearby-best-d', `직선 ${formatDistance(best.distance)} · 걸어서 약 ${walkMinutes(best.distance)}분 · ${seatsText(best)}`),
      );
      const actions = el('div', 'nearby-best-actions');
      const show = el('button', 'btn nearby-show', best.kind === 'central' ? '중앙도서관 현황 보기' : '좌석 보기');
      show.type = 'button';
      show.addEventListener('click', () => goTo(best));
      const route = el('a', 'btn nearby-route-main', '카카오맵 길찾기');
      route.href = kakaoDirectionsUrl(best);
      route.target = '_blank';
      route.rel = 'noopener noreferrer';
      actions.append(show, route);
      rec.append(actions);
      body.push(rec);
    } else {
      body.push(el('p', 'nearby-error', list.some((p) => p.distance != null)
        ? '지금은 빈자리가 있는 곳이 없어요.'
        : '열람실 위치가 아직 정해지지 않았어요. (관리자가 강의실 위치를 입력하면 표시돼요)'));
    }

    if (KAKAO_MAP_KEY) {
      body.push(mapBox);
      drawMap(list, best);
    } else {
      body.push(el('p', 'nearby-map-note', '지도는 카카오맵 설정 후 표시돼요. 지금은 [길찾기]로 카카오맵에서 볼 수 있어요.'));
    }

    const ul = el('ul', 'nearby-list');
    for (const p of list) ul.append(placeRow(p, p === best));
    body.push(ul);
    if (accuracy != null && accuracy > 100) body.push(el('p', 'nearby-privacy', `위치 오차가 커요 (약 ${Math.round(accuracy)}m). 거리는 참고만 해 주세요.`));
    element.replaceChildren(head, ...body);
  }

  render();
  return {
    element,
    /** 열람실 요약(/api/seats rooms)과 중앙도서관(수원) 공석이 바뀔 때 */
    update(nextRooms, nextCentral) {
      rooms = Array.isArray(nextRooms) ? nextRooms : [];
      central = nextCentral ?? null;
      if (status === 'ready') render();
    },
  };
}
