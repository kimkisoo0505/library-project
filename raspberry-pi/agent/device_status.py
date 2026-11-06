"""장치 상태 보고 (키오스크 임시 상태 표시줄용).

30초마다 서버(POST /api/device/status)로 보낸다.
  - 네트워크: 현재 Wi-Fi 이름(SSID)·신호 세기, 또는 유선 연결 여부 (NetworkManager nmcli)
  - 에이전트: 담당 열람실, LCD 연결, Arduino 시리얼 연결, 중앙/금화도서관 중계 결과
  - BLE: library-ble 서비스 실행 여부, 연결된 모바일 기기 수·주소 끝 4자리 (이름 제외)
IP 주소, 비밀번호 등은 보내지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, Protocol

from . import __version__
from .logger import get_logger, log_event

NMCLI_TIMEOUT = 5.0


class StatusCloud(Protocol):
    async def post_device_status(self, payload: dict[str, Any]) -> dict[str, Any]: ...


def split_terse(line: str) -> list[str]:
    """nmcli -t 출력 한 줄을 ':' 로 나눈다 (값 안의 ':' 는 '\\:' 로 이스케이프되어 있음)."""
    fields, buf, escaped = [], [], False
    for ch in line:
        if escaped:
            buf.append(ch)
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == ":":
            fields.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    fields.append("".join(buf))
    return fields


def parse_network(devices_out: str, wifi_out: str) -> dict[str, Any]:
    """nmcli 출력 -> {"type": "wifi"|"ethernet"|"none", "ssid": ..., "signal": ..., "band": ...}"""
    connected = {}
    for line in devices_out.splitlines():
        parts = split_terse(line)
        if len(parts) >= 3 and parts[2] == "connected":
            connected[parts[1]] = parts[0]
    if "wifi" in connected:
        for line in wifi_out.splitlines():
            parts = split_terse(line)
            if len(parts) >= 4 and parts[0] == "yes":
                signal = int(parts[2]) if parts[2].isdigit() else None
                freq = parts[3].split()[0] if parts[3] else ""
                band = "5GHz" if freq.startswith("5") else "2.4GHz" if freq.startswith("2") else None
                return {"type": "wifi", "ssid": parts[1][:64], "signal": signal, "band": band}
        return {"type": "wifi", "ssid": None, "signal": None, "band": None}
    if "ethernet" in connected:
        return {"type": "ethernet", "ssid": None, "signal": None, "band": None}
    return {"type": "none", "ssid": None, "signal": None, "band": None}


def _run(args: list[str]) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=NMCLI_TIMEOUT, check=False)
    return result.stdout if result.returncode == 0 else ""


def read_network() -> dict[str, Any]:
    try:
        devices = _run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device"])
        wifi = _run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL,FREQ", "device", "wifi", "list", "--rescan", "no"])
    except (OSError, subprocess.SubprocessError):
        return {"type": "unknown", "ssid": None, "signal": None, "band": None}
    return parse_network(devices, wifi)


MAX_BLE_CLIENTS = 5
_MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")


def parse_ble_connected(out: str) -> list[str]:
    """`bluetoothctl devices Connected` 출력 -> 연결된 기기 주소 목록.

    기기 이름(사람 이름이 들어갈 수 있음)은 버린다.
    """
    addresses = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "Device" and _MAC_RE.match(parts[1].upper()):
            addresses.append(parts[1].upper())
    return addresses


def mask_address(address: str) -> str:
    """AA:BB:CC:DD:EE:FF -> 'EE:FF' (끝 2바이트만 공개)."""
    return address[-5:]


class BleStatusReader:
    """모바일 앱과의 BLE 연결 상태 (임시 상태 표시줄용).

    - server: library-ble 서비스 실행 여부 (systemctl is-active)
    - connected: 연결된 기기 주소 끝 4자리와 처음 확인한 시각 (최대 5대)
    이름·전체 주소는 보내지 않는다. 읽기 실패 시 None (= 정보 없음).
    """

    def __init__(
        self,
        run: Callable[[list[str]], str | None] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._run = run or _run_optional
        self._clock = clock
        self._since: dict[str, datetime] = {}

    def read(self) -> dict[str, Any] | None:
        active = self._run(["systemctl", "is-active", "library-ble"])
        connected_out = self._run(["bluetoothctl", "devices", "Connected"])
        if active is None and connected_out is None:
            return None
        now = self._clock()
        current = parse_ble_connected(connected_out or "")
        self._since = {a: self._since.get(a, now) for a in current}
        clients = [
            {"id": mask_address(a), "since": self._since[a].isoformat(timespec="seconds").replace("+00:00", "Z")}
            for a in current[:MAX_BLE_CLIENTS]
        ]
        return {
            "server": None if active is None else active.strip() == "active",
            "connected": clients if connected_out is not None else None,
        }


def _run_optional(args: list[str]) -> str | None:
    """명령 실행 결과(stdout). 명령이 없거나 시간 초과면 None. systemctl 의 inactive 는 정상 출력."""
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=NMCLI_TIMEOUT, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if args[0] == "systemctl":
        return result.stdout or None
    return result.stdout if result.returncode == 0 else None


class DeviceStatusReporter:
    def __init__(
        self,
        cloud: StatusCloud,
        *,
        room: str,
        interval_seconds: float = 30.0,
        is_online: Callable[[], bool] = lambda: True,
        components: Callable[[], dict[str, Any]] = dict,
        network_reader: Callable[[], dict[str, Any]] = read_network,
        ble_reader: Callable[[], dict[str, Any] | None] | None = None,
    ) -> None:
        self._cloud = cloud
        self._room = room
        self._interval = interval_seconds
        self._is_online = is_online
        self._components = components
        self._read_network = network_reader
        self._read_ble = ble_reader or BleStatusReader().read
        self._log = get_logger("device_status")

    async def build(self) -> dict[str, Any]:
        network = await asyncio.to_thread(self._read_network)
        ble = await asyncio.to_thread(self._read_ble)
        return {
            "room": self._room,
            "agent_version": __version__,
            "network": network,
            "ble": ble,
            **self._components(),
        }

    async def report_once(self) -> bool | None:
        """True = 전송, False = 실패, None = 클라우드 미연결로 건너뜀"""
        if not self._is_online():
            return None
        payload = await self.build()
        try:
            await self._cloud.post_device_status(payload)
            return True
        except Exception as exc:  # noqa: BLE001
            log_event(self._log, "device_status.upload_failed", "상태 보고 실패", level=logging.WARNING, error=repr(exc))
            return False

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            result = await self.report_once()
            wait = 5.0 if result is None else self._interval
            try:
                await asyncio.wait_for(stop.wait(), timeout=wait)
            except TimeoutError:
                pass
