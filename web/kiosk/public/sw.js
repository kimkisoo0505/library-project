// 좌석 알림용 서비스 워커 (common/browser-notify.js).
// 역할은 하나: 알림을 누르면 열려 있는 좌석 화면으로 이동(없으면 새로 연다).
// 요청 가로채기(fetch)·캐시는 하지 않는다 — 배포한 새 화면이 항상 그대로 보이도록.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  let target = '/#/personal';
  try {
    const url = new URL(raw || target, self.location.origin);
    if (url.origin === self.location.origin) target = url.href; // 같은 사이트 주소만 연다
  } catch { /* 기본값 사용 */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
