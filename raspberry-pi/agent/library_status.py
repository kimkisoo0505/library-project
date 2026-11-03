"""경기대 중앙도서관(수원) / 금화도서관(서울) 공석 현황 중계.

왜 라즈베리파이가 중계하는가:
    학교 서버(libgate.kyonggi.ac.kr)가 중간 인증서를 보내지 않아 Cloudflare Workers 에서는
    TLS 검증에 실패한다(HTTP 526). 라즈베리파이는 공개된 중간 인증서
    (certs/rapidssl-tls-rsa-ca-g1.pem, DigiCert Global Root G2 발급)를 함께 신뢰 목록에 넣어
    **인증서 검증을 끄지 않고** 정상 조회한 뒤, 결과를 우리 서버로 올린다.

부하 배려: 1분(최소 30초) 간격, 두 캠퍼스 각 1회. 클라우드가 오프라인이면 조회하지 않는다.
서버는 올라온 데이터도 다시 검증/정규화한다.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from .logger import get_logger, log_event

LIBGATE_BASE = "https://libgate.kyonggi.ac.kr"
CAMPUSES = ((1, "중앙도서관"), (2, "금화도서관"))
INTERMEDIATE_CERT = Path(__file__).resolve().parent / "certs" / "rapidssl-tls-rsa-ca-g1.pem"
USER_AGENT = "KGU-Reserve-Library-Agent/0.1 (+https://library-kiosk.kimkisoo0505.workers.dev)"
ROOM_FIELDS = ("code", "name", "cnt", "available", "inUse", "fix", "unavailable", "disabled", "startTm", "endTm")
MAX_ROOMS = 50


class RelayCloud(Protocol):
    async def post_central_library(self, payload: dict[str, Any]) -> dict[str, Any]: ...


def build_ssl_context(extra_cert: Path = INTERMEDIATE_CERT) -> ssl.SSLContext:
    """certifi 루트 + 학교 서버가 빠뜨린 중간 인증서. 호스트명/체인 검증은 그대로 켜져 있다."""
    import certifi  # httpx 의존성

    context = ssl.create_default_context(cafile=certifi.where())
    context.load_verify_locations(cafile=str(extra_cert))
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
    return context


def slim_rooms(data: Any) -> list[dict[str, Any]]:
    """필요한 필드만 남겨 전송량을 줄인다 (검증은 서버에서 다시 한다)."""
    if not isinstance(data, list):
        raise ValueError("unexpected_payload")
    return [
        {key: room.get(key) for key in ROOM_FIELDS if key in room}
        for room in data[:MAX_ROOMS]
        if isinstance(room, dict)
    ]


class LibraryStatusRelay:
    def __init__(
        self,
        cloud: RelayCloud,
        *,
        interval_seconds: float = 60.0,
        is_online: Callable[[], bool] = lambda: True,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        self._cloud = cloud
        self._interval = max(30.0, interval_seconds)
        self._is_online = is_online
        self._client_factory = client_factory or self._default_client
        self._log = get_logger("library_status")
        self._last_ok: bool | None = None

    @staticmethod
    def _default_client() -> Any:
        import httpx

        return httpx.AsyncClient(
            base_url=LIBGATE_BASE,
            verify=build_ssl_context(),
            timeout=8.0,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )

    async def _fetch_campus(self, client: Any, campus_id: int) -> list[dict[str, Any]]:
        response = await client.get(f"/libraries/lib-status/{campus_id}")
        if response.status_code != 200:
            raise RuntimeError(f"http_{response.status_code}")
        body = response.json()
        if not isinstance(body, dict) or body.get("code") != 1:
            raise RuntimeError("api_error")
        return slim_rooms(body.get("data"))

    async def collect(self, client: Any) -> dict[str, Any]:
        """두 캠퍼스를 조회해 서버로 보낼 형식으로 만든다. 실패한 캠퍼스는 errors 에 기록."""
        results = await asyncio.gather(
            *(self._fetch_campus(client, cid) for cid, _ in CAMPUSES), return_exceptions=True
        )
        payload: dict[str, Any] = {"campuses": [], "errors": []}
        for (campus_id, library), result in zip(CAMPUSES, results):
            if isinstance(result, BaseException):
                payload["errors"].append(f"{library}: {type(result).__name__}: {str(result)[:80]}")
            else:
                payload["campuses"].append({"id": campus_id, "data": result})
        return payload

    async def run_once(self, client: Any) -> bool:
        if not self._is_online():
            log_event(self._log, "library_status.skipped_offline", "클라우드 오프라인 - 조회 생략", level=logging.DEBUG)
            return False
        payload = await self.collect(client)
        ok = not payload["errors"]
        if ok != self._last_ok:  # 상태가 바뀔 때만 기록
            log_event(
                self._log,
                "library_status.ok" if ok else "library_status.fetch_failed",
                "중앙/금화도서관 조회 정상" if ok else "중앙/금화도서관 조회 실패",
                level=logging.INFO if ok else logging.WARNING,
                errors=payload["errors"],
            )
            self._last_ok = ok
        try:
            await self._cloud.post_central_library(payload)
        except Exception as exc:  # noqa: BLE001
            log_event(self._log, "library_status.upload_failed", "서버 전송 실패", level=logging.WARNING, error=repr(exc))
            return False
        return ok

    async def run(self, stop: asyncio.Event) -> None:
        async with self._client_factory() as client:
            while not stop.is_set():
                try:
                    await self.run_once(client)
                except Exception:  # noqa: BLE001
                    self._log.exception("중앙/금화도서관 중계 오류")
                try:
                    await asyncio.wait_for(stop.wait(), timeout=self._interval)
                except TimeoutError:
                    pass
