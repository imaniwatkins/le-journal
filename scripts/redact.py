#!/usr/bin/env python3
"""Remove brokerage account identifiers from journal JSON.

The repo is public. Account ids are not a trading secret the app needs, and
they are stripped by key name and by shape. This file does not contain any
real account id. A Webull-style account id is a 26-character uppercase token.
Shorter account numbers are removed when they are the value of an account field.
"""

from __future__ import annotations

import re
from typing import Any

ACCOUNT_KEY = re.compile(
    r"(account[_\s-]?id|account[_\s-]?number|acct[_\s-]?id|brokerage[_\s-]?account)",
    re.IGNORECASE,
)
# 26-character uppercase/digit tokens match the long paper-account id shape.
LONG_ACCOUNT = re.compile(r"\b[A-Z0-9]{26}\b")


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if ACCOUNT_KEY.search(str(key)):
                continue
            out[key] = redact(item)
        return out
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return LONG_ACCOUNT.sub("[redacted]", value)
    return value


def contains_long_account_token(value: Any) -> bool:
    if isinstance(value, dict):
        return any(ACCOUNT_KEY.search(str(k)) or contains_long_account_token(v) for k, v in value.items())
    if isinstance(value, list):
        return any(contains_long_account_token(item) for item in value)
    if isinstance(value, str):
        return LONG_ACCOUNT.search(value) is not None
    return False
