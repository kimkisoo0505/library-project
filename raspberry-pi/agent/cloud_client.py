"""클라우드(Cloudflare Workers) 통신 클라이언트.

- 모든 연결은 라즈베리파이에서 외부로 나가는 HTTPS/WSS 연결이다 (인바운드 포트 없음).
- REST: 좌석 스냅샷 조회, 장치 이벤트 전송
- WebSocket: 좌석 변경 알림 구독 (지수 백오프 재연결)
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any

from .config import AgentConfig
from .logger import get_logger, log_event

MessageCallback = Callable[[dict[str, Any]], Awaitable[None]]
ConnectionCallback = Callable[[bool], Awaitable[None]]

USER_AGENT = "library-agent/0.1"


class CloudUnavailableError(RuntimeError):
    """네트워크 단절, 타임아웃, 서버 오류 등으로 클라우드 요청이 실패함."""


class CloudRequestRejected(RuntimeError):
    """서버가 요청을 거부함 (4xx). 재시도해도 결과가 같다."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code


class CloudClient:
    def __init__(
        self,
        config: AgentConfig,
        *,
        on_message: MessageCallback,
        on_connection_change: ConnectionCallback,
    ) -> None:
        self._config = config
        self._on_message = on_message
        self._on_connection_change = on_connection_change
        self._http: Any = None
        self._log = get_logger("cloud")

    async def __aenter__(self) -> CloudClient:
        import httpx  # 지연 import

        self._http = httpx.AsyncClient(
            base_url=self._config.api_base_url,
            timeout=self._config.request_timeout_seconds,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    def _device_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._config.device_token}",
            "X-Device-Id": self._config.device_id,
        }

    async def _request(self, method: str, path: str, *, device_auth: bool, body: dict[str, Any] | None = None) -> Any:
        import httpx

        if self._http is None:
            raise RuntimeError("CloudClient 는 async with 블록 안에서 사용해야 합니다")
        headers = self._device_headers() if device_auth else {}
        try:
            response = await self._http.request(method, path, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise CloudUnavailableError(f"{method} {path} 실패: {exc!r}") from exc

        if response.status_code >= 500:
            raise CloudUnavailableError(f"{method} {path} 서버 오류 {response.status_code}")
        try:
            data = response.json() if response.content else {}
        except ValueError:
            data = {}
        if response.status_code >= 400:
            error = data.get("error", {}) if isinstance(data, dict) else {}
            raise CloudRequestRejected(response.status_code, error.get("code", "http_error"), error.get("message", ""))
        return data

    async def fetch_seats(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/api/seats", device_auth=False)
        seats = data.get("seats") if isinstance(data, dict) else None
        if not isinstance(seats, list):
            raise CloudUnavailableError("좌석 응답 형식 오류")
        return seats

    async def post_device_event(self, event_type: str, **fields: Any) -> dict[str, Any]:
        body = {"type": event_type, **fields}
        return await self._request("POST", "/api/device/events", device_auth=True, body=body)

    async def run_websocket(self, stop_event: asyncio.Event) -> None:
        """좌석 변경 알림 구독. 끊기면 1초~60초 지수 백오프로 재연결."""
        import websockets

        attempt = 0
        while not stop_event.is_set():
            try:
                async with websockets.connect(
                    self._config.ws_url,
                    additional_headers=self._device_headers(),
                    user_agent_header=USER_AGENT,
                    ping_interval=20,
                    ping_timeout=20,
                    open_timeout=self._config.request_timeout_seconds,
                    max_size=64 * 1024,
                ) as ws:
                    attempt = 0
                    log_event(self._log, "cloud.ws_connected", "클라우드 WebSocket 연결됨")
                    await self._notify(True)
                    async for raw in ws:
                        await self._dispatch(raw)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 네트워크 오류는 모두 재연결 대상
                log_event(self._log, "cloud.ws_error", "클라우드 WebSocket 오류", level=logging.WARNING,
                          error=repr(exc))
            await self._notify(False)

            attempt += 1
            delay = min(60.0, 2 ** min(attempt, 6)) + random.uniform(0, 1)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=delay)
            except TimeoutError:
                pass

    async def _dispatch(self, raw: str | bytes) -> None:
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            log_event(self._log, "cloud.ws_invalid_message", "잘못된 WebSocket 메시지", level=logging.WARNING)
            return
        if not isinstance(message, dict):
            return
        try:
            await self._on_message(message)
        except Exception:  # noqa: BLE001
            self._log.exception("클라우드 메시지 처리 중 오류")

    async def _notify(self, connected: bool) -> None:
        try:
            await self._on_connection_change(connected)
        except Exception:  # noqa: BLE001
            self._log.exception("클라우드 연결 상태 콜백 오류")
