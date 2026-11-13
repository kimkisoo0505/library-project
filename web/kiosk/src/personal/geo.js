/**
 * 개인 사용 화면: 현재 위치(GPS) 한 번 가져오기
 * 버튼을 눌렀을 때만 호출한다 (화면을 열자마자 묻지 않음). 위치는 서버로 보내지 않는다.
 */
export const GEO_ERRORS = Object.freeze({
  unsupported: '이 브라우저는 위치 기능을 지원하지 않아요.',
  insecure: '보안 연결(https)에서만 위치를 쓸 수 있어요.',
  denied: '위치 권한이 꺼져 있어요. 브라우저 설정에서 이 사이트의 위치 권한을 허용해 주세요.',
  unavailable: '지금 위치를 확인할 수 없어요. GPS·위치 서비스가 켜져 있는지 확인해 주세요.',
  timeout: '위치를 찾는 데 시간이 너무 오래 걸려요. 다시 눌러 주세요.',
});

/** @returns {Promise<{ pos: [number, number], accuracy: number }>} 실패하면 Error(code ∈ GEO_ERRORS) */
export function getCurrentPosition({ geolocation = globalThis.navigator?.geolocation, secure = globalThis.isSecureContext } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (code) => { const e = new Error(GEO_ERRORS[code]); e.code = code; reject(e); };
    if (!secure) { fail('insecure'); return; }
    if (!geolocation?.getCurrentPosition) { fail('unsupported'); return; }
    geolocation.getCurrentPosition(
      (p) => resolve({ pos: [p.coords.latitude, p.coords.longitude], accuracy: p.coords.accuracy }),
      (err) => fail(err?.code === 1 ? 'denied' : err?.code === 3 ? 'timeout' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }, // 버튼을 누를 때마다 새 위치 (예전 위치 재사용 안 함)
    );
  });
}
