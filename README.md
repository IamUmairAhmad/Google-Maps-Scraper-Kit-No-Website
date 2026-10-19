# No-website Google Maps search

Open a local page in Google Chrome, enter a niche and a location, and download a CSV of active businesses that do not have a website.

A Google Chrome window opens for the search. Closed and temporarily closed listings are dropped. A Facebook, Instagram, or other profile link does not count as a website. Email stays blank because there is no site to read. One Maps search usually stops around 120 listings.

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

The CSV is saved under `results/`.

Scraping Google Maps can temporarily rate-limit the machine’s IP. Run one search at a time. Treat phones as personal data and follow the contact rules that apply to you.
