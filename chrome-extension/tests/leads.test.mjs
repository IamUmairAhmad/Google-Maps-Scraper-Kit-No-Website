import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LEAD_COLUMNS,
  businessWebsite,
  classifyResult,
  classifyStatus,
  clickableMapsUrl,
  countResults,
  csvCell,
  filterRows,
  hasWebsite,
  resultFilename,
  reviewCountFromPanel,
  rowsToCsv,
  rowsToXlsx,
  withResult,
} from "../lib/leads.js";

const ROWS = [
  { name: "A", status: "active", website: "", maps_url: "https://www.google.com/maps/place/A" },
  { name: "B", status: "active", website: "https://b.example", maps_url: "https://www.google.com/maps/place/B" },
  { name: "C", status: "permanently closed", website: "", maps_url: "https://www.google.com/maps/place/C" },
  { name: "D", status: "temporarily closed", website: "https://d.example", maps_url: "" },
  { name: "E", status: "active", website: "https://facebook.com/e", maps_url: "https://www.google.com/maps/place/E" },
];

test("open later today is still active; closed-down labels are not", () => {
  assert.equal(classifyStatus("Closed · Opens 9 AM"), "active");
  assert.equal(classifyStatus("Permanently closed"), "permanently closed");
  assert.equal(classifyStatus("Temporarily closed"), "temporarily closed");
});

test("website detection ignores blanks and social profiles", () => {
  assert.equal(hasWebsite(""), false);
  assert.equal(hasWebsite("  "), false);
  assert.equal(hasWebsite("n/a"), false);
  assert.equal(hasWebsite("https://example.com"), true);
  assert.equal(hasWebsite("https://www.facebook.com/asliceofeden/menu/"), false);
  assert.equal(hasWebsite("https://instagram.com/example"), false);
  assert.equal(businessWebsite("https://www.facebook.com/asliceofeden/menu/"), "");
  assert.equal(businessWebsite("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F"), "https://example.com/");
});

test("review count comes from the header, not the phone number", () => {
  assert.equal(reviewCountFromPanel("Mount Dessert Bakery\n4.6\n(1,234)\nCafe\n(207) 801-9191"), "1234");
  assert.equal(reviewCountFromPanel("Place\n(207) 801-9191\n4.6\n(530)\n"), "530");
});

test("every listing gets one result and the four filters split them", () => {
  assert.deepEqual(ROWS.map(classifyResult), ["No website", "Has website", "Closed", "Closed", "No website"]);
  assert.equal(withResult(ROWS[0]).result, "No website");
  const names = (key) => filterRows(ROWS, key).map((r) => r.name);
  assert.deepEqual(names("checked"), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(names("no_website"), ["A", "E"]);
  assert.deepEqual(names("has_website"), ["B"]);
  assert.deepEqual(names("closed"), ["C", "D"]);
  assert.throws(() => filterRows(ROWS, "other"));
  assert.deepEqual(countResults(ROWS), { checked: 5, found: 2, skipped_website: 1, skipped_closed: 2 });
});

test("file names follow the filter", () => {
  assert.equal(resultFilename("no_website", "Plumbers", "Austin, TX"), "no-website-plumbers-austin-tx.csv");
  assert.equal(resultFilename("checked", "a", "b", "xlsx"), "all-checked-a-b.xlsx");
});

test("CSV has the lead header, quotes commas and guards formulas", () => {
  assert.equal(csvCell("=cmd"), "'=cmd");
  const text = rowsToCsv([withResult({ name: "Ada, Plumbing", status: "active", website: "", maps_url: "https://m", niche: "plumbers", location: "Austin, TX" })]);
  assert.ok(text.startsWith("name,phone,email,website,category,address,rating,review_count,status,result,maps_url,niche,location\n"));
  assert.ok(text.includes('"Ada, Plumbing"'));
  assert.ok(text.includes('"Austin, TX"'));
});

test("long Maps links fall back to a short cid link", () => {
  assert.equal(clickableMapsUrl("javascript:alert(1)"), "");
  const long = "https://www.google.com/maps/place/X/data=!1s0x89c:0xff!8m2" + "a".repeat(2100);
  assert.equal(clickableMapsUrl(long), "https://www.google.com/maps?cid=255");
});

// Build an .xlsx with the JS writer and read it back with Python's openpyxl.
test("Excel file opens, names link to Maps, and nothing is a formula", () => {
  const rows = [
    withResult({ ...ROWS[0], name: '=HYPERLINK("http://evil")' }),
    withResult({ ...ROWS[3], name: "Pause & Co <test>" }),
    withResult({ ...ROWS[1], name: "Zoë Café 配管" }),
  ];
  const dir = mkdtempSync(join(tmpdir(), "xlsx-"));
  const file = join(dir, "out.xlsx");
  writeFileSync(file, rowsToXlsx(rows));
  const script = `
import json, sys
from openpyxl import load_workbook
ws = load_workbook(sys.argv[1]).active
out = {"header": [c.value for c in ws[1]], "rows": []}
for r in ws.iter_rows(min_row=2):
    out["rows"].append({"name": r[0].value, "type": r[0].data_type, "link": r[0].hyperlink.target if r[0].hyperlink else None, "result": r[LEADS.index("result")].value})
print(json.dumps(out))
`.replace("LEADS", JSON.stringify(LEAD_COLUMNS));
  let result;
  try {
    result = JSON.parse(execFileSync("python3", ["-c", script, file], { encoding: "utf8" }));
  } catch (error) {
    if (/No module named/.test(String(error.stderr))) return; // openpyxl not installed here
    throw error;
  }
  assert.deepEqual(result.header, LEAD_COLUMNS);
  assert.equal(result.rows[0].name, '=HYPERLINK("http://evil")');
  assert.notEqual(result.rows[0].type, "f");
  assert.equal(result.rows[0].link, "https://www.google.com/maps/place/A");
  assert.equal(result.rows[1].name, "Pause & Co <test>");
  assert.equal(result.rows[1].link, null); // no Maps link on that row
  assert.equal(result.rows[1].result, "Closed");
  assert.equal(result.rows[2].name, "Zoë Café 配管");
});
