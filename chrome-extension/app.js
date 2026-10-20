import {
  FILTER_KEYS,
  clickableMapsUrl,
  countResults,
  filterRows,
  resultFilename,
  rowsToCsv,
  rowsToXlsx,
} from "./lib/leads.js";
import { runSearch } from "./lib/maps.js";

const $ = (selector) => document.querySelector(selector);
const form = $("#search-form");
const submit = $("#submit");
const stopButton = $("#stop");
const statusBox = $("#status");
const message = $("#message");
const errorBox = $("#error");
const counts = $("#counts");
const tbody = $("#rows");
const downloadCsv = $("#download");
const downloadXlsx = $("#download-xlsx");

// key is the filter name; pick the number each button shows from the counts.
const FILTERS = [
  { key: "checked", label: "Checked", count: (c) => c.checked },
  { key: "no_website", label: "No website", count: (c) => c.found },
  { key: "has_website", label: "Has website", count: (c) => c.skipped_website },
  { key: "closed", label: "Closed", count: (c) => c.skipped_closed },
];

const state = {
  rows: [],
  message: "",
  error: "",
  running: false,
  niche: "",
  location: "",
  selected: "checked",
};
let stopRequested = false;
let blobUrls = [];

function td(text) {
  const cell = document.createElement("td");
  cell.textContent = text || "";
  return cell;
}

function rowFor(lead) {
  const tr = document.createElement("tr");
  const name = document.createElement("td");
  const link = clickableMapsUrl(lead.maps_url);
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = lead.name || "Maps listing";
    name.append(anchor);
  } else {
    name.textContent = lead.name || "";
  }
  tr.append(name, td(lead.phone), td(lead.category), td(lead.address), td(lead.rating), td(lead.review_count), td(lead.status), td(lead.result));
  return tr;
}

function makeBlobUrl(data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  blobUrls.push(url);
  return url;
}

function render() {
  statusBox.hidden = !(state.rows.length || state.message || state.error || state.running);
  message.textContent = state.message;
  errorBox.hidden = !state.error;
  errorBox.textContent = state.error;

  const totals = countResults(state.rows);
  counts.replaceChildren(
    ...FILTERS.map((filter) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("aria-pressed", String(filter.key === state.selected));
      chip.textContent = `${filter.label}: ${filter.count(totals)}`;
      chip.addEventListener("click", () => {
        state.selected = filter.key;
        render();
      });
      return chip;
    })
  );

  const current = FILTERS.find((filter) => filter.key === state.selected);
  const shown = filterRows(state.rows, state.selected);
  if (shown.length) {
    tbody.replaceChildren(...shown.map(rowFor));
  } else {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "empty";
    cell.textContent = state.running ? "Nothing in this group yet." : "Nothing in this group.";
    tr.append(cell);
    tbody.replaceChildren(tr);
  }

  blobUrls.forEach((url) => URL.revokeObjectURL(url));
  blobUrls = [];
  const ready = !state.running && shown.length > 0;
  downloadCsv.hidden = !ready;
  downloadXlsx.hidden = !ready;
  if (ready) {
    downloadCsv.href = makeBlobUrl(rowsToCsv(shown), "text/csv;charset=utf-8");
    downloadCsv.download = resultFilename(state.selected, state.niche, state.location, "csv");
    downloadXlsx.href = makeBlobUrl(rowsToXlsx(shown), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    downloadXlsx.download = resultFilename(state.selected, state.niche, state.location, "xlsx");
  }
  downloadCsv.textContent = `Download CSV: ${current.label} (${shown.length})`;
  downloadXlsx.textContent = `Download Excel: ${current.label} (${shown.length})`;

  submit.disabled = state.running;
  stopButton.hidden = !state.running;
  stopButton.disabled = stopRequested;
  stopButton.textContent = stopRequested ? "Stopping…" : "Stop";
}

async function save() {
  try {
    await chrome.storage.local.set({
      lastSearch: {
        niche: state.niche,
        location: state.location,
        limit: Number($("#limit").value) || 25,
        rows: state.rows,
        message: state.message,
        error: state.error,
      },
    });
  } catch {
    // storage is a convenience only
  }
}

async function restore() {
  try {
    const { lastSearch } = await chrome.storage.local.get("lastSearch");
    if (!lastSearch) return;
    $("#niche").value = lastSearch.niche || "";
    $("#location").value = lastSearch.location || "";
    $("#limit").value = lastSearch.limit || 25;
    Object.assign(state, {
      rows: Array.isArray(lastSearch.rows) ? lastSearch.rows : [],
      message: lastSearch.rows?.length ? `Last search: ${lastSearch.message || ""}`.trim() : "",
      error: "",
      niche: lastSearch.niche || "",
      location: lastSearch.location || "",
    });
    render();
  } catch {
    // nothing saved yet
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.running) return;
  const niche = $("#niche").value.trim();
  const location = $("#location").value.trim();
  const limit = Math.max(1, Math.min(Number($("#limit").value) || 25, 120));
  if (!niche || !location) return;

  stopRequested = false;
  Object.assign(state, { rows: [], message: "Starting…", error: "", running: true, niche, location, selected: "checked" });
  render();

  let lastSaved = 0;
  try {
    const result = await runSearch({
      niche,
      location,
      limit,
      shouldStop: () => stopRequested,
      onProgress: (progress) => {
        if (progress.rows) state.rows = progress.rows;
        if (progress.message) state.message = progress.message;
        render();
        if (state.rows.length - lastSaved >= 5) {
          lastSaved = state.rows.length;
          save();
        }
      },
    });
    state.rows = result.rows;
    state.message = result.message;
    state.error = result.error;
  } catch (caught) {
    state.error = caught?.message || String(caught);
    state.message = "";
  }
  state.running = false;
  stopRequested = false;
  render();
  save();
});

stopButton.addEventListener("click", () => {
  stopRequested = true;
  state.message = "Stopping after the current listing…";
  render();
});

window.addEventListener("beforeunload", (event) => {
  if (state.running) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// Exposed so tests can confirm the four buttons match the filter names the code uses.
window.__filterKeys = FILTER_KEYS;

restore();
