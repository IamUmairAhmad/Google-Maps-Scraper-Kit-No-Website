"""Search Google Maps in Google Chrome and keep active businesses with no website."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Callable
from urllib.parse import quote_plus

from app.leads import business_website, classify_status, keep_lead, review_count_from_panel, rows_to_csv, slug

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


def scrape_no_website_leads(
    niche: str,
    location: str,
    limit: int = 120,
    on_progress: Progress | None = None,
    headless: bool = False,
) -> dict:
    """Open Maps in Chrome, scroll one search, and return active no-website leads.

    One Maps search tops out near 120 listings. `limit` caps how many of those
    listings are opened. Email lookup stays off: these businesses have no site
    to read, and social profiles are skipped for the same reason.
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

    matches: list[dict] = []
    skipped_website = 0
    skipped_closed = 0
    failed = 0

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
                message=f"Checking {len(links)} listings for a website.",
                checked=0,
                found=0,
                total=len(links),
                limit=limit,
            )
            for index, link in enumerate(links, start=1):
                try:
                    row = _read_place(page, link["href"], niche, location, link.get("name", ""))
                except Exception:
                    failed += 1
                    row = None
                if row is not None:
                    if keep_lead(row):
                        matches.append(row)
                    elif row["status"] != "active":
                        skipped_closed += 1
                    else:
                        skipped_website += 1
                progress(
                    phase="checking",
                    message=f"Checked {index} of {len(links)}.",
                    checked=index,
                    found=len(matches),
                    total=len(links),
                    skipped_website=skipped_website,
                    skipped_closed=skipped_closed,
                    limit=limit,
                )
        finally:
            context.close()
            browser.close()

    summary = {
        "niche": niche,
        "location": location,
        "checked": len(links) if "links" in locals() else 0,
        "found": len(matches),
        "skipped_website": skipped_website,
        "skipped_closed": skipped_closed,
        "failed": failed,
        "leads": matches,
        "csv": rows_to_csv(matches),
    }
    progress(phase="done", message=f"Found {len(matches)} active businesses with no website.", **{
        key: summary[key] for key in ("checked", "found", "skipped_website", "skipped_closed", "failed")
    })
    return summary


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
    parser = argparse.ArgumentParser(description="Find active Maps businesses with no website.")
    parser.add_argument("--niche", required=True)
    parser.add_argument("--location", required=True)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--out", default="")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    summary = scrape_no_website_leads(
        args.niche,
        args.location,
        limit=args.limit,
        headless=not args.headed,
        on_progress=lambda event: print(event.get("message", ""), flush=True),
    )
    out = Path(args.out) if args.out else Path("results") / f"no-website-{slug(args.niche)}-{slug(args.location)}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(summary["csv"], encoding="utf-8")
    print(
        f"Checked {summary['checked']}. "
        f"Active with no website: {summary['found']}. "
        f"Has website: {summary['skipped_website']}. "
        f"Closed: {summary['skipped_closed']}. "
        f"Saved {out}"
    )


if __name__ == "__main__":
    main()
