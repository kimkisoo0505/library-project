"""시리얼 / 클라우드 이벤트를 연결하는 중재자.

안전 규칙:
    - 클라우드가 오프라인이거나 좌석 정보가 오래되었으면 버튼 입력을 거부한다 (로컬 승인 없음).
    - 오프라인 중 입력은 나중에 재전송하지 않는다 (상태 변경 큐 없음). 로컬 로그에만 남긴다.
    - Arduino 연결 단절은 좌석 상태를 바꾸지 않는다.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from .cloud_client import CloudRequestRejected, CloudUnavailableError
from .logger import get_logger, log_event
from .seat_manager import SeatManager, SnapshotError
from .serial_manager import SerialMessage


class CloudPort(Protocol):
    async def fetch_seats(self) -> list[dict[str, Any]]: ...
    async def post_device_event(self, event_type: str, **fields: Any) -> dict[str, Any]: ...


class SerialPortManager(Protocol):
    @property
    def connected(self) -> bool: ...
    async def send(self, kind: str, *fields: str) -> bool: ...


class WelcomeDisplay(Protocol):
    room: str

    def show_welcome(self) -> None: ...


CHECK_IN_REASON = "reservation.checked_in"


class EventHandler:
    def __init__(self, seats: SeatManager) -> None:
        self._seats = seats
        self._cloud: CloudPort | None = None
        self._serial: SerialPortManager | None = None
        self._display: WelcomeDisplay | None = None
        self._on_command: Callable[[dict[str, Any]], Awaitable[Any]] | None = None
        self._log = get_logger("events")

    def attach(
        self,
        *,
        cloud: CloudPort,
        serial: SerialPortManager,
        display: WelcomeDisplay | None = None,
        on_command: Callable[[dict[str, Any]], Awaitable[Any]] | None = None,
    ) -> None:
        self._cloud = cloud
        self._serial = serial
        self._display = display
        self._on_command = on_command

    # ----- Arduino -> 에이전트 -----

    async def on_serial_message(self, message: SerialMessage) -> None:
        match message.kind:
            case "HELLO":
                log_event(self._log, "arduino.hello", "Arduino 펌웨어 확인", firmware=message.fields[0])
                await self._forward_audit("serial_hello", firmware=message.fields[0])
            case "BTN":
                await self._handle_button(int(message.fields[0]), message.fields[1])
            case "PONG" | "ACK":
                log_event(self._log, f"arduino.{message.kind.lower()}", message.raw, level=logging.DEBUG)
            case "ERR":
                detail = message.fields[1] if len(message.fields) > 1 else ""
                log_event(self._log, "arduino.error", "Arduino 오류 보고", level=logging.WARNING,
                          code=message.fields[0], detail=detail)
                await self._forward_audit("protocol_error", detail=f"{message.fields[0]}:{detail}")

    async def _handle_button(self, button_id: int, action: str) -> None:
        log_event(self._log, "button.received", "버튼 입력", button_id=button_id, action=action)

        if self._cloud is None or not self._seats.can_forward_requests():
            log_event(self._log, "button.rejected_offline", "클라우드 미연결/상태 미확인 - 입력 거부",
                      level=logging.WARNING, button_id=button_id, action=action)
            await self._send_status()
            return

        try:
            result = await self._cloud.post_device_event("button", button_id=button_id, action=action)
        except CloudUnavailableError as exc:
            self._seats.mark_cloud_offline()
            log_event(self._log, "button.forward_failed", "버튼 이벤트 전달 실패 - 입력 거부",
                      level=logging.WARNING, button_id=button_id, error=str(exc))
            await self._send_status()
            return
        except CloudRequestRejected as exc:
            log_event(self._log, "button.rejected_by_server", "서버가 버튼 이벤트를 거부",
                      level=logging.WARNING, button_id=button_id, status=exc.status, code=exc.code)
            return
        log_event(self._log, "button.forwarded", "버튼 이벤트 전달 완료", button_id=button_id, result=result)

    async def on_serial_connection_change(self, connected: bool) -> None:
        if connected:
            await self._send_status()
            await self._forward_audit("serial_connected")
        else:
            self._seats.on_serial_disconnected()
            await self._forward_audit("serial_disconnected")

    # ----- 클라우드 -> 에이전트 -----

    async def on_cloud_connection_change(self, connected: bool) -> None:
        if connected:
            self._seats.mark_cloud_online()
            await self.refresh_seats()
        else:
            self._seats.mark_cloud_offline()
        await self._send_status()

    async def on_cloud_message(self, message: dict[str, Any]) -> None:
        match message.get("type"):
            case "seats.changed":
                self._maybe_welcome(message)
                await self.refresh_seats()
            case "device.command":
                if self._on_command is None:
                    log_event(self._log, "command.ignored", "원격 명령 처리기 없음", level=logging.WARNING)
                else:
                    await self._on_command(message)
            case "hello":
                log_event(self._log, "cloud.hello", "클라우드 세션 시작", role=message.get("role"))
            case "pong":
                pass
            case other:
                log_event(self._log, "cloud.unknown_message", "알 수 없는 클라우드 메시지",
                          level=logging.DEBUG, type=other)

    async def refresh_seats(self) -> bool:
        if self._cloud is None:
            return False
        try:
            seats = await self._cloud.fetch_seats()
            self._seats.apply_snapshot(seats)
            return True
        except (CloudUnavailableError, CloudRequestRejected, SnapshotError) as exc:
            log_event(self._log, "seats.refresh_failed", "좌석 스냅샷 갱신 실패", level=logging.WARNING,
                      error=str(exc))
            return False

    # ----- 내부 -----

    def _maybe_welcome(self, message: dict[str, Any]) -> None:
        """이 장치 담당 열람실 좌석의 착석 알림이면 LCD 에 Welcome 표시."""
        if self._display is None or message.get("reason") != CHECK_IN_REASON:
            return
        try:
            seat = self._seats.get(int(message.get("seat_id")))
        except (TypeError, ValueError, KeyError):
            return
        if seat.room != self._display.room:
            return
        self._display.show_welcome()
        log_event(self._log, "lcd.welcome", "착석 확인 - Welcome 표시", room=seat.room, seat=seat.label)

    async def _send_status(self) -> None:
        if self._serial is None or not self._serial.connected:
            return
        status = "ONLINE" if self._seats.can_forward_requests() else "OFFLINE"
        await self._serial.send("STATUS", status)

    async def _forward_audit(self, event_type: str, **fields: Any) -> None:
        """감사용 장치 이벤트 전송 (최선 노력). 오프라인이면 로컬 로그에만 남는다."""
        if self._cloud is None or not self._seats.cloud_online:
            log_event(self._log, "audit.local_only", "오프라인 - 로컬 로그에만 기록", level=logging.DEBUG,
                      device_event=event_type, **fields)
            return
        try:
            await self._cloud.post_device_event(event_type, **fields)
        except (CloudUnavailableError, CloudRequestRejected) as exc:
            log_event(self._log, "audit.forward_failed", "감사 이벤트 전송 실패", level=logging.WARNING,
                      device_event=event_type, error=str(exc))
