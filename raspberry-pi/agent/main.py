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
from .event_handler import EventHandler
from .logger import get_logger, log_event, setup_logging
from .seat_manager import SeatManager
from .serial_manager import SerialManager

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


async def run_agent(config: AgentConfig) -> None:
    log = get_logger("main")
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stop.set)  # Windows 에서는 지원되지 않음

    seats = SeatManager(stale_after_seconds=config.seat_stale_seconds)
    handler = EventHandler(seats)
    serial = SerialManager(
        config.serial_port,
        config.serial_baudrate,
        on_message=handler.on_serial_message,
        on_connection_change=handler.on_serial_connection_change,
        reconnect_seconds=config.serial_reconnect_seconds,
    )

    async with CloudClient(
        config,
        on_message=handler.on_cloud_message,
        on_connection_change=handler.on_cloud_connection_change,
    ) as cloud:
        handler.attach(cloud=cloud, serial=serial)

        with contextlib.suppress(CloudUnavailableError, CloudRequestRejected):
            await cloud.post_device_event("agent_started", detail=__version__)

        tasks = [
            asyncio.create_task(serial.run(stop), name="serial"),
            asyncio.create_task(cloud.run_websocket(stop), name="cloud-ws"),
            asyncio.create_task(_heartbeat(serial, config.heartbeat_seconds, stop), name="heartbeat"),
            asyncio.create_task(_periodic_sync(handler, seats, config.seat_sync_seconds, stop), name="sync"),
        ]

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
