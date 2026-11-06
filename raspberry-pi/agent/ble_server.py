"""BLE GATT 서버 (Peripheral) — 모바일 앱과의 통신 시험용.

실행: .venv/bin/python -m agent.ble_server   (systemd: library-ble.service)

좌석 에이전트(agent.main)와는 별도 프로세스다. 이 서버는
- Arduino·서보모터·좌석 상태·클라우드에 접근하지 않는다.
- 비밀 값을 쓰지 않으며, 명령 내용 중 ECHO 텍스트는 로그에 남기지 않는다(길이만).
- 로그는 stdout(journald)에만 쓴다. agent.log 회전 파일은 에이전트 전용이다.

환경 변수 (모두 선택)
  BLE_DEVICE_NAME  광고 이름, 기본 LIB-SEAT-PI (최대 11자)
  BLE_ADAPTER      어댑터 이름 (예: hci0). 비우면 첫 번째 어댑터
  LOG_LEVEL        기본 INFO
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time
from typing import Any

from .ble_protocol import (
    COMMAND_CHAR_UUID,
    DEFAULT_DEVICE_NAME,
    RESPONSE_CHAR_UUID,
    SERVICE_UUID,
    STATUS_CHAR_UUID,
    RateLimiter,
    busy_response,
    handle_command,
    status_value,
)
from .logger import get_logger, log_event, setup_logging

EXIT_CONFIG_ERROR = 2
MAX_NAME_LENGTH = 11


def load_settings(env: dict[str, str]) -> dict[str, Any]:
    name = env.get("BLE_DEVICE_NAME", "").strip() or DEFAULT_DEVICE_NAME
    if len(name) > MAX_NAME_LENGTH or not name.isascii():
        raise ValueError(f"BLE_DEVICE_NAME 은 ASCII {MAX_NAME_LENGTH}자 이하여야 합니다")
    adapter = env.get("BLE_ADAPTER", "").strip() or None
    return {"name": name, "adapter": adapter, "log_level": env.get("LOG_LEVEL", "INFO").upper()}


class BleGattServer:
    def __init__(self, name: str, adapter: str | None) -> None:
        self.name = name
        self.adapter = adapter
        self.log = get_logger("ble")
        self.started_at = time.monotonic()
        self.limiter = RateLimiter(max_events=10, window=1.0)
        self.server: Any = None

    # --- bless 콜백 (BlueZ D-Bus 스레드가 아니라 같은 asyncio 루프에서 호출됨) ---

    def _on_read(self, characteristic: Any, **_: Any) -> bytearray:
        uuid = str(characteristic.uuid).lower()
        if uuid == STATUS_CHAR_UUID:
            return bytearray(status_value(time.monotonic() - self.started_at))
        return bytearray(characteristic.value or b"")

    def _on_write(self, characteristic: Any, value: Any, **_: Any) -> None:
        uuid = str(characteristic.uuid).lower() if characteristic is not None else ""
        if uuid != COMMAND_CHAR_UUID:
            log_event(self.log, "ble.write_rejected", "Command 외 특성 쓰기 거부", level=logging.WARNING)
            return
        raw = bytes(value)

        if not self.limiter.allow():
            self._notify(busy_response(raw))
            log_event(self.log, "ble.busy", "명령 속도 제한 초과", level=logging.WARNING)
            return

        result = handle_command(raw)
        self._notify(result.response)
        if result.ok:
            level = logging.DEBUG if result.command == "PING" else logging.INFO
            log_event(self.log, "ble.command", level=level, command=result.command, bytes=len(raw))
        else:
            log_event(self.log, "ble.command_rejected", level=logging.WARNING,
                      command=result.command, error=result.error, bytes=len(raw))

    def _notify(self, payload: bytes) -> None:
        char = self.server.get_characteristic(RESPONSE_CHAR_UUID)
        char.value = bytearray(payload)
        self.server.update_value(SERVICE_UUID, RESPONSE_CHAR_UUID)

    def _on_subscribe_change(self, subscribed: bool) -> None:
        log_event(self.log, "ble.subscribed" if subscribed else "ble.unsubscribed",
                  "앱이 응답 알림을 구독" if subscribed else "앱이 응답 알림 구독 해제")

    # --- 수명 주기 ---

    async def start(self) -> None:
        # bless 는 BlueZ/D-Bus 가 있는 Linux 에서만 import 가능하므로 지연 import.
        from bless import (  # type: ignore[import-not-found]
            BlessServer,
            GATTAttributePermissions,
            GATTCharacteristicProperties,
        )

        kwargs: dict[str, Any] = {"name": self.name, "loop": asyncio.get_running_loop()}
        if self.adapter:
            kwargs["adapter"] = self.adapter
        self.server = BlessServer(**kwargs)
        self.server.read_request_func = self._on_read
        self.server.write_request_func = self._on_write

        props = GATTCharacteristicProperties
        perms = GATTAttributePermissions
        await self.server.add_new_service(SERVICE_UUID)
        await self.server.add_new_characteristic(
            SERVICE_UUID, COMMAND_CHAR_UUID, props.write | props.write_without_response, None, perms.writeable)
        await self.server.add_new_characteristic(
            SERVICE_UUID, RESPONSE_CHAR_UUID, props.notify, bytearray(b""), perms.readable)
        await self.server.add_new_characteristic(
            SERVICE_UUID, STATUS_CHAR_UUID, props.read, bytearray(status_value(0)), perms.readable)

        await self.server.start()

        # 구독 시작/해제를 로그로 남긴다 (bless 기본값은 아무것도 하지 않는 람다).
        app = getattr(self.server, "app", None)
        if app is not None:
            app.StartNotify = lambda _char: self._on_subscribe_change(True)
            app.StopNotify = lambda _char: self._on_subscribe_change(False)

        log_event(self.log, "ble.started", "BLE GATT 서버 시작 - 광고 중",
                  name=self.name, adapter=self.adapter or "default", service=SERVICE_UUID)

    async def stop(self) -> None:
        if self.server is not None:
            try:
                await self.server.stop()
            except Exception as exc:  # 종료 중 오류는 기록만
                log_event(self.log, "ble.stop_error", level=logging.WARNING, error=repr(exc))
        log_event(self.log, "ble.stopped", "BLE GATT 서버 종료")


async def run(settings: dict[str, Any]) -> int:
    log = get_logger("ble")
    server = BleGattServer(settings["name"], settings["adapter"])
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows 개발 PC
            pass
    try:
        await server.start()
    except Exception as exc:
        log_event(log, "ble.start_failed", "BLE 서버 시작 실패 (블루투스 어댑터/권한 확인)",
                  level=logging.ERROR, error=repr(exc))
        await server.stop()
        return 1
    await stop.wait()
    await server.stop()
    return 0


def main() -> int:
    try:
        settings = load_settings(dict(os.environ))
    except ValueError as exc:
        print(f"설정 오류: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR
    setup_logging(None, settings["log_level"])
    return asyncio.run(run(settings))


if __name__ == "__main__":
    sys.exit(main())
