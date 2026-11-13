/**
 * 개인 사용 화면: 카카오맵 (Kakao Maps JavaScript SDK)
 *
 * - 키: VITE_KAKAO_MAP_KEY (카카오 디벨로퍼스의 'JavaScript 키'). 브라우저에 공개되는 키이며,
 *   카카오 디벨로퍼스 → 플랫폼 → Web 에 등록한 사이트 주소에서만 동작한다.
 * - 키가 없으면 지도 없이 거리 목록 · 카카오맵 길찾기 링크만 보인다 (nearby-card.js).
 * - SDK 는 지도를 처음 그릴 때만 불러온다 (autoload=false → kakao.maps.load).
 * - 운영 보안 정책(CSP)에 dapi.kakao.com · *.daumcdn.net 허용이 필요하다 (public/_headers).
 */
export const KAKAO_MAP_KEY = String(import.meta.env.VITE_KAKAO_MAP_KEY ?? '').trim();

let sdkPromise = null;

export function loadKakaoMaps(key = KAKAO_MAP_KEY) {
  if (!key) return Promise.reject(new Error('카카오맵 키가 설정되지 않았어요.'));
  if (globalThis.kakao?.maps?.LatLng) return Promise.resolve(globalThis.kakao.maps);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
    script.async = true;
    script.onload = () => {
      if (!globalThis.kakao?.maps?.load) { reject(new Error('카카오맵을 불러오지 못했어요.')); return; }
      globalThis.kakao.maps.load(() => resolve(globalThis.kakao.maps));
    };
    script.onerror = () => reject(new Error('카카오맵을 불러오지 못했어요. 네트워크나 키 설정을 확인해 주세요.'));
    document.head.append(script);
  }).catch((err) => { sdkPromise = null; throw err; });
  return sdkPromise;
}

/**
 * 지도 그리기: 내 위치 + 장소 마커, 추천 장소 강조. 모든 마커가 보이도록 범위를 맞춘다.
 * @param {HTMLElement} container
 * @param {{ here: [number, number], places: Array<{id: string, name: string, pos: [number, number]|null, available: number|null}>, bestId: string|null }} data
 */
export async function renderKakaoMap(container, { here, places, bestId }) {
  const maps = await loadKakaoMaps();
  const center = new maps.LatLng(here[0], here[1]);
  const map = new maps.Map(container, { center, level: 4 });
  const bounds = new maps.LatLngBounds();
  bounds.extend(center);

  const meEl = document.createElement('div');
  meEl.className = 'km-me';
  meEl.title = '내 위치';
  new maps.CustomOverlay({ position: center, content: meEl, yAnchor: 0.5, zIndex: 3 }).setMap(map);

  for (const p of places) {
    if (!p.pos) continue;
    const at = new maps.LatLng(p.pos[0], p.pos[1]);
    bounds.extend(at);
    const label = document.createElement('div');
    label.className = `km-label${p.id === bestId ? ' is-best' : ''}${p.available === 0 ? ' is-full' : ''}`;
    label.textContent = p.available == null ? p.name : `${p.name} · ${p.available === 0 ? '만석' : `${p.available}석`}`;
    new maps.CustomOverlay({ position: at, content: label, yAnchor: 1.3, zIndex: p.id === bestId ? 2 : 1 }).setMap(map);
    new maps.Marker({ position: at, map, title: p.name });
  }
  map.setBounds(bounds, 40, 40, 40, 40);
  return map;
}
