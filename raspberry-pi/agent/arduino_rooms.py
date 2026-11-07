"""아두이노가 담당하는 열람실 LCD (예: 열람실 B, C) — 아두이노 관련 코드는 이 파일에만 있다.

구성
    라즈베리파이 ──USB 시리얼──▶ 아두이노 UNO ──I2C──▶ 16x2 LCD (PCF8574 백팩)
    펌웨어: arduino/firmware/room_lcd/room_lcd.ino  (프로토콜: arduino/protocol/SERIAL_PROTOCOL.md 의 ROOMLCD)

동작
    - 화면 내용은 라즈베리파이의 RoomDisplay(열람실 A 와 같은 로직)가 계산한다:
        1줄 평소 비어 있음 / 착석 시 "Welcome" 2초 후 끝 글자부터 지움
        2줄 "Use N Free M" / 클라우드 미연결이면 "Offline"
    - 화면이 바뀔 때, 그리고 10초마다(아두이노 감시 타이머 유지용) 두 줄을 보낸다.
      아두이노는 30초 동안 아무 명령이 없으면 스스로 "Offline" 을 표시한다 (라즈베리파이가 멈춰도 틀린 숫자를 계속 보여주지 않도록).
    - 30초마다 서버에 이 아두이노의 상태를 대신 보고한다 (장치 ID: arduino-b 등) → 키오스크 상태 표시줄
    - 서보모터 / 블루투스는 구현하지 않는다.

제거 방법 (아두이노 대신 라즈베리파이를 쓰게 되면)
    1) 이 파일과 tests/test_arduino_rooms.py 삭제
    2) agent/main.py 에서 "arduino_rooms" 가 들어간 줄 삭제
    3) agent/config.py 의 arduino_rooms / parse_arduino_rooms 삭제, .env 의 ARDUINO_ROOMS 삭제
    4) arduino/firmware/room_lcd/ 삭제
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

from . import __version__
from .logger import get_logger, log_event
from .room_display import Frame, RoomDisplay
from .seat_manager import SeatManager
from .serial_manager import SerialFactory, SerialManager, SerialMessage

LCD_COLS = 16
REFRESH_SECONDS = 10.0          # 화면이 그대로여도 이 간격으로 다시 보냄 (아두이노 감시 타이머 30초보다 짧게)
BOOT_WAIT_SECONDS = 3.0         # 포트를 열면 UNO 가 리셋됨 → HELLO 를 기다리되 최대 이 시간 후 전송 시작
STATUS_INTERVAL_SECONDS = 30.0
EXPECTED_FIRMWARE_PREFIX = "ROOMLCD"


class StatusCloud(Protocol):
    async def post_device_status(self, payload: dict[str, Any], *, device_id: str | None = None) -> dict[str, Any]: ...


def lcd_text(text: str) -> str:
    """LCD 로 보낼 수 있는 문자만 남긴다: ASCII 출력 문자(쉼표 제외), 최대 16자, 오른쪽 공백 제거."""
    safe = "".join(ch if 0x20 <= ord(ch) <= 0x7E and ch != "," else "?" for ch in text)
    return safe[:LCD_COLS].rstrip()


def build_lcd_line(row: int, text: str) -> bytes:
    """ROOMLCD 펌웨어 명령: LCD,<0|1>,<text>\\n"""
    if row not in (0, 1):
        raise ValueError(f"row 는 0 또는 1: {row}")
    return f"LCD,{row},{lcd_text(text)}\n".encode("ascii")


def device_id_for(room: str) -> str:
    return f"arduino-{room.lower()}"


class ArduinoRoomLink:
    """아두이노 1대 = 열람실 1곳의 LCD."""

    def __init__(
        self,
        room: str,
        port: str,
        seats: SeatManager,
        *,
        baudrate: int = 115200,
        welcome_seconds: float = 2.0,
        erase_step_seconds: float = 0.15,
        reconnect_seconds: float = 5.0,
        serial_factory: SerialFactory | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.room = room
        self.port = port
        self.display = RoomDisplay(room, seats, welcome_seconds=welcome_seconds, erase_step_seconds=erase_step_seconds)
        self.serial = SerialManager(
            port,
            baudrate,
            on_message=self._on_message,
            on_connection_change=self._on_connection,
            reconnect_seconds=reconnect_seconds,
            serial_factory=serial_factory,
        )
        self._clock = clock
        self.firmware: str | None = None
        self.lcd_missing = False             # 아두이노가 ERR,LCD_NOT_FOUND 보고
        self._connected_at: float | None = None
        self._last_frame: Frame | None = None
        self._last_sent = 0.0
        self._log = get_logger(f"arduino.{room.lower()}")

    # ----- 아두이노 → 라즈베리파이 -----

    async def _on_message(self, message: SerialMessage) -> None:
        match message.kind:
            case "HELLO":
                self.firmware = message.fields[0]
                self.lcd_missing = False
                self._last_frame = None  # 리셋된 화면을 바로 다시 그린다
                ok = self.firmware.startswith(EXPECTED_FIRMWARE_PREFIX)
                log_event(self._log, "arduino_room.hello", "아두이노 열람실 LCD 펌웨어 확인",
                          level=logging.INFO if ok else logging.WARNING, room=self.room, firmware=self.firmware)
            case "ERR":
                if message.fields[0] == "LCD_NOT_FOUND":
                    self.lcd_missing = True
                log_event(self._log, "arduino_room.error", "아두이노 오류 보고", level=logging.WARNING,
                          room=self.room, code=message.fields[0], detail=message.fields[1] if len(message.fields) > 1 else "")
            case _:
                log_event(self._log, "arduino_room.message", message.raw, level=logging.DEBUG, room=self.room)

    async def _on_connection(self, connected: bool) -> None:
        self.firmware = None
        self.lcd_missing = False
        self._last_frame = None
        self._connected_at = self._clock() if connected else None
        log_event(self._log, "arduino_room.connected" if connected else "arduino_room.disconnected",
                  "아두이노 연결" if connected else "아두이노 연결 끊김",
                  level=logging.INFO if connected else logging.WARNING, room=self.room, port=self.port)

    # ----- 라즈베리파이 → 아두이노 -----

    def _ready(self) -> bool:
        if not self.serial.connected or self._connected_at is None:
            return False
        return self.firmware is not None or self._clock() - self._connected_at >= BOOT_WAIT_SECONDS

    async def push_frame(self, *, force: bool = False) -> bool:
        """화면이 바뀌었거나 새로고침 시간이 되면 두 줄을 보낸다. 보냈으면 True."""
        if not self._ready():
            return False
        frame = self.display.frame()
        now = self._clock()
        if not force and frame == self._last_frame and now - self._last_sent < REFRESH_SECONDS:
            return False
        ok = await self.serial.send_line(build_lcd_line(0, frame.line1), kind="LCD")
        ok = ok and await self.serial.send_line(build_lcd_line(1, frame.line2), kind="LCD")
        if ok:
            self._last_frame = frame
            self._last_sent = now
        return ok

    async def _display_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await self.push_frame()
            except Exception as exc:  # noqa: BLE001 - 화면 전송 오류가 에이전트를 멈추지 않도록
                log_event(self._log, "arduino_room.send_failed", "LCD 전송 실패", level=logging.WARNING,
                          room=self.room, error=repr(exc))
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.display.next_tick())
            except TimeoutError:
                pass

    # ----- 서버 보고 -----

    def status_payload(self) -> dict[str, Any]:
        return {
            "room": self.room,
            "agent_version": __version__,
            "network": {"type": "none"},        # 아두이노 자체는 네트워크 없음 (라즈베리파이 USB 경유)
            "serial": self.serial.connected,
            "lcd": (self.firmware is not None and self.firmware.startswith(EXPECTED_FIRMWARE_PREFIX)
                    and not self.lcd_missing),
        }

    async def _status_loop(self, cloud: StatusCloud, is_online: Callable[[], bool], stop: asyncio.Event) -> None:
        while not stop.is_set():
            # 아두이노가 USB 로 연결되어 있을 때만 "연결됨" 으로 보고 (빠지면 보고를 멈춰 90초 후 연결 안 됨 표시)
            if is_online() and self.serial.connected:
                try:
                    await cloud.post_device_status(self.status_payload(), device_id=device_id_for(self.room))
                except Exception as exc:  # noqa: BLE001
                    log_event(self._log, "arduino_room.status_failed", "상태 보고 실패", level=logging.WARNING,
                              room=self.room, error=repr(exc))
            try:
                await asyncio.wait_for(stop.wait(), timeout=STATUS_INTERVAL_SECONDS)
            except TimeoutError:
                pass

    async def run(self, stop: asyncio.Event, cloud: StatusCloud, is_online: Callable[[], bool]) -> None:
        await asyncio.gather(
            self.serial.run(stop),
            self._display_loop(stop),
            self._status_loop(cloud, is_online, stop),
        )


def create_links(config: Any, seats: SeatManager) -> list[ArduinoRoomLink]:
    """설정(ARDUINO_ROOMS)대로 아두이노 열람실 링크를 만든다. 비어 있으면 빈 목록."""
    return [
        ArduinoRoomLink(
            room,
            port,
            seats,
            baudrate=config.serial_baudrate,
            welcome_seconds=config.lcd_welcome_seconds,
            erase_step_seconds=config.lcd_erase_step_seconds,
            reconnect_seconds=config.serial_reconnect_seconds,
        )
        for room, port in config.arduino_rooms
    ]
