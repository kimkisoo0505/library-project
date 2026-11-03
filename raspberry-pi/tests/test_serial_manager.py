import asyncio
import logging
import time
import unittest

from agent.serial_manager import (
    MAX_LINE_LENGTH,
    ProtocolError,
    SerialManager,
    SerialMessage,
    build_command,
    parse_line,
)

logging.getLogger("agent").setLevel(logging.CRITICAL)


class ParseLineTests(unittest.TestCase):
    def test_valid_messages(self) -> None:
        self.assertEqual(parse_line(b"HELLO,0.1.0\r\n"), SerialMessage("HELLO", ("0.1.0",), "HELLO,0.1.0"))
        self.assertEqual(parse_line("BTN,3,PRESS\n").fields, ("3", "PRESS"))
        self.assertEqual(parse_line("BTN,12,LONG").kind, "BTN")
        self.assertEqual(parse_line("PONG,42").fields, ("42",))
        self.assertEqual(parse_line("ERR,SERVO_DISABLED").fields, ("SERVO_DISABLED",))
        self.assertEqual(parse_line("ACK,STATUS,ONLINE").fields, ("STATUS", "ONLINE"))

    def test_invalid_messages(self) -> None:
        bad = [
            b"",
            b"\n",
            b"UNKNOWN,1",
            b"BTN,3",
            b"BTN,x,PRESS",
            b"BTN,3,TAP",
            b"btn,3,PRESS",
            b"HELLO,bad value",
            b"HELLO," + b"A" * MAX_LINE_LENGTH,
            b"\xff\xfe",
        ]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(ProtocolError):
                parse_line(raw)


class BuildCommandTests(unittest.TestCase):
    def test_allowed_commands(self) -> None:
        self.assertEqual(build_command("PING", "7"), b"PING,7\n")
        self.assertEqual(build_command("STATUS", "OFFLINE"), b"STATUS,OFFLINE\n")

    def test_servo_command_is_forbidden(self) -> None:
        with self.assertRaises(ProtocolError):
            build_command("SERVO", "1", "90")

    def test_injection_and_invalid_values_rejected(self) -> None:
        for args in (("PING", "1\nSERVO,1,90"), ("PING", "1,2"), ("STATUS", "MAYBE"), ("RESET",), ("PING",)):
            with self.subTest(args=args), self.assertRaises(ProtocolError):
                build_command(*args)


class FakeSerialPort:
    """readline 결과를 순서대로 돌려주고, 예외 항목을 만나면 단절을 흉내낸다."""

    def __init__(self, items: list[bytes | Exception]) -> None:
        self.items = list(items)
        self.written: list[bytes] = []
        self.closed = False

    def readline(self) -> bytes:
        if self.items:
            item = self.items.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        time.sleep(0.01)
        return b""

    def write(self, data: bytes) -> int:
        self.written.append(data)
        return len(data)

    def close(self) -> None:
        self.closed = True


class SerialManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_messages_skips_garbage_and_reports_disconnect(self) -> None:
        port = FakeSerialPort([b"HELLO,0.1.0\n", b"garbage\n", b"BTN,3,PRESS\n", OSError("unplugged")])
        messages: list[SerialMessage] = []
        states: list[bool] = []
        stop = asyncio.Event()

        async def on_message(msg: SerialMessage) -> None:
            messages.append(msg)

        async def on_connection(connected: bool) -> None:
            states.append(connected)
            if not connected:
                stop.set()

        manager = SerialManager("FAKE", 115200, on_message=on_message, on_connection_change=on_connection,
                                reconnect_seconds=0.01, serial_factory=lambda p, b: port)
        await asyncio.wait_for(manager.run(stop), timeout=5)

        self.assertEqual([m.kind for m in messages], ["HELLO", "BTN"])
        self.assertEqual(states, [True, False])
        self.assertTrue(port.closed)
        self.assertFalse(manager.connected)

    async def test_reconnects_after_open_failure(self) -> None:
        port = FakeSerialPort([])
        attempts = 0
        stop = asyncio.Event()

        def factory(p: str, b: int) -> FakeSerialPort:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise OSError("no device")
            return port

        async def on_message(msg: SerialMessage) -> None:
            pass

        async def on_connection(connected: bool) -> None:
            if connected:
                stop.set()

        manager = SerialManager("FAKE", 115200, on_message=on_message, on_connection_change=on_connection,
                                reconnect_seconds=0.01, serial_factory=factory)
        await asyncio.wait_for(manager.run(stop), timeout=5)
        self.assertEqual(attempts, 3)

    async def test_send_when_disconnected_returns_false(self) -> None:
        async def noop(*_: object) -> None:
            pass

        manager = SerialManager("FAKE", 115200, on_message=noop, on_connection_change=noop)
        self.assertFalse(await manager.send("PING", "1"))
        with self.assertRaises(ProtocolError):
            await manager.send("SERVO", "1", "90")


if __name__ == "__main__":
    unittest.main()
