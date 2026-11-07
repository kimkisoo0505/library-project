"""Arduino USB 시리얼 연결 관리 및 프로토콜 파싱.

프로토콜 규격: arduino/protocol/SERIAL_PROTOCOL.md
- 줄 단위 ASCII, 필드 구분자 ',', 줄 끝 '\\n', 최대 64자
- 연결이 끊기면 재연결을 시도하며, 연결 상태 변화는 콜백으로만 알린다.
  (연결 단절이 좌석 상태를 바꾸지 않도록 이 모듈은 좌석을 전혀 다루지 않는다.)
- 서보 명령(SERVO)은 전송 자체가 금지되어 있다.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

from .logger import get_logger, log_event

MAX_LINE_LENGTH = 64
FIELD_PATTERN = re.compile(r"^[A-Z0-9_.\-]{1,24}$")

# 종류 -> (최소 필드 수, 최대 필드 수)
INBOUND_ARITY: dict[str, tuple[int, int]] = {
    "HELLO": (1, 1),   # HELLO,<firmware_version>
    "BTN": (2, 2),     # BTN,<button_id>,<PRESS|LONG>
    "PONG": (1, 1),    # PONG,<seq>
    "ACK": (1, 2),     # ACK,<command>[,<value>]
    "ERR": (1, 2),     # ERR,<code>[,<detail>]
}
OUTBOUND_ARITY: dict[str, tuple[int, int]] = {
    "PING": (1, 1),    # PING,<seq>
    "STATUS": (1, 1),  # STATUS,<ONLINE|OFFLINE>
}
FORBIDDEN_OUTBOUND = frozenset({"SERVO"})
BUTTON_ACTIONS = frozenset({"PRESS", "LONG"})
STATUS_VALUES = frozenset({"ONLINE", "OFFLINE"})


class ProtocolError(ValueError):
    """시리얼 프로토콜 규격에 맞지 않는 메시지."""


@dataclass(frozen=True, slots=True)
class SerialMessage:
    kind: str
    fields: tuple[str, ...]
    raw: str


def _validate_fields(fields: tuple[str, ...]) -> None:
    for value in fields:
        if not FIELD_PATTERN.match(value):
            raise ProtocolError(f"허용되지 않는 필드 값: {value!r}")


def parse_line(raw: str | bytes) -> SerialMessage:
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("ascii")
        except UnicodeDecodeError as exc:
            raise ProtocolError("ASCII가 아닌 데이터") from exc
    line = raw.strip("\r\n ")
    if not line:
        raise ProtocolError("빈 줄")
    if len(line) > MAX_LINE_LENGTH:
        raise ProtocolError("줄 길이 초과")

    kind, *rest = line.split(",")
    fields = tuple(rest)
    if kind not in INBOUND_ARITY:
        raise ProtocolError(f"알 수 없는 메시지 종류: {kind!r}")
    low, high = INBOUND_ARITY[kind]
    if not low <= len(fields) <= high:
        raise ProtocolError(f"{kind} 필드 개수 오류: {len(fields)}")
    _validate_fields(fields)

    if kind == "BTN":
        if not fields[0].isdigit():
            raise ProtocolError("버튼 번호는 숫자여야 합니다")
        if fields[1] not in BUTTON_ACTIONS:
            raise ProtocolError(f"알 수 없는 버튼 동작: {fields[1]!r}")
    return SerialMessage(kind=kind, fields=fields, raw=line)


def build_command(kind: str, *fields: str) -> bytes:
    if kind in FORBIDDEN_OUTBOUND:
        raise ProtocolError("서보 명령은 현재 단계에서 비활성화되어 있습니다.")
    if kind not in OUTBOUND_ARITY:
        raise ProtocolError(f"전송할 수 없는 명령: {kind!r}")
    low, high = OUTBOUND_ARITY[kind]
    if not low <= len(fields) <= high:
        raise ProtocolError(f"{kind} 필드 개수 오류: {len(fields)}")
    _validate_fields(fields)
    if kind == "STATUS" and fields[0] not in STATUS_VALUES:
        raise ProtocolError(f"STATUS 값 오류: {fields[0]!r}")
    line = ",".join((kind, *fields))
    if len(line) > MAX_LINE_LENGTH:
        raise ProtocolError("명령 길이 초과")
    return (line + "\n").encode("ascii")


class SerialPort(Protocol):
    def readline(self) -> bytes: ...
    def write(self, data: bytes) -> int | None: ...
    def close(self) -> None: ...


SerialFactory = Callable[[str, int], SerialPort]
MessageCallback = Callable[[SerialMessage], Awaitable[None]]
ConnectionCallback = Callable[[bool], Awaitable[None]]


def default_serial_factory(port: str, baudrate: int) -> SerialPort:
    import serial  # pyserial (지연 import: 테스트 환경에서는 필요 없음)

    return serial.Serial(port=port, baudrate=baudrate, timeout=1.0, write_timeout=1.0)


class SerialManager:
    def __init__(
        self,
        port: str,
        baudrate: int,
        *,
        on_message: MessageCallback,
        on_connection_change: ConnectionCallback,
        reconnect_seconds: float = 5.0,
        serial_factory: SerialFactory | None = None,
    ) -> None:
        self._port = port
        self._baudrate = baudrate
        self._on_message = on_message
        self._on_connection_change = on_connection_change
        self._reconnect_seconds = reconnect_seconds
        self._factory = serial_factory or default_serial_factory
        self._serial: SerialPort | None = None
        self._write_lock = asyncio.Lock()
        self._log = get_logger("serial")

    @property
    def connected(self) -> bool:
        return self._serial is not None

    async def run(self, stop_event: asyncio.Event) -> None:
        """연결 -> 읽기 -> (오류 시) 정리 -> 대기 -> 재연결 을 stop_event 까지 반복."""
        while not stop_event.is_set():
            try:
                await self._open()
                await self._read_loop(stop_event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 하드웨어 오류는 종류가 다양함
                log_event(self._log, "serial.error", "시리얼 오류", level=logging.WARNING,
                          port=self._port, error=repr(exc))
            finally:
                await self._close()

            if stop_event.is_set():
                break
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._reconnect_seconds)
            except TimeoutError:
                pass

    async def _open(self) -> None:
        self._serial = await asyncio.to_thread(self._factory, self._port, self._baudrate)
        log_event(self._log, "serial.connected", "Arduino 연결됨", port=self._port, baudrate=self._baudrate)
        await self._notify(True)

    async def _close(self) -> None:
        if self._serial is None:
            return
        ser, self._serial = self._serial, None
        try:
            await asyncio.to_thread(ser.close)
        except Exception:  # noqa: BLE001
            pass
        log_event(self._log, "serial.disconnected", "Arduino 연결 끊김", level=logging.WARNING, port=self._port)
        await self._notify(False)

    async def _read_loop(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            ser = self._serial
            if ser is None:
                return
            raw = await asyncio.to_thread(ser.readline)
            if not raw:
                continue  # 읽기 타임아웃
            try:
                message = parse_line(raw)
            except ProtocolError as exc:
                log_event(self._log, "serial.protocol_error", "잘못된 시리얼 메시지", level=logging.WARNING,
                          error=str(exc), raw=repr(raw[:MAX_LINE_LENGTH]))
                continue
            try:
                await self._on_message(message)
            except Exception:  # noqa: BLE001
                self._log.exception("시리얼 메시지 처리 중 오류")

    async def send(self, kind: str, *fields: str) -> bool:
        """명령 전송. 연결되어 있지 않으면 False. 금지/형식 오류 명령은 ProtocolError."""
        return await self.send_line(build_command(kind, *fields), kind=kind)

    async def send_line(self, data: bytes, *, kind: str = "RAW") -> bool:
        """이미 검증된 한 줄(끝이 '\\n', 64자 이하 ASCII)을 그대로 보낸다.

        펌웨어 전용 명령(예: 열람실 LCD 문자열)은 그 모듈이 직접 만들고 검증한 뒤 이 메서드로 보낸다.
        """
        if not data.endswith(b"\n") or len(data) > MAX_LINE_LENGTH + 1 or b"\n" in data[:-1]:
            raise ProtocolError("한 줄 명령이 아닙니다")
        if kind.upper().startswith("SERVO") or data.upper().startswith(b"SERVO"):
            raise ProtocolError("서보 명령은 현재 단계에서 비활성화되어 있습니다.")
        ser = self._serial
        if ser is None:
            log_event(self._log, "serial.send_skipped", "연결 없음 - 전송 생략", level=logging.DEBUG, kind=kind)
            return False
        async with self._write_lock:
            try:
                await asyncio.to_thread(ser.write, data)
                return True
            except Exception as exc:  # noqa: BLE001
                log_event(self._log, "serial.send_failed", "시리얼 전송 실패", level=logging.WARNING,
                          kind=kind, error=repr(exc))
                return False

    async def _notify(self, connected: bool) -> None:
        try:
            await self._on_connection_change(connected)
        except Exception:  # noqa: BLE001
            self._log.exception("연결 상태 콜백 오류")
