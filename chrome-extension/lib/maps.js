// Drives one Google Maps search in a small Chrome window and reads every listing.
// Runs in the extension page. Port of app/scrape.py.

import {
  businessWebsite,
  classifyStatus,
  countResults,
  reviewCountFromPanel,
  withResult,
} from "./leads.js";
import {
  collectLinks,
  dismissConsent,
  extractPlace,
  looksBlocked,
  scrollFeed,
  waitForSelector,
} from "./page.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class BlockedError extends Error {}

export function searchUrl(niche, location) {
  const query = `${niche.trim()} in ${location.trim()}`;
  // hl=en keeps Maps labels in English so "Permanently closed" and friends can be read.
  return "https://www.google.com/maps/search/" + encodeURIComponent(query).replace(/%20/g, "+") + "?hl=en";
}

export function withEnglish(href) {
  try {
    const url = new URL(href);
    url.searchParams.set("hl", "en");
    return url.toString();
  } catch {
    return href;
  }
}

async function inTab(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result;
}

// Resolves when the tab finishes loading, or after the timeout. Never rejects.
function loadComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigate(tabId, url) {
  // Start listening before the tab moves, so the old page's "complete" is never mistaken for the new one.
  const loaded = loadComplete(tabId, 30000);
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

// Wait for a selector inside the Maps tab. Pages Claude cannot script (a consent or
// "unusual traffic" page) fail to inject, so keep trying until the deadline: the person
// can finish those steps in the Maps window.
async function waitForMaps(tabId, selector, timeoutMs, onWaiting) {
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  while (Date.now() < deadline) {
    try {
      if (await inTab(tabId, waitForSelector, [selector, 2000])) return true;
    } catch {
      if (!notified && onWaiting) {
        onWaiting();
        notified = true;
      }
      await sleep(1000);
    }
  }
  return false;
}

async function scrollForLinks(tabId, limit, progress, shouldStop) {
  const collected = [];
  const seen = new Set();
  let stagnant = 0;
  progress({ phase: "scrolling", message: "Scrolling the Maps results." });
  while (collected.length < limit && stagnant < 4 && !shouldStop()) {
    const { links, atEnd } = (await inTab(tabId, collectLinks)) || { links: [], atEnd: false };
    const before = collected.length;
    for (const item of links) {
      if (!item.href || seen.has(item.href)) continue;
      seen.add(item.href);
      collected.push(item);
      if (collected.length >= limit) break;
    }
    if (atEnd || collected.length >= limit) break;
    await inTab(tabId, scrollFeed);
    await sleep(1200);
    stagnant = collected.length === before ? stagnant + 1 : 0;
    progress({ phase: "scrolling", message: `Found ${collected.length} listings so far.`, total: collected.length });
  }
  return collected.slice(0, limit);
}

async function readPlace(tabId, link, niche, location) {
  await navigate(tabId, withEnglish(link.href));
  if (!(await waitForMaps(tabId, 'div[role="main"] h1', 20000))) {
    throw new Error("The listing did not load.");
  }
  if (await inTab(tabId, looksBlocked)) {
    throw new BlockedError("Google Maps asked for a check (unusual traffic). Wait a while, then run a smaller search.");
  }
  await sleep(800);
  const extracted = await inTab(tabId, extractPlace);
  if (!extracted?.onPlacePage) throw new Error("Not a place page.");
  return withResult({
    name: (extracted.name || link.name || "").trim(),
    phone: (extracted.phone || "").trim(),
    email: "",
    website: businessWebsite(extracted.website),
    category: (extracted.category || "").trim(),
    address: (extracted.address || "").trim(),
    rating: (extracted.rating || "").trim(),
    review_count: reviewCountFromPanel(extracted.panelText || ""),
    status: classifyStatus(extracted.panelText || ""),
    maps_url: extracted.url || link.href,
    niche,
    location,
  });
}

// onProgress receives { phase, message, rows, failed, total, ...counts }.
// shouldStop() lets the Stop button end the run early; rows read so far are kept.
export async function runSearch({ niche, location, limit, onProgress, shouldStop = () => false }) {
  niche = niche.trim();
  location = location.trim();
  if (!niche || !location) throw new Error("Niche and location are both required.");
  limit = Math.max(1, Math.min(Number(limit) || 25, 120));

  const rows = [];
  let failed = 0;
  let error = "";
  let total = 0;
  const progress = (fields) => onProgress?.({ rows: [...rows], failed, total, ...countResults(rows), ...fields });

  progress({ phase: "starting", message: "Opening Google Maps in a small Chrome window." });
  const win = await chrome.windows.create({
    url: searchUrl(niche, location),
    type: "popup",
    width: 1100,
    height: 850,
    focused: false,
  });
  const tabId = win.tabs[0].id;

  try {
    await loadComplete(tabId, 30000);
    const waitingNote = () =>
      progress({
        phase: "waiting",
        message: "Waiting for Google Maps. If the Maps window shows a consent or check page, finish it there.",
      });
    try {
      await inTab(tabId, dismissConsent);
    } catch {
      // not scriptable yet; waitForMaps handles it
    }
    if (!(await waitForMaps(tabId, 'div[role="feed"]', 150000, waitingNote))) {
      throw new Error("Google Maps did not show a results list. Check the Maps window, then try again.");
    }
    if (await inTab(tabId, looksBlocked)) {
      throw new BlockedError("Google Maps asked for a check (unusual traffic). Wait a while, then run a smaller search.");
    }

    const links = await scrollForLinks(tabId, limit, progress, shouldStop);
    total = links.length;
    progress({ phase: "checking", message: `Checking ${links.length} listings.` });

    let streak = 0;
    for (let index = 0; index < links.length; index += 1) {
      if (shouldStop()) break;
      try {
        rows.push(await readPlace(tabId, links[index], niche, location));
        streak = 0;
      } catch (caught) {
        if (caught instanceof BlockedError) throw caught;
        failed += 1;
        streak += 1;
        if (streak >= 5) {
          throw new Error("Maps stopped loading listings. Check the Maps window for a consent or check page.");
        }
      }
      progress({ phase: "checking", message: `Checked ${index + 1} of ${links.length}.` });
    }
  } catch (caught) {
    error = caught?.message || String(caught);
  } finally {
    try {
      await chrome.windows.remove(win.id);
    } catch {
      // already closed
    }
  }

  const stopped = shouldStop();
  const counts = countResults(rows);
  const summary = `Checked ${counts.checked}: ${counts.found} no website, ${counts.skipped_website} has website, ${counts.skipped_closed} closed.` +
    (failed ? ` ${failed} could not be read.` : "") +
    (stopped && !error ? " Stopped early." : "");
  const result = { rows, failed, stopped, error, ...counts, message: error ? `${error} ${rows.length ? summary : ""}`.trim() : summary };
  onProgress?.({ phase: error ? "error" : "done", total, ...result });
  return result;
}
