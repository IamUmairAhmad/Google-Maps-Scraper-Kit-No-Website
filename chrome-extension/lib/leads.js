// Classify Maps listings (No website / Has website / Closed), filter them, and write CSV or Excel.
// Port of app/leads.py. Pure functions only, so it runs in the extension page and in Node tests.

export const LEAD_COLUMNS = [
  "name",
  "phone",
  "email",
  "website",
  "category",
  "address",
  "rating",
  "review_count",
  "status",
  "result",
  "maps_url",
  "niche",
  "location",
];

export const RESULT_NO_WEBSITE = "No website";
export const RESULT_HAS_WEBSITE = "Has website";
export const RESULT_CLOSED = "Closed";

// The four buttons on the page. "checked" is every listing that was opened.
export const FILTER_KEYS = ["checked", "no_website", "has_website", "closed"];
const RESULT_FOR_FILTER = {
  no_website: RESULT_NO_WEBSITE,
  has_website: RESULT_HAS_WEBSITE,
  closed: RESULT_CLOSED,
};
const FILENAME_FOR_FILTER = {
  checked: "all-checked",
  no_website: "no-website",
  has_website: "has-website",
  closed: "closed",
};

const EMPTY_WEBSITE = new Set(["", "n/a", "na", "-", "none", "null", "undefined"]);
const PROFILE_HOSTS = [
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
];

// "Closed · Opens 9 AM" is still an operating business. Only the closed-down labels drop a listing.
export function classifyStatus(panelText) {
  const text = (panelText || "").toLowerCase();
  if (text.includes("permanently closed")) return "permanently closed";
  if (text.includes("temporarily closed")) return "temporarily closed";
  return "active";
}

function hostname(url) {
  const candidate = url.includes("://") ? url : `https://${url}`;
  try {
    let host = new URL(candidate).hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return "";
  }
}

export function unwrapGoogleRedirect(url) {
  const text = (url || "").trim();
  let parsed;
  try {
    parsed = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return text;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if ((host === "google.com" || host === "maps.google.com") && parsed.pathname.startsWith("/url")) {
    return (parsed.searchParams.get("q") || "").trim() || text;
  }
  return text;
}

function isProfileHost(host) {
  return PROFILE_HOSTS.some((name) => host === name || host.endsWith("." + name));
}

// True when Maps lists a real site. Social profiles do not count.
export function hasWebsite(value) {
  const text = unwrapGoogleRedirect(value || "").trim();
  if (EMPTY_WEBSITE.has(text.toLowerCase())) return false;
  return !isProfileHost(hostname(text));
}

export function businessWebsite(value) {
  const text = unwrapGoogleRedirect(value || "").trim();
  return hasWebsite(text) ? text : "";
}

export function reviewCountFromPanel(panelText) {
  const header = (panelText || "").slice(0, 900);
  // "(530)" is the review count. "(207) 801-9191" is a phone, so skip it.
  const match = header.match(/\((\d[\d,]*)\)(?!\s*\d)/) || header.match(/(\d[\d,]*)\s+reviews\b/i);
  return match ? match[1].replace(/,/g, "") : "";
}

export function isActive(status) {
  return (status || "").trim().toLowerCase() === "active";
}

// One label per listing: Closed, Has website, or No website.
export function classifyResult(row) {
  if (!isActive(row.status)) return RESULT_CLOSED;
  if (hasWebsite(row.website)) return RESULT_HAS_WEBSITE;
  return RESULT_NO_WEBSITE;
}

export function withResult(row) {
  return { ...row, result: classifyResult(row) };
}

// Rows for one of the four buttons. "checked" returns every row.
export function filterRows(rows, key) {
  if (!FILTER_KEYS.includes(key)) throw new Error(`Unknown filter: ${key}`);
  if (key === "checked") return [...rows];
  const label = RESULT_FOR_FILTER[key];
  return rows.filter((row) => classifyResult(row) === label);
}

export function countResults(rows) {
  const counts = { checked: 0, found: 0, skipped_website: 0, skipped_closed: 0 };
  for (const row of rows) {
    counts.checked += 1;
    const label = classifyResult(row);
    if (label === RESULT_NO_WEBSITE) counts.found += 1;
    else if (label === RESULT_HAS_WEBSITE) counts.skipped_website += 1;
    else counts.skipped_closed += 1;
  }
  return counts;
}

// A spreadsheet runs text that starts with these as a formula. Prefix a quote so it stays text.
export function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function csvQuote(text) {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(rows) {
  const lines = [LEAD_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(LEAD_COLUMNS.map((column) => csvQuote(csvCell(row[column]))).join(","));
  }
  return lines.join("\n") + "\n";
}

// A Maps link safe to put behind a name. Empty when there is no usable link.
export function clickableMapsUrl(url) {
  const text = (url || "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  if (text.length <= 2000) return text;
  // Very long place URLs break some spreadsheet apps. The CID form is short.
  const match = text.match(/!1s0x[0-9a-f]+:0x([0-9a-f]+)/);
  return match ? `https://www.google.com/maps?cid=${BigInt("0x" + match[1]).toString()}` : "";
}

export function slug(value, fallback = "search") {
  const text = (value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return text || fallback;
}

export function resultFilename(key, niche, location, extension = "csv") {
  if (!FILTER_KEYS.includes(key)) throw new Error(`Unknown filter: ${key}`);
  return `${FILENAME_FOR_FILTER[key]}-${slug(niche)}-${slug(location)}.${extension}`;
}

// ---------------------------------------------------------------------------
// Excel (.xlsx) writer. An .xlsx file is a zip of XML parts, so this builds a
// stored (uncompressed) zip by hand. Names link to Maps through real hyperlink
// relationships, and every cell is plain text, so nothing can run as a formula.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, text] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0),
    ]);
    chunks.push(local, nameBytes, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + nameBytes.length + data.length;
  }
  const centralStart = offset;
  for (const entry of central) {
    const header = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(entry.crc), ...u32(entry.size), ...u32(entry.size), ...u16(entry.nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(entry.offset),
    ]);
    chunks.push(header, entry.nameBytes);
    offset += header.length + entry.nameBytes.length;
  }
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(offset - centralStart), ...u32(centralStart), ...u16(0),
  ]);
  chunks.push(end);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 cannot hold most control characters. Drop them rather than corrupt the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
}

function columnLetter(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// Returns a Uint8Array holding an .xlsx file. Each Name links to its Maps listing.
export function rowsToXlsx(rows) {
  const links = [];
  const widths = LEAD_COLUMNS.map((column) => column.length);
  const textCell = (ref, value, style) =>
    `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;

  let sheetRows = `<row r="1">${LEAD_COLUMNS.map((column, i) => textCell(`${columnLetter(i)}1`, column, 1)).join("")}</row>`;
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const link = clickableMapsUrl(row.maps_url);
    const cells = LEAD_COLUMNS.map((column, i) => {
      const raw = row[column];
      const value = raw === null || raw === undefined ? "" : String(raw);
      widths[i] = Math.max(widths[i], Math.min(value.length, 60));
      const isLinkedName = i === 0 && link && value;
      return textCell(`${columnLetter(i)}${rowNumber}`, value, isLinkedName ? 2 : 0);
    });
    if (link && row[LEAD_COLUMNS[0]]) links.push({ ref: `A${rowNumber}`, url: link });
    sheetRows += `<row r="${rowNumber}">${cells.join("")}</row>`;
  });

  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w + 2}" customWidth="1"/>`).join("");
  const hyperlinks = links.length
    ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>`
    : "";
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const sheet =
    header +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${sheetRows}</sheetData>${hyperlinks}</worksheet>`;

  const files = [
    ["[Content_Types].xml", header +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>"],
    ["_rels/.rels", header +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>"],
    ["xl/workbook.xml", header +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", header +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>"],
    ["xl/styles.xml", header +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ["xl/worksheets/sheet1.xml", sheet],
  ];
  if (links.length) {
    files.push(["xl/worksheets/_rels/sheet1.xml.rels", header +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      links.map((l, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(l.url)}" TargetMode="External"/>`
      ).join("") +
      "</Relationships>"]);
  }
  return zipStore(files);
}
