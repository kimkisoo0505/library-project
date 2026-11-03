"""JSON 줄 형식 로깅.

- 콘솔(stdout -> systemd journal)과 회전 로그 파일(logs/agent.log)에 동시에 기록
- log_event()로 이벤트 이름과 필드를 구조화해서 남긴다
- 비밀 값으로 보이는 키는 자동으로 가린다
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

ROOT_LOGGER_NAME = "agent"
SENSITIVE_KEYS = frozenset({"token", "device_token", "password", "authorization", "secret"})


def redact(fields: dict[str, Any]) -> dict[str, Any]:
    return {key: ("***" if key.lower() in SENSITIVE_KEYS else value) for key, value in fields.items()}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        event = getattr(record, "event", None)
        if event:
            payload["event"] = event
        fields = getattr(record, "fields", None)
        if fields:
            payload["fields"] = redact(fields)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(log_dir: Path | None = None, level: str = "INFO") -> logging.Logger:
    root = logging.getLogger(ROOT_LOGGER_NAME)
    root.setLevel(level)
    root.propagate = False
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()

    formatter = JsonFormatter()
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    root.addHandler(console)

    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_dir / "agent.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"{ROOT_LOGGER_NAME}.{name}")


def log_event(
    logger: logging.Logger,
    event: str,
    message: str | None = None,
    *,
    level: int = logging.INFO,
    **fields: Any,
) -> None:
    """구조화된 이벤트 로그. 예: log_event(log, "serial.connected", port="/dev/ttyACM0")"""
    logger.log(level, message or event, extra={"event": event, "fields": fields})
