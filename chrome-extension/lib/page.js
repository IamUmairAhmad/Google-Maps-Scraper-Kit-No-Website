// Functions that run INSIDE the Google Maps tab (chrome.scripting.executeScript).
// Each one is serialized on its own, so it must not use anything outside itself.
// The selectors are the same ones the Python tool uses.

// Wait until a selector exists. Resolves true/false instead of throwing.
export async function waitForSelector(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.querySelector(selector)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !!document.querySelector(selector);
}

// Click a cookie-consent button if Maps shows one inline.
export function dismissConsent() {
  for (const name of ["Accept all", "Reject all", "I agree"]) {
    const button = [...document.querySelectorAll("button")].find((el) => (el.innerText || "").trim() === name);
    if (button) {
      button.click();
      return true;
    }
  }
  return false;
}

// True when Google is showing a "unusual traffic" or captcha wall.
export function looksBlocked() {
  const body = (document.body?.innerText || "").toLowerCase();
  return body.includes("unusual traffic") || body.includes("recaptcha");
}

// Every place link currently loaded in the results list.
export function collectLinks() {
  const feed = document.querySelector('div[role="feed"]');
  if (!feed) return { links: [], atEnd: false };
  const seen = new Set();
  const links = [];
  for (const anchor of feed.querySelectorAll('a[href*="/maps/place/"]')) {
    const href = anchor.href || "";
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, name: anchor.getAttribute("aria-label") || "" });
  }
  const text = feed.innerText || "";
  const atEnd = /You've reached the end of the (list|results)/.test(text) ||
    /You've reached the end of the (list|results)/.test(document.body?.innerText || "");
  return { links, atEnd };
}

export function scrollFeed() {
  const feed = document.querySelector('div[role="feed"]');
  if (feed) feed.scrollBy(0, Math.max(feed.clientHeight, 800));
}

// Read one place page.
export function extractPlace() {
  const main = document.querySelector('div[role="main"]');
  const panelText = (main?.innerText || "").slice(0, 1600);
  const name = main?.querySelector("h1")?.innerText?.trim() || "";
  const websiteEl = main?.querySelector(
    'a[data-item-id="authority"], a[aria-label^="Website:"], a[data-tooltip="Open website"], a[aria-label="Open website"]'
  );
  const website = (websiteEl?.getAttribute("href") || "").trim();
  const phoneEl = main?.querySelector('[data-item-id^="phone:tel:"]');
  const phone = (phoneEl?.getAttribute("aria-label") || phoneEl?.innerText || "").replace(/^Phone:\s*/i, "").trim();
  const addrEl = main?.querySelector('[data-item-id="address"]');
  const address = (addrEl?.getAttribute("aria-label") || "").replace(/^Address:\s*/i, "").trim();
  const category = main?.querySelector('button[jsaction*="category"]')?.innerText?.trim() || "";
  const rating = main?.querySelector('div.F7nice span[aria-hidden="true"]')?.innerText?.trim() || "";
  let url = location.href;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("hl"); // added only to force English labels
    url = parsed.toString();
  } catch {
    // keep the raw URL
  }
  return { name, website, phone, address, category, rating, panelText, url, onPlacePage: location.pathname.includes("/maps/place/") };
}
