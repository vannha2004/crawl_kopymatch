# PropFirm Leaderboard Crawler

Crawls [PropFirmMatch](https://propfirmmatch.com) to collect prop firm data for the **KopyMatch Trust Score** leaderboard.

## Prerequisites

```bash
# From the repo root (D:\HaUI\KopyMatch\playwright)
npm install          # installs Playwright and all dependencies
npx playwright install chromium   # if no Chrome/Edge installed
```

## Quick Start

```bash
# Crawl all firms (headless)
npm run crawl:propfirms

# Crawl first 5 firms (for testing)
npm run crawl:propfirms -- --limit 5

# Crawl with visible browser
npm run crawl:propfirms -- --limit 5 --headed

# Custom output path
npm run crawl:propfirms -- --output ./data/test.json

# Skip risk evidence search
npm run crawl:propfirms -- --skip-risk-search true
```

## CLI Options

| Option | Default | Description |
|---|---|---|
| `--limit <n>` | `0` (all) | Max number of firms to crawl |
| `--output <path>` | `artifacts/propfirm_leaderboard.json` | Output JSON path |
| `--headless <bool>` | `true` | Run browser in headless mode |
| `--headed` | - | Shortcut for `--headless false` |
| `--skip-risk-search <bool>` | `false` | Skip risk evidence web search |
| `--channel <name>` | auto-detect | Browser channel (`chrome`, `msedge`) |

## Output

### Main JSON
`artifacts/propfirm_leaderboard.json` — Normalized data for all firms.

### Raw HTML Snapshots
`artifacts/raw/propfirmmatch/{slug}.html` — Full HTML of each firm's profile page.

### Output Schema
See the `crawl-propfirms.mjs` source or the user request for the full JSON schema.  
Key top-level fields:
- `source`, `crawl_type`, `crawl_started_at`, `crawl_finished_at`
- `total_firms`, `successful_firms`, `failed_firms`
- `firms[]` — each with `list_metrics`, `profile_detail`, `risk_evidence`, `data_quality`, `crawl_metadata`
- `errors[]` — firms that failed to crawl

## Risk Evidence Search

The risk search module uses a **pluggable SearchProvider** interface.  
Currently uses `MockSearchProvider` (returns empty results).

To enable real search, implement a provider in `search-provider.mjs`:
- Google Custom Search API
- Gemini Search Grounding
- SerpAPI

The mock provider preserves the full schema so all `risk_evidence` fields are ready.

## Running Tests

```bash
npm run test:propfirm-utils
```

Tests cover:
- `parseMoney` — `$400,000` → `400000`, `$100K` → `100000`
- `parsePercentage` — `80%` → `80`, `Up to 90%` → `90`
- `parseYears` — `10+` → `10`, `Less than 1` → `0.5`
- `computeDataConfidence` — full firm = 1.0, empty firm = 0.0
- JSON schema validation

## Scheduled Runs

For weekly scheduled crawls, add a cron job or GitHub Actions workflow:

```yaml
# .github/workflows/crawl-propfirms.yml
on:
  schedule:
    - cron: '0 6 * * 1'  # Every Monday at 6AM UTC
jobs:
  crawl:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx playwright install chromium
      - run: npm run crawl:propfirms
      - uses: actions/upload-artifact@v4
        with:
          name: propfirm-data
          path: artifacts/propfirm_leaderboard.json
```

## File Structure

```
scripts/crawl_propfirm/
├── crawl-propfirms.mjs    # Main crawler entry point
├── profile-scraper.mjs    # Profile detail scraper
├── search-provider.mjs    # Risk evidence search (mock + interface)
├── utils.mjs              # Parsing, validation, data quality
├── test-utils.mjs         # Unit tests
└── README.md              # This file
```
