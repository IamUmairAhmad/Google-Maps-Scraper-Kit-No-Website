"""Filter Maps listings down to active businesses with no website, and write CSV."""

from __future__ import annotations

import csv
import io
import re
from typing import Iterable, Mapping
from urllib.parse import parse_qs, urlparse

LEAD_COLUMNS = (
    "name",
    "phone",
    "email",
    "website",
    "category",
    "address",
    "rating",
    "review_count",
    "status",
    "maps_url",
    "niche",
    "location",
)

_EMPTY_WEBSITE = {"", "n/a", "na", "-", "none", "null", "undefined"}
_FORMULA_PREFIX = ("=", "+", "-", "@")
_PROFILE_HOSTS = (
    "facebook.com",
    "fb.com",
    "fb.me",
    "instagram.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "linkedin.com",
    "youtube.com",
    "youtu.be",
    "pinterest.com",
    "linktr.ee",
    "linktree.com",
)


def classify_status(panel_text: str) -> str:
    """Map the place header to active, temporarily closed, or permanently closed.

    "Closed · Opens 9 AM" is still an operating business. Only the closed-down
    labels drop a listing.
    """
    text = (panel_text or "").lower()
    if "permanently closed" in text:
        return "permanently closed"
    if "temporarily closed" in text:
        return "temporarily closed"
    return "active"


def _hostname(url: str) -> str:
    candidate = url if "://" in url else f"https://{url}"
    host = (urlparse(candidate).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def unwrap_google_redirect(url: str) -> str:
    text = (url or "").strip()
    parsed = urlparse(text)
    host = _hostname(text)
    if host in {"google.com", "maps.google.com"} and parsed.path.startswith("/url"):
        target = parse_qs(parsed.query).get("q", [""])[0].strip()
        return target or text
    return text


def _is_profile_host(host: str) -> bool:
    return any(host == name or host.endswith("." + name) for name in _PROFILE_HOSTS)


def has_website(value: str | None) -> bool:
    """True when Maps lists a real site. Social profiles do not count."""
    text = unwrap_google_redirect(value).strip()
    if text.lower() in _EMPTY_WEBSITE:
        return False
    return not _is_profile_host(_hostname(text))


def business_website(value: str | None) -> str:
    text = unwrap_google_redirect(value).strip()
    if not has_website(text):
        return ""
    return text


def review_count_from_panel(panel_text: str) -> str:
    header = (panel_text or "")[:900]
    # "(530)" is the review count. "(207) 801-9191" is a phone, so skip it.
    match = re.search(r"\((\d[\d,]*)\)(?!\s*\d)", header) or re.search(
        r"(\d[\d,]*)\s+reviews\b", header, re.IGNORECASE
    )
    if not match:
        return ""
    return match.group(1).replace(",", "")


def is_active(status: str | None) -> bool:
    return (status or "").strip().lower() == "active"


def keep_lead(row: Mapping[str, str]) -> bool:
    """True when the business is operating and Maps has no website for it."""
    return is_active(row.get("status")) and not has_website(row.get("website"))


def csv_cell(value: object) -> str:
    text = "" if value is None else str(value)
    if text.startswith(_FORMULA_PREFIX):
        return "'" + text
    return text


def rows_to_csv(rows: Iterable[Mapping[str, object]]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=LEAD_COLUMNS, lineterminator="\n", extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({column: csv_cell(row.get(column, "")) for column in LEAD_COLUMNS})
    return buffer.getvalue()


def slug(value: str, fallback: str = "search") -> str:
    text = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return text or fallback
