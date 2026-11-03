import unittest

from agent.lcd_display import GroveRgbLcd, Pcf8574Lcd, create_lcd, to_lcd_text


class FakeBus:
    def __init__(self, fail: bool = False) -> None:
        self.writes: list[tuple[int, int]] = []              # write_byte (PCF8574)
        self.reg_writes: list[tuple[int, int, int]] = []     # write_byte_data (Grove)
        self.closed = False
        self.fail = fail

    def write_byte(self, address: int, value: int) -> None:
        if self.fail:
            raise OSError("Remote I/O error")
        self.writes.append((address, value))

    def write_byte_data(self, address: int, register: int, value: int) -> None:
        if self.fail:
            raise OSError("Remote I/O error")
        self.reg_writes.append((address, register, value))

    def close(self) -> None:
        self.closed = True


def no_sleep(_: float) -> None:
    pass


class TextTests(unittest.TestCase):
    def test_to_lcd_text(self) -> None:
        self.assertEqual(to_lcd_text("Use 3 Free 26", 16), "Use 3 Free 26   ")
        self.assertEqual(to_lcd_text("열람실A", 6), "???A  ")
        self.assertEqual(len(to_lcd_text("x" * 40, 16)), 16)

    def test_create_lcd(self) -> None:
        self.assertIsInstance(create_lcd("grove-rgb", 1, 0x3E), GroveRgbLcd)
        self.assertIsInstance(create_lcd("pcf8574", 1, 0x27), Pcf8574Lcd)
        with self.assertRaises(ValueError):
            create_lcd("oled", 1, 0x3C)


class GroveRgbLcdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bus = FakeBus()
        self.lcd = GroveRgbLcd(1, 0x3E, 0x62, bus_factory=lambda n: self.bus, sleep=no_sleep)
        self.lcd.open()

    def text_ops(self) -> list[tuple[str, int]]:
        return [("cmd" if reg == 0x80 else "data", v) for addr, reg, v in self.bus.reg_writes if addr == 0x3E]

    def test_init_sequence(self) -> None:
        ops = self.text_ops()
        self.assertEqual(ops[-3:], [("cmd", 0x0C), ("cmd", 0x01), ("cmd", 0x06)])  # 표시 ON, 지우기, 입력 모드
        self.assertIn(("cmd", 0x28), ops)  # 2줄 모드
        rgb_init = [(r, v) for a, r, v in self.bus.reg_writes if a == 0x62]
        self.assertEqual(rgb_init, [(0x00, 0x00), (0x01, 0x00), (0x08, 0xAA)])

    def test_text_uses_control_bytes(self) -> None:
        self.bus.reg_writes.clear()
        self.lcd.write_lines(("Welcome", ""))
        ops = self.text_ops()
        self.assertEqual(ops[0], ("cmd", 0x80))
        self.assertEqual("".join(chr(v) for kind, v in ops if kind == "data"), "Welcome")
        self.assertFalse(self.bus.writes, "Grove 는 write_byte(PCF8574 방식)를 쓰지 않음")

    def test_only_changed_characters_rewritten(self) -> None:
        self.lcd.write_lines(("Welcome", "Use 1 Free 29"))
        self.bus.reg_writes.clear()
        self.assertEqual(self.lcd.write_lines(("Welcom", "Use 1 Free 29")), 1)
        self.assertEqual(self.text_ops(), [("cmd", 0x80 | 6), ("data", ord(" "))])
        self.assertEqual(self.lcd.write_lines(("Welcom", "Use 1 Free 29")), 0)

    def test_second_row(self) -> None:
        self.bus.reg_writes.clear()
        self.lcd.write_lines(("", "Offline"))
        self.assertEqual(self.text_ops()[0], ("cmd", 0x80 | 0x40))

    def test_set_color_registers_and_dedup(self) -> None:
        self.bus.reg_writes.clear()
        self.lcd.set_color((0, 255, 0))
        self.assertEqual(self.bus.reg_writes, [(0x62, 0x04, 0), (0x62, 0x03, 255), (0x62, 0x02, 0)])
        self.lcd.set_color((0, 255, 0))
        self.assertEqual(len(self.bus.reg_writes), 3, "같은 색이면 다시 쓰지 않음")
        self.lcd.set_color((255, 0, 0))
        self.assertEqual(self.bus.reg_writes[-3:], [(0x62, 0x04, 255), (0x62, 0x03, 0), (0x62, 0x02, 0)])

    def test_open_failure_closes_bus(self) -> None:
        bad = FakeBus(fail=True)
        lcd = GroveRgbLcd(1, bus_factory=lambda n: bad, sleep=no_sleep)
        with self.assertRaises(OSError):
            lcd.open()
        self.assertFalse(lcd.is_open)
        self.assertTrue(bad.closed)

    def test_write_requires_open(self) -> None:
        lcd = GroveRgbLcd(1, bus_factory=lambda n: FakeBus(), sleep=no_sleep)
        with self.assertRaises(RuntimeError):
            lcd.write_lines(("a", "b"))


def pcf_decode(writes: list[tuple[int, int]]) -> list[tuple[str, int]]:
    """PCF8574 바이트열 -> (cmd/data, 값). EN 하강마다 니블 하나."""
    nibbles, prev = [], 0
    for _, value in writes:
        if prev & 0x04 and not value & 0x04:
            nibbles.append(((value >> 4) & 0x0F, value & 0x01))
        prev = value
    return [("data" if hi[1] else "cmd", (hi[0] << 4) | lo[0]) for hi, lo in zip(nibbles[0::2], nibbles[1::2])]


class Pcf8574LcdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bus = FakeBus()
        self.lcd = Pcf8574Lcd(1, 0x27, bus_factory=lambda n: self.bus, sleep=no_sleep)
        self.lcd.open()
        self.bus.writes.clear()

    def test_backlight_bit_and_address(self) -> None:
        self.lcd.write_lines(("Welcome", "Use 1 Free 29"))
        self.assertTrue(all(addr == 0x27 and value & 0x08 for addr, value in self.bus.writes))

    def test_text_and_partial_update(self) -> None:
        self.lcd.write_lines(("Welcome", ""))
        ops = pcf_decode(self.bus.writes)
        self.assertEqual(ops[0], ("cmd", 0x80))
        self.assertEqual("".join(chr(v) for k, v in ops if k == "data"), "Welcome")
        self.bus.writes.clear()
        self.assertEqual(self.lcd.write_lines(("Welcom", "")), 1)
        self.assertEqual(pcf_decode(self.bus.writes), [("cmd", 0x80 | 6), ("data", ord(" "))])

    def test_set_color_is_noop(self) -> None:
        self.lcd.set_color((255, 0, 0))
        self.assertFalse(self.bus.writes)


if __name__ == "__main__":
    unittest.main()
