# Google Maps business search

Open a local page in Google Chrome, enter a niche and a location, and download CSV or Excel files of the Google Maps listings it finds. Every listing is read and sorted into one of three groups:

- **No website**: operating business, no website on Maps. A Facebook, Instagram, or other profile link does not count as a website.
- **Has website**: operating business with a real website.
- **Closed**: permanently or temporarily closed.

The page shows four buttons with counts:

| Button | Shows and downloads |
| --- | --- |
| Checked | Every listing that was read |
| No website | Only active businesses with no website |
| Has website | Only active businesses with a website |
| Closed | Only closed businesses |

Pick a button, then use **Download CSV** or **Download Excel**. The file holds just that group. In the Excel file each Name is a clickable link to its Google Maps listing (CSV files keep the link in the `maps_url` column). Email stays blank because no website is opened. One Maps search usually stops around 120 listings.

## One-click launch

Install Python 3 and Google Chrome, then double-click the launcher for your system:

- Windows: `Start-Windows.bat`
- Mac: `Start-Mac.command` (first time: right-click, Open)
- Linux: `Start-Linux.sh`

The first run sets up a private environment and installs requirements, then opens the search in Chrome.

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m app
```

Then open [http://127.0.0.1:8765](http://127.0.0.1:8765) in Google Chrome.

The same search from the terminal:

```bash
.venv/bin/python -m app.scrape --niche "plumbers" --location "Austin, TX" --limit 25
```

This saves one CSV per group under `results/` (`all-checked-…`, `no-website-…`, `has-website-…`, `closed-…`). Add `--only no_website --out my-file.csv` to save a single group.

Scraping Google Maps can temporarily rate-limit the machine’s IP. Run one search at a time. Treat phones as personal data and follow the contact rules that apply to you.
