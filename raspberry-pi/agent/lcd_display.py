"""I2C 16x2 캐릭터 LCD 드라이버.

지원 장치 (LCD_TYPE)
  grove-rgb : Seeed Grove LCD RGB Backlight v4 (기본)
              텍스트 컨트롤러 0x3E (명령 = 제어바이트 0x80, 데이터 = 0x40)
              RGB 백라이트 PCA9632 0x62 (R=0x04, G=0x03, B=0x02 레지스터)
  pcf8574   : 일반 I2C 백팩 (PCF8574/PCF8574A + HD44780, 4비트 모드)

공통
- 출력 전용 장치이며 액추에이터가 아니다.
- 화면 버퍼(shadow)를 두어 실제로 바뀐 글자만 다시 쓴다 (깜빡임/I2C 통신량 감소).
- ASCII 외 문자(한글 등)는 표시할 수 없으므로 '?' 로 바꾼다.
- smbus2 는 지연 import 한다 (테스트는 가짜 버스 사용).
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from typing import Protocol

RGB = tuple[int, int, int]

_CLEAR = 0x01
_ENTRY_MODE_INCREMENT = 0x06
_DISPLAY_ON_NO_CURSOR = 0x0C
_FUNCTION_2LINE_4BIT = 0x28
_SET_DDRAM = 0x80
_ROW_OFFSETS = (0x00, 0x40, 0x14, 0x54)


class I2CBus(Protocol):
    def write_byte(self, address: int, value: int) -> None: ...
    def write_byte_data(self, address: int, register: int, value: int) -> None: ...
    def close(self) -> None: ...


BusFactory = Callable[[int], I2CBus]


def default_bus_factory(bus_number: int) -> I2CBus:
    from smbus2 import SMBus  # 지연 import

    return SMBus(bus_number)


def to_lcd_text(text: str, width: int) -> str:
    """LCD 에 쓸 수 있는 ASCII 로 변환하고 폭에 맞춰 자르거나 공백으로 채운다."""
    safe = "".join(ch if 0x20 <= ord(ch) <= 0x7E else "?" for ch in text)
    return safe[:width].ljust(width)


class _ShadowLcd:
    """화면 버퍼 기반 공통 로직. 하위 클래스는 _init_controller / _command / _data 를 구현한다."""

    supports_color = False

    def __init__(
        self,
        bus_number: int,
        address: int,
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

    def _init_controller(self) -> None:
        raise NotImplementedError

    def _command(self, value: int) -> None:
        raise NotImplementedError

    def _data(self, value: int) -> None:
        raise NotImplementedError

    def open(self) -> None:
        self._bus = self._factory(self.bus_number)
        try:
            self._init_controller()
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
                end = col
                while end < self.cols and target[end] != current[end]:
                    end += 1
                self._command(_SET_DDRAM | (_ROW_OFFSETS[row] + col))
                for ch in target[col:end]:
                    self._data(ord(ch))
                written += end - col
                col = end
            self._shadow[row] = target
        return written

    def set_color(self, rgb: RGB) -> None:  # 색상 미지원 장치는 무시
        return None

    def close(self) -> None:
        bus, self._bus = self._bus, None
        if bus is not None:
            try:
                bus.close()
            except Exception:  # noqa: BLE001
                pass


class GroveRgbLcd(_ShadowLcd):
    """Seeed Grove LCD RGB Backlight v4 (텍스트 0x3E + PCA9632 0x62)."""

    supports_color = True
    _CMD = 0x80
    _DATA = 0x40
    # PCA9632 레지스터
    _MODE1, _MODE2, _LEDOUT = 0x00, 0x01, 0x08
    _RED, _GREEN, _BLUE = 0x04, 0x03, 0x02

    def __init__(self, bus_number: int = 1, address: int = 0x3E, rgb_address: int = 0x62, **kwargs) -> None:
        super().__init__(bus_number, address, **kwargs)
        self.rgb_address = rgb_address
        self._color: RGB | None = None

    def _command(self, value: int) -> None:
        assert self._bus is not None
        self._bus.write_byte_data(self.address, self._CMD, value)

    def _data(self, value: int) -> None:
        assert self._bus is not None
        self._bus.write_byte_data(self.address, self._DATA, value)

    def _init_controller(self) -> None:
        assert self._bus is not None
        self._sleep(0.05)
        for delay in (0.0045, 0.00015, 0.00015):
            self._command(_FUNCTION_2LINE_4BIT)
            self._sleep(delay)
        self._command(_FUNCTION_2LINE_4BIT)
        self._command(_DISPLAY_ON_NO_CURSOR)
        self._command(_CLEAR)
        self._sleep(0.002)
        self._command(_ENTRY_MODE_INCREMENT)
        # 백라이트 컨트롤러: 정상 모드, LED 별 PWM 제어
        self._bus.write_byte_data(self.rgb_address, self._MODE1, 0x00)
        self._bus.write_byte_data(self.rgb_address, self._MODE2, 0x00)
        self._bus.write_byte_data(self.rgb_address, self._LEDOUT, 0xAA)
        self._color = None

    def set_color(self, rgb: RGB) -> None:
        if self._bus is None:
            raise RuntimeError("LCD 가 열려 있지 않습니다")
        if rgb == self._color:
            return
        r, g, b = rgb
        self._bus.write_byte_data(self.rgb_address, self._RED, r)
        self._bus.write_byte_data(self.rgb_address, self._GREEN, g)
        self._bus.write_byte_data(self.rgb_address, self._BLUE, b)
        self._color = rgb


class Pcf8574Lcd(_ShadowLcd):
    """일반 I2C 백팩: P0=RS, P1=RW, P2=E, P3=백라이트, P4~P7=D4~D7"""

    _RS, _EN, _BACKLIGHT = 0x01, 0x04, 0x08

    def __init__(self, bus_number: int = 1, address: int = 0x27, **kwargs) -> None:
        super().__init__(bus_number, address, **kwargs)

    def _write(self, value: int) -> None:
        assert self._bus is not None
        self._bus.write_byte(self.address, value | self._BACKLIGHT)

    def _pulse(self, value: int) -> None:
        self._write(value | self._EN)
        self._sleep(0.0005)
        self._write(value & ~self._EN)
        self._sleep(0.0001)

    def _nibble(self, nibble: int, mode: int) -> None:
        self._pulse(((nibble & 0x0F) << 4) | mode)

    def _send(self, value: int, mode: int) -> None:
        self._nibble(value >> 4, mode)
        self._nibble(value, mode)

    def _command(self, value: int) -> None:
        self._send(value, 0)

    def _data(self, value: int) -> None:
        self._send(value, self._RS)

    def _init_controller(self) -> None:
        self._sleep(0.05)
        for delay in (0.0045, 0.0045, 0.00015):  # 8비트 모드로 3회 리셋
            self._nibble(0x03, 0)
            self._sleep(delay)
        self._nibble(0x02, 0)                    # 4비트 모드 진입
        self._command(_FUNCTION_2LINE_4BIT)
        self._command(_DISPLAY_ON_NO_CURSOR)
        self._command(_CLEAR)
        self._sleep(0.002)
        self._command(_ENTRY_MODE_INCREMENT)


LCD_TYPES = {"grove-rgb": GroveRgbLcd, "pcf8574": Pcf8574Lcd}


def create_lcd(lcd_type: str, bus_number: int, address: int, rgb_address: int = 0x62) -> _ShadowLcd:
    if lcd_type == "grove-rgb":
        return GroveRgbLcd(bus_number, address, rgb_address)
    if lcd_type == "pcf8574":
        return Pcf8574Lcd(bus_number, address)
    raise ValueError(f"지원하지 않는 LCD_TYPE: {lcd_type!r}")
