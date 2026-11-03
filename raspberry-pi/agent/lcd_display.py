"""I2C 캐릭터 LCD (16x2, PCF8574/PCF8574A 백팩 + HD44780) 드라이버.

배선(일반적인 I2C 백팩): P0=RS, P1=RW, P2=E, P3=백라이트, P4~P7=D4~D7 (4비트 모드)
- 출력 전용 장치이며 액추에이터가 아니다.
- 화면 버퍼(shadow)를 두어 실제로 바뀐 글자만 다시 쓴다 (깜빡임/I2C 통신량 감소).
- ASCII 외 문자(한글 등)는 HD44780 에서 표시할 수 없으므로 '?' 로 바꾼다.
- smbus2 는 지연 import 한다 (테스트는 가짜 버스 사용).
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from typing import Protocol

# PCF8574 핀 비트
_RS = 0x01
_EN = 0x04
_BACKLIGHT = 0x08

# HD44780 명령
_CLEAR = 0x01
_ENTRY_MODE_INCREMENT = 0x06
_DISPLAY_ON_NO_CURSOR = 0x0C
_FUNCTION_4BIT_2LINE = 0x28
_SET_DDRAM = 0x80
_ROW_OFFSETS = (0x00, 0x40, 0x14, 0x54)


class I2CBus(Protocol):
    def write_byte(self, address: int, value: int) -> None: ...
    def close(self) -> None: ...


BusFactory = Callable[[int], I2CBus]


def default_bus_factory(bus_number: int) -> I2CBus:
    from smbus2 import SMBus  # 지연 import

    return SMBus(bus_number)


def to_lcd_text(text: str, width: int) -> str:
    """LCD 에 쓸 수 있는 ASCII 로 변환하고 폭에 맞춰 자르거나 공백으로 채운다."""
    safe = "".join(ch if 0x20 <= ord(ch) <= 0x7E else "?" for ch in text)
    return safe[:width].ljust(width)


class CharacterLcd:
    def __init__(
        self,
        bus_number: int = 1,
        address: int = 0x3E,
        cols: int = 16,
        rows: int = 2,
        *,
        bus_factory: BusFactory | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.bus_number = bus_number
        self.address = address
        self.cols = cols
        self.rows = rows
        self._factory = bus_factory or default_bus_factory
        self._sleep = sleep
        self._bus: I2CBus | None = None
        self._shadow: list[str] = []

    @property
    def is_open(self) -> bool:
        return self._bus is not None

    # ----- 저수준 -----

    def _write(self, value: int) -> None:
        assert self._bus is not None
        self._bus.write_byte(self.address, value | _BACKLIGHT)

    def _pulse(self, value: int) -> None:
        self._write(value | _EN)
        self._sleep(0.0005)
        self._write(value & ~_EN)
        self._sleep(0.0001)

    def _send_nibble(self, nibble: int, mode: int) -> None:
        self._pulse(((nibble & 0x0F) << 4) | mode)

    def _send(self, value: int, mode: int = 0) -> None:
        self._send_nibble(value >> 4, mode)
        self._send_nibble(value, mode)

    def _command(self, value: int) -> None:
        self._send(value, 0)

    # ----- 공개 API -----

    def open(self) -> None:
        """버스를 열고 HD44780 을 4비트 모드로 초기화한다."""
        self._bus = self._factory(self.bus_number)
        try:
            self._sleep(0.05)
            for delay in (0.0045, 0.0045, 0.00015):  # 8비트 모드로 3회 리셋
                self._send_nibble(0x03, 0)
                self._sleep(delay)
            self._send_nibble(0x02, 0)              # 4비트 모드 진입
            self._command(_FUNCTION_4BIT_2LINE)
            self._command(_DISPLAY_ON_NO_CURSOR)
            self._command(_CLEAR)
            self._sleep(0.002)
            self._command(_ENTRY_MODE_INCREMENT)
        except Exception:
            self.close()
            raise
        self._shadow = [" " * self.cols for _ in range(self.rows)]

    def write_lines(self, lines: Sequence[str]) -> int:
        """각 줄을 표시한다. 바뀐 글자만 다시 쓰며, 다시 쓴 글자 수를 돌려준다."""
        if self._bus is None:
            raise RuntimeError("LCD 가 열려 있지 않습니다")
        written = 0
        for row in range(self.rows):
            target = to_lcd_text(lines[row] if row < len(lines) else "", self.cols)
            current = self._shadow[row]
            col = 0
            while col < self.cols:
                if target[col] == current[col]:
                    col += 1
                    continue
                # 연속으로 바뀐 구간을 한 번에 쓴다
                end = col
                while end < self.cols and target[end] != current[end]:
                    end += 1
                self._command(_SET_DDRAM | (_ROW_OFFSETS[row] + col))
                for ch in target[col:end]:
                    self._send(ord(ch), _RS)
                written += end - col
                col = end
            self._shadow[row] = target
        return written

    def close(self) -> None:
        bus, self._bus = self._bus, None
        if bus is not None:
            try:
                bus.close()
            except Exception:  # noqa: BLE001
                pass
