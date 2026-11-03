import unittest

from agent.lcd_display import CharacterLcd, to_lcd_text


class FakeBus:
    def __init__(self, fail: bool = False) -> None:
        self.writes: list[tuple[int, int]] = []
        self.closed = False
        self.fail = fail

    def write_byte(self, address: int, value: int) -> None:
        if self.fail:
            raise OSError("Remote I/O error")
        self.writes.append((address, value))

    def close(self) -> None:
        self.closed = True


def decode(writes: list[tuple[int, int]]) -> list[tuple[str, int]]:
    """PCF8574 바이트열 -> (명령/데이터, 값). EN 하강(펄스 종료)마다 니블 하나."""
    nibbles = []
    prev = 0
    for _, value in writes:
        if prev & 0x04 and not value & 0x04:
            nibbles.append(((value >> 4) & 0x0F, value & 0x01))
        prev = value
    return nibbles


def bytes_from(nibbles: list[tuple[int, int]]) -> list[tuple[str, int]]:
    out = []
    for hi, lo in zip(nibbles[0::2], nibbles[1::2]):
        out.append(("data" if hi[1] else "cmd", (hi[0] << 4) | lo[0]))
    return out


class LcdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bus = FakeBus()
        self.lcd = CharacterLcd(1, 0x3E, bus_factory=lambda n: self.bus, sleep=lambda s: None)
        self.lcd.open()
        self.bus.writes.clear()

    def test_to_lcd_text(self) -> None:
        self.assertEqual(to_lcd_text("Use 3 Free 26", 16), "Use 3 Free 26   ")
        self.assertEqual(to_lcd_text("열람실A", 6), "???A  ")
        self.assertEqual(len(to_lcd_text("x" * 40, 16)), 16)

    def test_writes_to_configured_address_with_backlight(self) -> None:
        self.lcd.write_lines(("Welcome", "Use 1 Free 29"))
        self.assertTrue(self.bus.writes)
        self.assertTrue(all(addr == 0x3E for addr, _ in self.bus.writes))
        self.assertTrue(all(value & 0x08 for _, value in self.bus.writes), "백라이트 비트 유지")

    def test_first_write_positions_and_text(self) -> None:
        self.lcd.write_lines(("Welcome", ""))
        ops = bytes_from(decode(self.bus.writes))
        self.assertEqual(ops[0], ("cmd", 0x80))  # 1줄 0번 칸
        self.assertEqual("".join(chr(v) for kind, v in ops if kind == "data"), "Welcome")

    def test_only_changed_characters_rewritten(self) -> None:
        self.lcd.write_lines(("Welcome", "Use 1 Free 29"))
        self.bus.writes.clear()
        written = self.lcd.write_lines(("Welcom", "Use 1 Free 29"))   # 마지막 글자 하나만 지움
        self.assertEqual(written, 1)
        ops = bytes_from(decode(self.bus.writes))
        self.assertEqual(ops, [("cmd", 0x80 | 6), ("data", ord(" "))])
        self.assertEqual(self.lcd.write_lines(("Welcom", "Use 1 Free 29")), 0)

    def test_second_row_offset(self) -> None:
        self.lcd.write_lines(("", "Offline"))
        ops = bytes_from(decode(self.bus.writes))
        self.assertEqual(ops[0], ("cmd", 0x80 | 0x40))

    def test_open_failure_closes_bus(self) -> None:
        bad = FakeBus(fail=True)
        lcd = CharacterLcd(1, 0x3E, bus_factory=lambda n: bad, sleep=lambda s: None)
        with self.assertRaises(OSError):
            lcd.open()
        self.assertFalse(lcd.is_open)
        self.assertTrue(bad.closed)

    def test_write_requires_open(self) -> None:
        lcd = CharacterLcd(1, 0x3E, bus_factory=lambda n: FakeBus(), sleep=lambda s: None)
        with self.assertRaises(RuntimeError):
            lcd.write_lines(("a", "b"))


if __name__ == "__main__":
    unittest.main()
