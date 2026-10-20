// End-to-end check: load the unpacked extension into real Chromium and run a search
// against a MOCK of Google Maps (the sandbox cannot reach the real one).
// Run: node tests/e2e.mjs   (needs the `playwright` package and a Chromium build)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const extensionPath = process.env.EXTENSION_PATH || resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLACES = {
  "Ada Plumbing": { rating: "4.8", reviews: "12", phone: "555-0100", addr: "1 Main St", cat: "Plumber", note: "Open · Closes 5 PM" },
  "Bob Pipes": { rating: "4.1", reviews: "1,204", phone: "555-0101", addr: "2 Oak Ave", cat: "Plumber", note: "Open · Closes 6 PM", site: "https://bob.example" },
  "Old Co": { rating: "3.0", reviews: "3", phone: "", addr: "3 Elm Rd", cat: "Plumber", note: "Permanently closed" },
  "Pause Co": { rating: "4.0", reviews: "8", phone: "555-0104", addr: "4 Pine St", cat: "Plumber", note: "Temporarily closed", site: "https://pause.example" },
  "Social Only": { rating: "4.5", reviews: "40", phone: "555-0105", addr: "5 Fir Ln", cat: "Plumber", note: "Open · Closes 4 PM", site: "https://www.facebook.com/socialonly" },
  "Late Co": { rating: "4.9", reviews: "77", phone: "555-0106", addr: "6 Ash Ct", cat: "Plumber", note: "Closed · Opens 9 AM" },
};
const seen = [];

function searchPage() {
  const anchors = Object.keys(PLACES)
    .map((n) => `<a href="/maps/place/${encodeURIComponent(n)}/data=!4m2" aria-label="${n}">${n}</a><div style="height:90px">${n} card</div>`)
    .join("");
  return `<!doctype html><title>Maps</title><div role="feed" style="height:300px;overflow:auto">${anchors}<p>You've reached the end of the list.</p></div>`;
}

function placePage(name) {
  const p = PLACES[name];
  if (!p) return "<!doctype html><title>x</title><body>unknown";
  const site = p.site ? `<a data-item-id="authority" href="${p.site}">site</a>` : "";
  const phone = p.phone ? `<button data-item-id="phone:tel:${p.phone}" aria-label="Phone: ${p.phone}">${p.phone}</button>` : "";
  return `<!doctype html><title>${name}</title><div role="main"><h1>${name}</h1>
    <div class="F7nice"><span aria-hidden="true">${p.rating}</span></div><span>(${p.reviews})</span>
    <button jsaction="pane.rating.category">${p.cat}</button><div>${p.note}</div>
    <button data-item-id="address" aria-label="Address: ${p.addr}">${p.addr}</button>${phone}${site}</div>`;
}

const dir = mkdtempSync(join(tmpdir(), "ext-"));

// Serve the mock over local HTTPS and point www.google.com at it inside the browser,
// so the extension sees real https://www.google.com/maps/... URLs.
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=www.google.com",
  "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
let blockBob = false;
const server = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
  const url = new URL(req.url, "https://www.google.com");
  seen.push(url.pathname + url.search);
  let html = "<!doctype html>nope";
  if (url.pathname.startsWith("/maps/search/")) html = searchPage();
  else if (url.pathname.startsWith("/maps/place/")) {
    const name = decodeURIComponent(url.pathname.split("/")[3]);
    html = blockBob && name === "Bob Pipes"
      ? "<!doctype html><title>x</title><div role='main'><h1>Check</h1>Our systems have detected unusual traffic</div>"
      : placePage(name);
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((resolve) => server.listen(8443, "127.0.0.1", resolve));

const context = await chromium.launchPersistentContext(dir + "/profile", {
  headless: false,
  args: [
    "--headless=new",
    "--no-proxy-server",
    "--ignore-certificate-errors",
    "--host-resolver-rules=MAP www.google.com 127.0.0.1:8443",
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
  acceptDownloads: true,
});

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
const extensionId = new URL(worker.url()).host;
console.log("extension loaded:", extensionId);

// Toolbar click: opens the page once, then only focuses it.
await worker.evaluate(() => globalThis.openApp());
await new Promise((r) => setTimeout(r, 800));
await worker.evaluate(() => globalThis.openApp());
await new Promise((r) => setTimeout(r, 800));
const appPages = context.pages().filter((p) => p.url().endsWith("/app.html"));
assert.equal(appPages.length, 1, "toolbar click should open one app tab");
const page = appPages[0];
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

// ---- Full search --------------------------------------------------------
await page.fill("#niche", "Plumbers");
await page.fill("#location", "Austin, TX");
await page.fill("#limit", "6");
await page.click("#submit");
try {
  await page.waitForSelector("#download:not([hidden])", { timeout: 60000 });
} catch (error) {
  console.log("DIAGNOSTIC message:", await page.textContent("#message"), "| error:", await page.textContent("#error"));
  console.log("DIAGNOSTIC requests:", JSON.stringify(seen), "| pages:", context.pages().map((p) => p.url()));
  throw error;
}

const chips = async () => page.$$eval(".chip", (els) => els.map((e) => [e.textContent, e.getAttribute("aria-pressed")]));
const names = async () => page.$$eval("#rows tr td:first-child", (els) => els.map((e) => e.textContent));
console.log("message:", await page.textContent("#message"));
console.log("chips:", JSON.stringify(await chips()));
assert.deepEqual((await chips()).map((c) => c[0]), ["Checked: 6", "No website: 3", "Has website: 1", "Closed: 2"]);

const expectGroups = {
  "No website": ["Ada Plumbing", "Social Only", "Late Co"],
  "Has website": ["Bob Pipes"],
  Closed: ["Old Co", "Pause Co"],
  Checked: Object.keys(PLACES),
};
for (const [label, expected] of Object.entries(expectGroups)) {
  await page.click(`.chip:has-text("${label}")`);
  assert.deepEqual(await names(), expected, label);
  const csvLabel = await page.textContent("#download");
  assert.ok(csvLabel.includes(`${label} (${expected.length})`), csvLabel);
}

// Downloads for the Closed group only.
await page.click('.chip:has-text("Closed")');
const [csvDownload] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
const csvPath = join(dir, csvDownload.suggestedFilename());
await csvDownload.saveAs(csvPath);
const csvText = readFileSync(csvPath, "utf8");
console.log("csv:", csvDownload.suggestedFilename());
assert.equal(csvDownload.suggestedFilename(), "closed-plumbers-austin-tx.csv");
assert.equal(csvText.trim().split("\n").length, 3);
assert.ok(csvText.includes("Old Co") && csvText.includes("Pause Co") && !csvText.includes("Ada Plumbing"));

await page.click('.chip:has-text("No website")');
const [xlsxDownload] = await Promise.all([page.waitForEvent("download"), page.click("#download-xlsx")]);
const xlsxPath = join(dir, xlsxDownload.suggestedFilename());
await xlsxDownload.saveAs(xlsxPath);
console.log("xlsx:", xlsxDownload.suggestedFilename());
assert.equal(xlsxDownload.suggestedFilename(), "no-website-plumbers-austin-tx.xlsx");
const py = `
import json, sys
from openpyxl import load_workbook
ws = load_workbook(sys.argv[1]).active
head = [c.value for c in ws[1]]
print(json.dumps([{"name": r[0].value, "link": r[0].hyperlink.target if r[0].hyperlink else None,
  "result": r[head.index("result")].value, "reviews": r[head.index("review_count")].value,
  "status": r[head.index("status")].value, "website": r[head.index("website")].value} for r in ws.iter_rows(min_row=2)]))`;
const sheet = JSON.parse(execFileSync("python3", ["-c", py, xlsxPath], { encoding: "utf8" }));
console.log("xlsx rows:", JSON.stringify(sheet));
assert.deepEqual(sheet.map((r) => r.name), ["Ada Plumbing", "Social Only", "Late Co"]);
assert.ok(sheet.every((r) => r.result === "No website" && r.link && r.link.startsWith("https://www.google.com/maps/place/")));
assert.ok(sheet.every((r) => !r.link.includes("hl=en")), "hl=en should be stripped from saved links");
assert.equal(sheet.find((r) => r.name === "Late Co").status, "active"); // "Closed · Opens 9 AM" stays active
assert.ok(!sheet.find((r) => r.name === "Social Only").website); // social profile is not a website

// English labels were requested for every page, and the helper window closed itself.
const offenders = seen.filter((u) => u.startsWith("/maps/") && !u.includes("hl=en"));
console.log("non-maps requests:", JSON.stringify(seen.filter((u) => !u.startsWith("/maps/"))), "| maps requests without hl=en:", JSON.stringify(offenders));
assert.deepEqual(offenders, [], "every Maps request should carry hl=en");
assert.equal(context.pages().filter((p) => p.url().includes("google.com")).length, 0, "Maps window should be closed");
// Reviews: "1,204" -> 1204
await page.click('.chip:has-text("Has website")');
const [bobDownload] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
await bobDownload.saveAs(join(dir, "bob.csv"));
const bobText = readFileSync(join(dir, "bob.csv"), "utf8");
assert.ok(bobText.includes(",1204,"), "review count 1,204 should be saved as 1204");
assert.ok(bobText.includes("https://bob.example"));

// ---- Stop button keeps partial results ----------------------------------
await page.fill("#limit", "6");
await page.click("#submit");
await page.waitForSelector("#rows tr td a", { timeout: 30000 }); // first row arrived
await page.click("#stop");
await page.waitForSelector("#stop", { state: "hidden", timeout: 60000 });
const partial = (await names()).length;
console.log("stopped with rows:", partial, "|", await page.textContent("#message"));
assert.ok(partial >= 1 && partial < 6, "stop should keep some but not all rows");
assert.ok((await page.textContent("#message")).includes("Stopped early"));
assert.equal(context.pages().filter((p) => p.url().includes("google.com")).length, 0);

// ---- Last search survives reopening the page -----------------------------
await page.reload();
await page.waitForSelector("#rows tr td a", { timeout: 10000 });
assert.equal(await page.inputValue("#niche"), "Plumbers");
assert.ok((await page.textContent("#message")).startsWith("Last search"));

// ---- Blocked page aborts but keeps what was read -------------------------
blockBob = true;
await page.fill("#limit", "6");
await page.click("#submit");
await page.waitForSelector("#error:not([hidden])", { timeout: 60000 });
console.log("blocked:", await page.textContent("#error"));
assert.ok((await page.textContent("#error")).includes("unusual traffic"));
assert.deepEqual(await names(), ["Ada Plumbing"], "rows read before the check should be kept");

console.log("page errors:", errors);
assert.deepEqual(errors, []);
await context.close();
server.close();
console.log("ALL EXTENSION CHECKS PASSED");
