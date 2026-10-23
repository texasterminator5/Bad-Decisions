#!/usr/bin/env python3
"""Fetch SportsCardsPro search results for a query. Prints JSON to stdout."""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from html import unescape

UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
    "Mobile/15E148 Safari/604.1"
)


def parse_money(s: str | None):
    if s is None:
        return None
    t = re.sub(r"[$,\s]", "", str(s)).strip()
    if not t or t.upper() in {"N/A", "NA", "-"}:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def strip_tags(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()


def parse_search(html: str) -> list[dict]:
    rows = []
    for m in re.finditer(r'<tr id="product-(\d+)"[^>]*>(.*?)</tr>', html, re.S | re.I):
        pid, body = m.group(1), m.group(2)
        title_m = re.search(
            r'class="title"[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
            body,
            re.S | re.I,
        )
        if not title_m:
            continue
        href = title_m.group(1)
        title = unescape(strip_tags(title_m.group(2)))
        set_m = re.search(r'class="console[^"]*"[^>]*>(.*?)</td>', body, re.S | re.I)
        set_name = unescape(strip_tags(set_m.group(1))) if set_m else ""
        prices = [
            parse_money(x)
            for x in re.findall(r'class="[^"]*js-price[^"]*"[^>]*>([^<]*)', body, re.I)
        ]
        if not href.startswith("http"):
            href = "https://www.sportscardspro.com" + href
        rows.append(
            {
                "id": pid,
                "title": title,
                "setName": set_name,
                "url": href,
                "low": prices[0] if len(prices) > 0 else None,
                "mid": prices[1] if len(prices) > 1 else None,
                "high": prices[2] if len(prices) > 2 else None,
                "isBaseball": bool(
                    re.search(r"baseball", set_name, re.I)
                    or re.search(r"baseball-cards", href, re.I)
                ),
            }
        )
    return rows


def fetch(query: str) -> dict:
    q = urllib.parse.quote_plus(query)
    url = f"https://www.sportscardspro.com/search-products?q={q}&type=prices"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=35) as resp:
        html = resp.read().decode("utf-8", "ignore")
    return {"query": query, "url": url, "results": parse_search(html)}


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: fetch_prices.py <query>", "results": []}))
        raise SystemExit(2)
    query = " ".join(sys.argv[1:]).strip()
    try:
        print(json.dumps(fetch(query)))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc), "query": query, "results": []}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
