"""Search Google Maps in Google Chrome and read every listing: no website, has website, or closed."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Callable
from urllib.parse import quote_plus

from app.leads import (
    FILTER_KEYS,
    business_website,
    classify_status,
    count_results,
    filter_rows,
    review_count_from_panel,
    rows_to_csv,
    with_result,
    write_results,
)

Progress = Callable[[dict], None]

_EXTRACT_PLACE = """
() => {
  const main = document.querySelector('div[role="main"]');
  const text = (main?.innerText || '').slice(0, 1600);
  const name = main?.querySelector('h1')?.innerText?.trim() || '';
  const websiteEl = main?.querySelector(
    'a[data-item-id="authority"], a[aria-label^="Website:"], a[data-tooltip="Open website"], a[aria-label="Open website"]'
  );
  const website = (websiteEl?.getAttribute('href') || '').trim();
  const phoneEl = main?.querySelector('[data-item-id^="phone:tel:"]');
  const phone = (phoneEl?.getAttribute('aria-label') || phoneEl?.innerText || '')
    .replace(/^Phone:\\s*/i, '')
    .trim();
  const addrEl = main?.querySelector('[data-item-id="address"]');
  const address = (addrEl?.getAttribute('aria-label') || '')
    .replace(/^Address:\\s*/i, '')
    .trim();
  const category = main?.querySelector('button[jsaction*="category"]')?.innerText?.trim() || '';
  const rating = main?.querySelector('div.F7nice span[aria-hidden="true"]')?.innerText?.trim() || '';
  const reviewEl = main?.querySelector('[aria-label*="review"]');
  const reviewLabel = reviewEl?.getAttribute('aria-label') || '';
  const reviewMatch = reviewLabel.match(/([\\d,]+)\\s+review/i);
  const reviewCount = reviewMatch ? reviewMatch[1].replace(/,/g, '') : '';
  return { name, website, phone, address, category, rating, reviewCount, panelText: text };
}
"""

_COLLECT_LINKS = """
() => {
  const feed = document.querySelector('div[role="feed"]');
  if (!feed) return [];
  const seen = new Set();
  const links = [];
  for (const anchor of feed.querySelectorAll('a[href*="/maps/place/"]')) {
    const href = anchor.href || '';
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, name: anchor.getAttribute('aria-label') || '' });
  }
  return links;
}
"""


def search_url(niche: str, location: str) -> str:
    query = f"{niche.strip()} in {location.strip()}"
    return "https://www.google.com/maps/search/" + quote_plus(query)


def scrape_places(
    niche: str,
    location: str,
    limit: int = 120,
    on_progress: Progress | None = None,
    headless: bool = False,
) -> dict:
    """Open Maps in Chrome, scroll one search, and read every listing it opens.

    Each row is labelled No website, Has website, or Closed. Nothing is dropped:
    the page filters the rows and downloads whichever group you pick.
    One Maps search tops out near 120 listings. `limit` caps how many of those
    listings are opened. Email lookup stays off: no site is opened, and social
    profiles do not count as a website.
    """
    niche = niche.strip()
    location = location.strip()
    if not niche or not location:
        raise ValueError("Niche and location are both required.")
    limit = max(1, min(int(limit), 120))

    def progress(**fields):
        if on_progress:
            on_progress(fields)

    progress(phase="starting", message="Opening Google Maps in Chrome.", checked=0, found=0, limit=limit)

    from playwright.sync_api import sync_playwright

    rows: list[dict] = []
    failed = 0
    links: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            channel="chrome",
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--lang=en-US",
            ],
        )
        context = browser.new_context(locale="en-US", viewport={"width": 1440, "height": 960})
        page = context.new_page()
        try:
            page.goto(search_url(niche, location), wait_until="domcontentloaded", timeout=45000)
            _dismiss_consent(page)
            _raise_if_blocked(page)
            page.wait_for_selector('div[role="feed"]', timeout=30000)
            links = _scroll_feed(page, limit, progress)
            progress(
                phase="checking",
                message=f"Checking {len(links)} listings.",
                checked=0,
                found=0,
                total=len(links),
                limit=limit,
            )
            for index, link in enumerate(links, start=1):
                try:
                    rows.append(with_result(_read_place(page, link["href"], niche, location, link.get("name", ""))))
                except Exception:
                    failed += 1
                progress(
                    phase="checking",
                    message=f"Checked {index} of {len(links)}.",
                    total=len(links),
                    failed=failed,
                    rows=list(rows),
                    limit=limit,
                    **count_results(rows),
                )
        finally:
            context.close()
            browser.close()

    counts = count_results(rows)
    summary = {
        "niche": niche,
        "location": location,
        "failed": failed,
        "rows": rows,
        **counts,
    }
    progress(
        phase="done",
        message=summary_message(counts, failed),
        failed=failed,
        rows=list(rows),
        **counts,
    )
    return summary


def summary_message(counts: dict, failed: int = 0) -> str:
    text = (
        f"Checked {counts['checked']}: {counts['found']} no website, "
        f"{counts['skipped_website']} has website, {counts['skipped_closed']} closed."
    )
    if failed:
        text += f" {failed} could not be read."
    return text


def _dismiss_consent(page) -> None:
    for name in ("Accept all", "Reject all", "I agree"):
        button = page.get_by_role("button", name=name)
        try:
            if button.count():
                button.first.click(timeout=2000)
                page.wait_for_timeout(600)
                return
        except Exception:
            continue


def _raise_if_blocked(page) -> None:
    body = ""
    try:
        body = page.locator("body").inner_text(timeout=3000).lower()
    except Exception:
        return
    if "unusual traffic" in body or "detected unusual traffic" in body or "recaptcha" in body:
        raise RuntimeError(
            "Google Maps asked for a captcha. Wait a while, then run one smaller search."
        )


def _scroll_feed(page, limit: int, progress: Progress) -> list[dict]:
    collected: list[dict] = []
    seen: set[str] = set()
    stagnant = 0
    progress(phase="scrolling", message="Scrolling the Maps results.", checked=0, found=0, limit=limit)
    while len(collected) < limit and stagnant < 4:
        batch = page.evaluate(_COLLECT_LINKS)
        before = len(collected)
        for item in batch:
            href = item.get("href") or ""
            if not href or href in seen:
                continue
            seen.add(href)
            collected.append({"href": href, "name": item.get("name") or ""})
            if len(collected) >= limit:
                break
        end_of_list = page.get_by_text("You've reached the end of the list").count() > 0
        end_of_results = page.get_by_text("You've reached the end of the results").count() > 0
        if end_of_list or end_of_results or len(collected) >= limit:
            break
        page.eval_on_selector('div[role="feed"]', "el => el.scrollBy(0, Math.max(el.clientHeight, 800))")
        page.wait_for_timeout(1200)
        stagnant = stagnant + 1 if len(collected) == before else 0
        progress(
            phase="scrolling",
            message=f"Found {len(collected)} listings so far.",
            checked=0,
            found=0,
            total=len(collected),
            limit=limit,
        )
    return collected[:limit]


def _read_place(page, href: str, niche: str, location: str, fallback_name: str) -> dict:
    page.goto(href, wait_until="domcontentloaded", timeout=30000)
    _dismiss_consent(page)
    _raise_if_blocked(page)
    page.wait_for_selector('div[role="main"] h1', timeout=15000)
    page.wait_for_timeout(800)
    extracted = page.evaluate(_EXTRACT_PLACE)
    status = classify_status(extracted.get("panelText") or "")
    name = (extracted.get("name") or fallback_name or "").strip()
    return {
        "name": name,
        "phone": (extracted.get("phone") or "").strip(),
        "email": "",
        "website": business_website(extracted.get("website")),
        "category": (extracted.get("category") or "").strip(),
        "address": (extracted.get("address") or "").strip(),
        "rating": (extracted.get("rating") or "").strip(),
        "review_count": review_count_from_panel(extracted.get("panelText") or ""),
        "status": status,
        "maps_url": page.url,
        "niche": niche,
        "location": location,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read Google Maps listings: no website, has website, closed.")
    parser.add_argument("--niche", required=True)
    parser.add_argument("--location", required=True)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--only", choices=FILTER_KEYS, default="", help="Save just this group to --out.")
    parser.add_argument("--out", default="", help="CSV path used with --only.")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    summary = scrape_places(
        args.niche,
        args.location,
        limit=args.limit,
        headless=not args.headed,
        on_progress=lambda event: print(event.get("message", ""), flush=True),
    )
    if args.only and args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(rows_to_csv(filter_rows(summary["rows"], args.only)), encoding="utf-8")
        saved = [out]
    else:
        saved = write_results(summary["rows"], args.niche, args.location)
    print(summary_message(summary, summary["failed"]))
    for path in saved:
        print(f"Saved {path}")


if __name__ == "__main__":
    main()
