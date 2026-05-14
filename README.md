# waterlooworks-exporter

Exporter for WaterlooWorks job postings.

The tool opens WaterlooWorks in Chromium, lets you log in and choose filters manually, then exports the visible job postings across pages to timestamped CSV and JSON files.

## Setup

```sh
git clone <repo-url>
cd waterlooworks-exporter
npm install
```

If Chromium is not available after `npm install`, install the Playwright browser runtime:

```sh
npx playwright install chromium
```

## Usage

```sh
npm start
```

The browser will open at WaterlooWorks. Log in if needed, apply the filters you want, and navigate to the job postings table. Return to the terminal and press Enter when ready.

Exports are written to `./export`:

```text
export/waterlooworks-jobs-YYYY-MM-DDTHH-MM-SSZ.csv
export/waterlooworks-jobs-YYYY-MM-DDTHH-MM-SSZ.json
```

The script also stores a local `waterlooworks-session.json` so you do not need to log in every run. Treat that file as private.

## Checking

```sh
npm run check
```

## Notes

Use this responsibly and avoid hammering WaterlooWorks. The exporter includes conservative delays and writes progress after every successfully scraped posting.

Generated exports and `waterlooworks-session.json` are ignored by git.
