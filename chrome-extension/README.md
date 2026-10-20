# Google Maps Business Search — Chrome extension

The same search as the Python tool, running inside your own Google Chrome. Enter a niche and a location, and the extension reads the Google Maps listings, sorts each one as **No website**, **Has website** or **Closed**, and lets you download any group as CSV or Excel.

| Button | Shows and downloads |
| --- | --- |
| Checked | Every listing that was read |
| No website | Only active businesses with no website (a Facebook or Instagram link does not count as a website) |
| Has website | Only active businesses with a website |
| Closed | Only permanently or temporarily closed businesses |

In the Excel file each **Name is a clickable link** to its Google Maps listing. CSV files keep the link in the `maps_url` column.

## Install (Mac, Windows, Linux)

1. Unzip the extension folder somewhere it can stay (Chrome loads it from there).
2. In Chrome open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped `chrome-extension` folder.
5. Click the puzzle-piece icon in the toolbar and pin **Google Maps Business Search**.

## Use

1. Click the extension icon. A search tab opens.
2. Enter a niche (for example `plumbers`), a location (for example `Austin, TX`) and how many listings to check (up to 120), then click **Search Maps**.
3. A small Chrome window opens Google Maps and reads the listings one by one. **Keep the search tab open** until it finishes. Click **Stop** to end early and keep what was read.
4. Click **Checked**, **No website**, **Has website** or **Closed**, then **Download CSV** or **Download Excel**. The file contains only the group you picked.

Your last search is kept, so it is still there if you close and reopen the tab.

## Notes

- If Google shows a consent page or a "unusual traffic" check in the small Maps window, finish it there. The extension waits. If Maps keeps refusing, wait a while and run a smaller search.
- Labels are read in English (`hl=en` is added to Maps links) so "Permanently closed" and similar can be recognised.
- Email is always blank because no website is opened.
- Run one search at a time. Scraping can temporarily rate-limit your IP.
- Phone numbers are personal data. Use them only in line with the contact rules that apply to you.
- Scraping Google Maps may go against Google's terms. You are responsible for how you use it.

## Updating

Replace the folder contents, then press the reload arrow on the extension's card at `chrome://extensions`.

## Development

```bash
node --test tests/leads.test.mjs              # unit tests (Excel check needs python3 + openpyxl)
PLAYWRIGHT_MODULE=/path/to/playwright node tests/e2e.mjs   # loads the extension into Chromium against a mock Maps
```

`lib/leads.js` is the classification and file-writing logic (a port of `app/leads.py`), `lib/maps.js` drives the Maps window, and `lib/page.js` holds the functions that run inside the Maps page.
