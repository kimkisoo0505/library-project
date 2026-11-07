"""아두이노 열람실 LCD (agent/arduino_rooms.py) 테스트 — 하드웨어 없이 가짜 시리얼 사용.

아두이노를 제거하게 되면 이 파일도 함께 삭제한다.
"""
import logging
import unittest
from typing import Any

from agent.arduino_rooms import ArduinoRoomLink, build_lcd_line, device_id_for, lcd_text
from agent.config import ConfigError, load_config, parse_arduino_rooms
from agent.event_handler import EventHandler
from agent.seat_manager import TOTAL_SEATS, SeatManager, default_label
from agent.serial_manager import ProtocolError, SerialManager, SerialMessage

logging.getLogger("agent").setLevel(logging.CRITICAL)
PORT_B = "/dev/serial/by-id/usb-Arduino__www.arduino.cc__0043_85734323530351917281-if00"


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class FakePort:
    def __init__(self) -> None:
        self.written: list[bytes] = []

    def readline(self) -> bytes:
        return b""

    def write(self, data: bytes) -> int:
        self.written.append(data)
        return len(data)

    def close(self) -> None:
        pass


def snapshot(overrides: dict[int, str]) -> list[dict]:
    rows = []
    for i in range(1, TOTAL_SEATS + 1):
        room, label = default_label(i)
        rows.append({"id": i, "room": room, "label": label, "state": overrides.get(i, "available")})
    return rows


class TextTests(unittest.TestCase):
    def test_lcd_text(self) -> None:
        self.assertEqual(lcd_text("Use 3 Free 27"), "Use 3 Free 27")
        self.assertEqual(lcd_text("a,b"), "a?b", "쉼표는 프로토콜 구분자라 바꿈")
        self.assertEqual(lcd_text("열람실B"), "???B")
        self.assertEqual(len(lcd_text("x" * 40)), 16)
        self.assertEqual(lcd_text("Welcome   "), "Welcome")

    def test_build_lcd_line(self) -> None:
        self.assertEqual(build_lcd_line(0, "Welcome"), b"LCD,0,Welcome\n")
        self.assertEqual(build_lcd_line(1, ""), b"LCD,1,\n")
        with self.assertRaises(ValueError):
            build_lcd_line(2, "x")
        self.assertLessEqual(len(build_lcd_line(1, "y" * 100)), 23)

    def test_device_id(self) -> None:
        self.assertEqual(device_id_for("B"), "arduino-b")


class LinkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.seats = SeatManager(clock=self.clock)
        self.seats.mark_cloud_online()
        # 열람실 B (31~60): 31 착석, 32 예약 / A 의 1번 착석은 B 집계에 포함되면 안 됨
        self.seats.apply_snapshot(snapshot({31: "occupied", 32: "reserved", 1: "occupied"}))
        self.port = FakePort()
        self.link = ArduinoRoomLink("B", PORT_B, self.seats, clock=self.clock)
        self.link.display._clock = self.clock

    async def connect(self, hello: bool = True) -> None:
        self.link.serial._serial = self.port          # 실제 포트 대신 가짜 연결
        await self.link._on_connection(True)
        if hello:
            await self.link._on_message(SerialMessage("HELLO", ("ROOMLCD-0.1.0",), "HELLO,ROOMLCD-0.1.0"))

    async def test_waits_for_hello_or_boot_timeout(self) -> None:
        await self.connect(hello=False)
        self.assertFalse(await self.link.push_frame(), "부팅 대기 중에는 보내지 않음")
        self.clock.now += 3.1
        self.assertTrue(await self.link.push_frame(), "HELLO 가 없어도 3초 후에는 보냄")

    async def test_sends_room_counts_after_hello(self) -> None:
        await self.connect()
        self.assertTrue(await self.link.push_frame())
        self.assertEqual(self.port.written, [b"LCD,0,\n", b"LCD,1,Use 2 Free 28\n"])

    async def test_no_resend_until_change_or_refresh(self) -> None:
        await self.connect()
        await self.link.push_frame()
        self.port.written.clear()
        self.assertFalse(await self.link.push_frame(), "같은 화면은 다시 보내지 않음")
        self.clock.now += 10.1
        self.assertTrue(await self.link.push_frame(), "10초마다 다시 보내 아두이노 감시 타이머 유지")
        self.assertEqual(len(self.port.written), 2)

    async def test_welcome_and_offline(self) -> None:
        await self.connect()
        await self.link.push_frame()
        self.port.written.clear()
        self.link.display.show_welcome()
        await self.link.push_frame()
        self.assertEqual(self.port.written[0], b"LCD,0,Welcome\n")
        self.seats.mark_cloud_offline()
        self.clock.now += 5
        await self.link.push_frame()
        self.assertEqual(self.port.written[-1], b"LCD,1,Offline\n")

    async def test_hello_forces_redraw_after_arduino_reset(self) -> None:
        await self.connect()
        await self.link.push_frame()
        self.port.written.clear()
        await self.link._on_message(SerialMessage("HELLO", ("ROOMLCD-0.1.0",), "HELLO,ROOMLCD-0.1.0"))
        self.assertTrue(await self.link.push_frame(), "아두이노가 리셋되면 바로 다시 그림")

    async def test_status_payload(self) -> None:
        await self.connect()
        p = self.link.status_payload()
        self.assertEqual((p["room"], p["serial"], p["lcd"], p["network"]["type"]), ("B", True, True, "none"))
        await self.link._on_message(SerialMessage("ERR", ("LCD_NOT_FOUND", "3F"), "ERR,LCD_NOT_FOUND,3F"))
        self.assertFalse(self.link.status_payload()["lcd"], "LCD 가 응답하지 않으면 lcd=False")
        self.link.serial._serial = None                 # 실제로는 SerialManager 가 포트를 닫은 뒤 알림
        await self.link._on_connection(False)
        self.assertFalse(self.link.status_payload()["serial"])

    # ----- temperature (DHT11) -----
    async def test_temperature_reported_when_fresh(self) -> None:
        await self.connect()
        self.assertIsNone(self.link.status_payload()["environment"], "측정 전에는 None → 키오스크 '설치 예정'")
        await self.link._on_message(SerialMessage("TEMP", ("24.0", "45"), "TEMP,24.0,45"))
        self.assertEqual(self.link.status_payload()["environment"], {"temperature_c": 24.0, "humidity": 45})
        self.clock.now += 61
        self.assertIsNone(self.link.status_payload()["environment"], "60초 넘게 새 측정이 없으면 보내지 않음")

    async def test_temperature_validation_and_error(self) -> None:
        await self.connect()
        for fields in (("99.0", "45"), ("24.0", "150"), ("abc",), ("-30.0",)):
            await self.link._on_message(SerialMessage("TEMP", fields, "TEMP"))
        self.assertIsNone(self.link.climate, "범위 밖/형식 오류 값은 버림")
        await self.link._on_message(SerialMessage("ERR", ("TEMP_SENSOR",), "ERR,TEMP_SENSOR"))
        self.assertEqual(self.link.status_payload()["environment"], {"sensor_error": True})
        await self.link._on_message(SerialMessage("TEMP", ("23.5",), "TEMP,23.5"))
        self.assertEqual(self.link.status_payload()["environment"], {"temperature_c": 23.5, "humidity": None})

    def test_temp_message_parses(self) -> None:
        from agent.serial_manager import parse_line
        self.assertEqual(parse_line(b"TEMP,24.0,45\n").fields, ("24.0", "45"))
        self.assertEqual(parse_line(b"TEMP,-5.0\n").fields, ("-5.0",))

    async def test_status_loop_reports_as_arduino_device(self) -> None:
        import asyncio

        calls: list[tuple[dict, str | None]] = []

        class Cloud:
            async def post_device_status(self, payload: dict, *, device_id: str | None = None) -> dict:
                calls.append((payload, device_id))
                stop.set()
                return {}

        stop = asyncio.Event()
        await self.connect()
        await asyncio.wait_for(self.link._status_loop(Cloud(), lambda: True, stop), timeout=2)
        self.assertEqual(calls[0][1], "arduino-b")
        self.assertEqual(calls[0][0]["room"], "B")


class SendLineTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_line_guards(self) -> None:
        async def noop(*_: object) -> None:
            pass

        manager = SerialManager("FAKE", 115200, on_message=noop, on_connection_change=noop)
        self.assertFalse(await manager.send_line(b"LCD,0,hi\n"), "연결 없으면 False")
        for bad in (b"SERVO,1,90\n", b"LCD,0,a\nSERVO\n", b"no-newline", b"X" * 80 + b"\n"):
            with self.subTest(bad=bad[:20]), self.assertRaises(ProtocolError):
                await manager.send_line(bad)


class ConfigTests(unittest.TestCase):
    BASE = {"LIBRARY_API_BASE_URL": "https://api.example.invalid", "LIBRARY_DEVICE_TOKEN": "test-token-not-real-0123456789"}

    def test_parse_arduino_rooms(self) -> None:
        self.assertEqual(parse_arduino_rooms("", "A"), ())
        self.assertEqual(parse_arduino_rooms(f"b={PORT_B}, C=/dev/ttyACM1", "A"), (("B", PORT_B), ("C", "/dev/ttyACM1")))
        for bad in ("B", "B=ttyACM0", "A=/dev/ttyACM0", "BB=/dev/x", "B=/dev/x,B=/dev/y", "B=/dev/x,C=/dev/x", "B=/dev/a b"):
            with self.subTest(bad=bad), self.assertRaises(ConfigError):
                parse_arduino_rooms(bad, "A")

    def test_serial_none_and_conflict(self) -> None:
        config = load_config({**self.BASE, "SERIAL_PORT": "none", "ARDUINO_ROOMS": f"B={PORT_B}"})
        self.assertFalse(config.serial_enabled)
        self.assertEqual(config.arduino_rooms, (("B", PORT_B),))
        self.assertTrue(load_config(self.BASE).serial_enabled)
        self.assertEqual(load_config(self.BASE).arduino_rooms, ())
        with self.assertRaises(ConfigError):
            load_config({**self.BASE, "SERIAL_PORT": "/dev/ttyACM0", "ARDUINO_ROOMS": "B=/dev/ttyACM0"})


class WelcomeRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_check_in_shows_welcome_on_matching_room_only(self) -> None:
        class Display:
            def __init__(self, room: str) -> None:
                self.room, self.count = room, 0

            def show_welcome(self) -> None:
                self.count += 1

        class Dummy:
            connected = False
            async def send(self, *a: Any) -> bool: return False
            async def fetch_seats(self) -> list: return snapshot({})
            async def post_device_event(self, *a: Any, **k: Any) -> dict: return {}

        a, b = Display("A"), Display("B")
        handler = EventHandler(SeatManager())
        handler.attach(cloud=Dummy(), serial=Dummy(), display=a)
        handler.add_welcome_display(b)
        await handler.on_cloud_message({"type": "seats.changed", "seat_id": 35, "reason": "reservation.checked_in"})  # B05
        await handler.on_cloud_message({"type": "seats.changed", "seat_id": 3, "reason": "reservation.checked_in"})   # A03
        await handler.on_cloud_message({"type": "seats.changed", "seat_id": 65, "reason": "reservation.checked_in"})  # C05: 담당 없음
        self.assertEqual((a.count, b.count), (1, 1))


if __name__ == "__main__":
    unittest.main()
