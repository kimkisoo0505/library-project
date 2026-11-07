"""에이전트 실행 진입점.

실행:  python -m agent.main   (raspberry-pi 디렉터리에서)
종료:  Ctrl+C 또는 SIGTERM (systemd stop)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
import sys
from pathlib import Path

from . import __version__
from .cloud_client import CloudClient, CloudRequestRejected, CloudUnavailableError
from .config import AgentConfig, ConfigError, load_config, load_dotenv_file
from . import arduino_rooms                                         # arduino_rooms (제거 시 이 줄 삭제)
from .device_status import DeviceStatusReporter
from .remote_command import RemoteCommandHandler
from .event_handler import EventHandler
from .lcd_display import create_lcd
from .library_status import LibraryStatusRelay
from .logger import get_logger, log_event, setup_logging
from .room_display import RoomDisplay
from .seat_manager import SeatManager
from .serial_manager import SerialManager

LCD_RETRY_SECONDS = 30.0

AGENT_ROOT = Path(__file__).resolve().parent.parent


async def _heartbeat(serial: SerialManager, interval: float, stop: asyncio.Event) -> None:
    seq = 0
    while not stop.is_set():
        if serial.connected:
            seq = (seq + 1) % 10_000
            await serial.send("PING", str(seq))
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)


async def _periodic_sync(handler: EventHandler, seats: SeatManager, interval: float, stop: asyncio.Event) -> None:
    """WebSocket 알림을 놓쳐도 주기적으로 스냅샷을 다시 받아 복구한다."""
    while not stop.is_set():
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)
        if not stop.is_set() and seats.cloud_online:
            await handler.refresh_seats()


async def _lcd_loop(lcd, display: RoomDisplay, stop: asyncio.Event, colors: tuple = ((0, 255, 0), (255, 0, 0))) -> None:
    """화면 내용이 바뀔 때만 LCD 에 쓴다. LCD 오류는 다른 기능에 영향을 주지 않으며 30초 후 재시도.

    colors: (평상시, Offline) 백라이트 색상. RGB 미지원 LCD 에서는 무시된다.
    """
    log = get_logger("lcd")
    last = None
    while not stop.is_set():
        if not lcd.is_open:
            try:
                await asyncio.to_thread(lcd.open)
                last = None
                log_event(log, "lcd.connected", "LCD 연결", bus=lcd.bus_number, address=hex(lcd.address))
            except Exception as exc:  # noqa: BLE001
                log_event(log, "lcd.error", "LCD 연결 실패 - 30초 후 재시도", level=logging.WARNING, error=repr(exc))
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), timeout=LCD_RETRY_SECONDS)
                continue
        frame = display.frame()
        if frame != last:
            try:
                await asyncio.to_thread(lcd.set_color, colors[1] if frame.offline else colors[0])
                await asyncio.to_thread(lcd.write_lines, (frame.line1, frame.line2))
                last = frame
            except Exception as exc:  # noqa: BLE001
                log_event(log, "lcd.error", "LCD 쓰기 실패 - 재연결", level=logging.WARNING, error=repr(exc))
                lcd.close()
                continue
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=display.next_tick())
    if lcd.is_open:
        with contextlib.suppress(Exception):
            await asyncio.to_thread(lcd.write_lines, ("", ""))
        lcd.close()


class _DisabledSerial:
    """SERIAL_PORT=none 일 때 쓰는 빈 시리얼 (기존 버튼용 시리얼을 끄고 포트를 아두이노 열람실 LCD 에 양보)."""

    connected = False

    async def send(self, kind: str, *fields: str) -> bool:
        return False

    async def run(self, stop: asyncio.Event) -> None:
        await stop.wait()


async def run_agent(config: AgentConfig) -> None:
    log = get_logger("main")
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stop.set)  # Windows 에서는 지원되지 않음

    seats = SeatManager(stale_after_seconds=config.seat_stale_seconds)
    handler = EventHandler(seats)
    display = RoomDisplay(
        config.device_room,
        seats,
        welcome_seconds=config.lcd_welcome_seconds,
        erase_step_seconds=config.lcd_erase_step_seconds,
    )
    serial = SerialManager(
        config.serial_port,
        config.serial_baudrate,
        on_message=handler.on_serial_message,
        on_connection_change=handler.on_serial_connection_change,
        reconnect_seconds=config.serial_reconnect_seconds,
    ) if config.serial_enabled else _DisabledSerial()
    arduino_links = arduino_rooms.create_links(config, seats)       # 아두이노 담당 열람실 LCD (B, C)
    for link in arduino_links:                                       # arduino_rooms
        handler.add_welcome_display(link.display)                    # arduino_rooms

    async with CloudClient(
        config,
        on_message=handler.on_cloud_message,
        on_connection_change=handler.on_cloud_connection_change,
    ) as cloud:
        commands = RemoteCommandHandler(
            room=config.device_room,
            allow_shutdown=config.allow_remote_shutdown,
            report=cloud.post_device_event,
            show_message=display.show_message,
            clear_message=display.clear_message,
        )
        handler.attach(
            cloud=cloud,
            serial=serial,
            display=display if config.lcd_enabled else None,
            on_command=commands.handle,
        )

        with contextlib.suppress(CloudUnavailableError, CloudRequestRejected):
            await cloud.post_device_event("agent_started", detail=__version__)

        tasks = [
            asyncio.create_task(serial.run(stop), name="serial"),
            asyncio.create_task(cloud.run_websocket(stop), name="cloud-ws"),
            asyncio.create_task(_heartbeat(serial, config.heartbeat_seconds, stop), name="heartbeat"),
            asyncio.create_task(_periodic_sync(handler, seats, config.seat_sync_seconds, stop), name="sync"),
        ]
        lcd = None
        relay = None
        if config.lcd_enabled:
            lcd = create_lcd(config.lcd_type, config.lcd_i2c_bus, config.lcd_i2c_address, config.lcd_rgb_address)
            colors = (config.lcd_color_normal, config.lcd_color_offline)
            tasks.append(asyncio.create_task(_lcd_loop(lcd, display, stop, colors), name="lcd"))
        if config.central_library_relay:
            relay = LibraryStatusRelay(
                cloud,
                interval_seconds=config.central_library_interval_seconds,
                is_online=lambda: seats.cloud_online,
            )
            tasks.append(asyncio.create_task(relay.run(stop), name="central-library"))

        def components() -> dict:
            return {
                "lcd": None if lcd is None else lcd.is_open,               # None = 사용 안 함
                "serial": serial.connected,                                 # Arduino USB 연결
                "central_library": None if relay is None else relay.last_ok,
            }

        for link in arduino_links:                                    # arduino_rooms
            tasks.append(asyncio.create_task(                        # arduino_rooms
                link.run(stop, cloud, lambda: seats.cloud_online), name=f"arduino-{link.room}"))  # arduino_rooms

        reporter = DeviceStatusReporter(
            cloud, room=config.device_room, is_online=lambda: seats.cloud_online, components=components
        )
        tasks.append(asyncio.create_task(reporter.run(stop), name="device-status"))

        def _on_task_done(task: asyncio.Task[None]) -> None:
            if task.cancelled():
                return
            exc = task.exception()
            if exc is not None:
                log_event(log, "agent.task_crashed", "내부 작업 비정상 종료 - 에이전트 중지",
                          level=logging.ERROR, task=task.get_name(), error=repr(exc))
                stop.set()  # systemd Restart=on-failure 로 재시작되도록 종료

        for task in tasks:
            task.add_done_callback(_on_task_done)

        await stop.wait()
        log_event(log, "agent.stopping", "에이전트 종료 중")
        for task in tasks:
            task.cancel()
        results = await asyncio.gather(*tasks, return_exceptions=True)

    crashed = [r for r in results if isinstance(r, Exception) and not isinstance(r, asyncio.CancelledError)]
    if crashed:
        raise RuntimeError(f"{len(crashed)}개 작업이 비정상 종료됨")


def main() -> int:
    load_dotenv_file(AGENT_ROOT / ".env")
    try:
        config = load_config()
    except ConfigError as exc:
        print(f"[설정 오류] {exc}", file=sys.stderr)
        return 2

    setup_logging(config.log_dir, config.log_level)
    log = get_logger("main")
    log_event(log, "agent.start", "에이전트 시작", version=__version__, config=config.redacted())

    try:
        asyncio.run(run_agent(config))
    except KeyboardInterrupt:
        pass
    except Exception:  # noqa: BLE001
        log.exception("에이전트 비정상 종료")
        return 1
    log_event(log, "agent.stopped", "에이전트 종료")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
