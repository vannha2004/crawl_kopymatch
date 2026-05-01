/**
 * PropFirm Leaderboard Crawler - Main Entry Point
 * Crawls propfirmmatch.com for firm data to build Trust Score leaderboard.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import {
  parseMoney, parsePercentage, parseYears, parseCount, parseRating,
  toSlug, extractSlugFromUrl, computeDataConfidence, validateOutput,
  randomDelay, cleanText,
} from './utils.mjs';
import { scrapeProfileDetail, getPageSnapshot } from './profile-scraper.mjs';
import { MockSearchProvider, collectRiskEvidence } from './search-provider.mjs';

const BASE_URL = 'https://propfirmmatch.com';
const LEADERBOARD_URL = `${BASE_URL}/prop-firm-reviews#table-scroll-target`;
const DEFAULT_OUTPUT = 'artifacts/propfirm_leaderboard.json';
const PARSER_VERSION = '1.0.0';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ─── CLI ────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { limit: 0, output: DEFAULT_OUTPUT, headless: true, skipRiskSearch: false, channel: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--output') opts.output = argv[++i];
    else if (a === '--headless') opts.headless = argv[++i] !== 'false';
    else if (a === '--headed') opts.headless = false;
    else if (a === '--skip-risk-search') opts.skipRiskSearch = argv[++i] !== 'false';
    else if (a === '--channel') opts.channel = argv[++i];
    else if (a === '--help') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`PropFirm Leaderboard Crawler

Usage: node scripts/crawl_propfirm/crawl-propfirms.mjs [options]

Options:
  --limit <n>             Max firms to crawl (0 = all). Default: 0
  --output <path>         Output JSON path. Default: ${DEFAULT_OUTPUT}
  --headless <bool>       Run headless. Default: true
  --headed                Run with visible browser
  --skip-risk-search <b>  Skip risk evidence search. Default: false
  --channel <name>        Browser channel (chrome, msedge)
  --help                  Show this help
`);
}

// ─── Browser Launch ─────────────────────────────────────────────────────────────
async function launchBrowser(channel, headless) {
  const stealthArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const candidates = channel ? [channel] : ['chrome', 'msedge'];
  for (const c of candidates) {
    try {
      const browser = await chromium.launch({ channel: c, headless, args: stealthArgs });
      console.log(`Browser: ${c}`);
      return browser;
    } catch {}
  }
  const browser = await chromium.launch({ headless, args: stealthArgs });
  console.log('Browser: bundled chromium');
  return browser;
}

// ─── Navigate With Cloudflare Retry ─────────────────────────────────────────────
async function navigateWithRetry(page, url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Check for Cloudflare block
      const blocked = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        return text.includes('you have been blocked') || 
               text.includes('Checking your browser') ||
               text.includes('Access denied') ||
               text.includes('cf-browser-verification');
      }).catch(() => false);

      if (blocked) {
        if (attempt < maxRetries) {
          const delay = 5000 * attempt;
          console.warn(`    ⚠ Cloudflare block detected (attempt ${attempt}/${maxRetries}), waiting ${delay/1000}s...`);
          await page.waitForTimeout(delay);
          continue;
        }
        console.warn(`    ⚠ Still blocked after ${maxRetries} attempts`);
        return false;
      }
      return true;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`    ⚠ Navigation failed (attempt ${attempt}): ${err.message}`);
      await page.waitForTimeout(3000 * attempt);
    }
  }
  return false;
}

// ─── Dismiss Popups ─────────────────────────────────────────────────────────────
async function dismissPopups(page) {
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Close")',
    '[class*="modal"] button:first-child',
    'button[aria-label="Close"]',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    } catch {}
  }
}

// ─── Scrape Firms Table ─────────────────────────────────────────────────────────
async function scrapeFirmsTable(page, limit) {
  // Try the dedicated all-prop-firms page first, then fallback to homepage
  const urls = [
    `${BASE_URL}/all-prop-firms?tab=all`,
    `${BASE_URL}/#table-scroll-target`,
  ];

  let loaded = false;
  for (const url of urls) {
    try {
      console.log(`  Trying: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(5000);
      await dismissPopups(page);

      // Check if firm links exist
      const count = await page.locator('a[href*="/prop-firms/"]').count();
      if (count > 2) { loaded = true; break; }
    } catch (err) {
      console.warn(`  ⚠ Failed to load ${url}: ${err.message}`);
    }
  }

  if (!loaded) {
    console.warn('  ⚠ Falling back to homepage with scroll...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    await dismissPopups(page);
  }

  // Scroll down fully to load everything
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
  }

  // Extract all firms using a[href*="/prop-firms/"] as anchor elements
  const firms = await page.evaluate((baseUrl) => {
    const results = [];
    const seenUrls = new Set();

    // Find all links to prop-firms profile pages
    const firmLinks = document.querySelectorAll('a[href*="/prop-firms/"]');

    for (const link of firmLinks) {
      const href = link.getAttribute('href');
      if (!href || href === '/prop-firms' || href === '/prop-firms/') continue;

      const profileUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;

      // Avoid duplicate URLs
      if (seenUrls.has(profileUrl)) continue;

      // Skip the "Firm" action button at the end of each row
      if (link.textContent.trim() === 'Firm') {
        seenUrls.add(profileUrl);
        continue;
      }

      // Walk up to find the row container
      let row = link;
      for (let up = 0; up < 8; up++) {
        if (!row.parentElement) break;
        row = row.parentElement;
        if (row.offsetWidth > 800 && row.offsetHeight > 50 && row.offsetHeight < 250) break;
      }

      const rowText = row.textContent || '';
      if (rowText.length < 20) continue;

      seenUrls.add(profileUrl);

      // Extract firm name from the link text
      let firmName = null;
      const nameP = link.querySelector('p, span, h3, h4');
      if (nameP) firmName = nameP.textContent.trim();
      else firmName = link.textContent.trim().split('\n')[0].trim();
      if (firmName) firmName = firmName.replace(/^\d+\s*/, '').trim();
      if (!firmName || firmName.length < 2) continue;

      // Rating
      const ratingMatch = rowText.match(/\b(\d\.\d)\b/);
      const starPoint = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      // Review count
      const reviewMatch = rowText.match(/(\d+)\s*reviews?/i);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[1], 10) : null;

      // Country
      let country = null;
      const validCodes = ['US','GB','UK','AE','CY','CH','AU','NL','HK','SG','IL','SE','BG','HU','MT','CZ','DK','EE','LT','PA','KN','SC','VC','VG','BZ'];
      const codeMatches = rowText.match(/\b([A-Z]{2})\b/g);
      if (codeMatches) {
        for (const code of codeMatches) {
          if (validCodes.includes(code)) { country = code; break; }
        }
      }

      // Years text
      let yearsText = null;
      const yearsFromText = rowText.match(/(\d+)\s*(?:year|yr)/i);
      if (yearsFromText) yearsText = yearsFromText[1];

      // Assets
      const assetKeywords = ['Crypto','FX','Forex','Indices','Metals','Stocks','Energy','Other Commodities','Commodities'];
      const assets = assetKeywords.filter(a => rowText.includes(a));

      // Max allocation - take the largest dollar amount
      const allocMatches = rowText.match(/\$[\d.,]+[KkMm]?/g);
      let allocText = null;
      if (allocMatches) {
        let maxVal = 0;
        for (const m of allocMatches) {
          let v = m.replace(/[\$,\s]/g, '');
          if (/[Kk]$/.test(v)) v = parseFloat(v) * 1000;
          else if (/[Mm]$/.test(v)) v = parseFloat(v) * 1000000;
          else v = parseFloat(v);
          if (v > maxVal) { maxVal = v; allocText = m.trim(); }
        }
      }

      results.push({
        firm_name: firmName,
        profile_url: profileUrl,
        star_point: starPoint,
        review_count: reviewCount,
        country,
        years_text: yearsText,
        alloc_text: allocText,
        assets,
        raw_text: rowText.substring(0, 500),
      });
    }

    return results;
  }, BASE_URL);

  // Deduplicate by firm_name
  const seen = new Set();
  const unique = firms.filter(f => {
    const key = f.firm_name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Found ${unique.length} firms in table`);
  return limit > 0 ? unique.slice(0, limit) : unique;
}


// ─── Scrape Firm Profile ────────────────────────────────────────────────────────
async function scrapeFirmProfile(page, firmEntry, rawDir, skipRiskSearch, searchProvider) {
  const { firm_name, profile_url, star_point, review_count, country, years_text, alloc_text, assets, raw_text } = firmEntry;

  const slug = extractSlugFromUrl(profile_url || '') || toSlug(firm_name);
  console.log(`\n→ Crawling: ${firm_name} (${slug})`);

  const firm = {
    firm_name,
    slug,
    profile_url: profile_url || `${BASE_URL}/prop-firms/${slug}`,
    website_url: null,
    country: country || null,
    list_metrics: {
      years_in_operation: parseYears(years_text),
      star_point: star_point ?? null,
      review_count: review_count ?? null,
      payout_proof_status: null,
      payout_proof_count: null,
      platforms: [],
      max_allocation: parseMoney(alloc_text),
      profit_split: null,
      assets: assets || [],
    },
    profile_detail: {
      overview_text: null,
      challenges: [],
      offer: { offer_text: null, discount_percent: null, coupon_code: null, valid_until: null },
      payout: { payout_frequency: null, first_payout_days: null, min_payout: null, payout_methods: [], payout_proof_url: null },
      rules: {
        raw_rules_text: null, news_trading_rule: null, copy_trading_rule: null,
        ea_allowed: null, weekend_holding_allowed: null, lot_size_limit: null,
        consistency_rule: null, kyc_restriction: null, hidden_rule_flags: [],
      },
    },
    risk_evidence: [],
    data_quality: { missing_fields: [], warnings: [], data_confidence: 0 },
    crawl_metadata: {
      source_url: profile_url || `${BASE_URL}/prop-firms/${slug}`,
      crawled_at: new Date().toISOString(),
      raw_snapshot_file: null,
      parser_version: PARSER_VERSION,
    },
  };

  // Navigate to profile page
  const targetUrl = firm.profile_url;
  try {
    const pageLoaded = await navigateWithRetry(page, targetUrl);
    await dismissPopups(page);
    if (!pageLoaded) {
      firm.data_quality.warnings.push('Cloudflare blocked - profile data unavailable');
      const quality = computeDataConfidence(firm);
      firm.data_quality = { ...quality, warnings: [...quality.warnings, 'Cloudflare blocked - profile data unavailable'] };
      return firm;
    }

    // Extract additional header info (CEO, Trustpilot, Date Created, etc.)
    const headerInfo = await page.evaluate(() => {
      const text = document.body.innerText;
      const result = {};

      // Years in operation from profile header
      const yearsMatch = text.match(/Years\s*in\s*Operation\s*[:\s]*(\d+)/i);
      if (yearsMatch) result.years_in_operation = parseInt(yearsMatch[1], 10);

      // Country
      const countryMatch = text.match(/Country\s*[:\s]*(?:🇬🇧|🇺🇸|🇦🇪|🇨🇾|🇨🇭|🇦🇺)?\s*([A-Z]{2})\b/);
      if (countryMatch) result.country = countryMatch[1];

      // Trust Pilot rating
      const tpMatch = text.match(/Trust\s*Pilot\s*[:\s]*([\d.]+)/i);
      if (tpMatch) result.trustpilot = parseFloat(tpMatch[1]);

      // Star rating and reviews from profile header
      const ratingMatch = text.match(/([\d.]+)\s*★+\s*(\d+)/);
      if (ratingMatch) {
        result.star_point = parseFloat(ratingMatch[1]);
        result.review_count = parseInt(ratingMatch[2], 10);
      }

      // Total reviews
      const totalReviewMatch = text.match(/(\d+)\s*total\s*reviews?/i);
      if (totalReviewMatch) result.review_count = parseInt(totalReviewMatch[1], 10);

      // Profit split
      const profitMatch = text.match(/(?:profit\s*split|profit\s*sharing)[:\s]*(?:up\s*to\s*)?([\d.]+)\s*%/i);
      if (profitMatch) result.profit_split = parseFloat(profitMatch[1]);

      // Platforms
      const platformIcons = document.querySelectorAll('[class*="platform"] img, [alt*="MT4"], [alt*="MT5"], [alt*="cTrader"]');
      result.platforms = [];
      const platformKeywords = ['MT4', 'MT5', 'MetaTrader 4', 'MetaTrader 5', 'cTrader', 'DXtrade', 'TradeLocker', 'Match-Trader'];
      for (const kw of platformKeywords) {
        if (text.includes(kw)) result.platforms.push(kw);
      }

      // Payout proof status
      if (text.includes('Payout Data is Unavailable')) result.payout_proof_status = 'unavailable';
      else if (text.includes('Payout Proof') || text.includes('Payouts')) result.payout_proof_status = 'available';

      return result;
    }).catch(() => ({}));

    // Merge header info
    if (headerInfo.years_in_operation && !firm.list_metrics.years_in_operation)
      firm.list_metrics.years_in_operation = headerInfo.years_in_operation;
    if (headerInfo.country && !firm.country) firm.country = headerInfo.country;
    if (headerInfo.star_point && !firm.list_metrics.star_point)
      firm.list_metrics.star_point = headerInfo.star_point;
    if (headerInfo.review_count && !firm.list_metrics.review_count)
      firm.list_metrics.review_count = headerInfo.review_count;
    if (headerInfo.profit_split) firm.list_metrics.profit_split = headerInfo.profit_split;
    if (headerInfo.platforms?.length > 0 && firm.list_metrics.platforms.length === 0)
      firm.list_metrics.platforms = headerInfo.platforms;
    if (headerInfo.payout_proof_status) firm.list_metrics.payout_proof_status = headerInfo.payout_proof_status;

    // Scrape profile detail sections
    const profileDetail = await scrapeProfileDetail(page);
    firm.profile_detail = { ...firm.profile_detail, ...profileDetail };

    // Save raw HTML snapshot
    try {
      const html = await getPageSnapshot(page);
      const snapshotPath = path.join(rawDir, `${slug}.html`);
      await fs.mkdir(rawDir, { recursive: true });
      await fs.writeFile(snapshotPath, html, 'utf8');
      firm.crawl_metadata.raw_snapshot_file = snapshotPath;
    } catch (e) {
      console.warn(`  ⚠ Snapshot save failed: ${e.message}`);
    }
  } catch (err) {
    console.error(`  ✗ Profile scrape failed: ${err.message}`);
    firm.data_quality.warnings.push(`Profile scrape failed: ${err.message}`);
  }

  // Risk evidence
  if (!skipRiskSearch) {
    try {
      console.log('  Collecting risk evidence...');
      firm.risk_evidence = await collectRiskEvidence(firm_name, searchProvider);
    } catch (e) {
      console.warn(`  ⚠ Risk search failed: ${e.message}`);
    }
  }

  // Compute data quality
  const quality = computeDataConfidence(firm);
  firm.data_quality = { ...quality };

  return firm;
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   PropFirm Leaderboard Crawler v1.0.0   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Options: limit=${opts.limit || 'all'}, headless=${opts.headless}, skipRisk=${opts.skipRiskSearch}`);

  const crawlStartedAt = new Date().toISOString();
  const browser = await launchBrowser(opts.channel, opts.headless);
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const searchProvider = new MockSearchProvider();
  const outputPath = path.resolve(opts.output);
  const rawDir = path.resolve(path.dirname(outputPath), 'raw', 'propfirmmatch');

  const output = {
    source: 'propfirmmatch',
    crawl_type: 'propfirm_leaderboard',
    crawl_started_at: crawlStartedAt,
    crawl_finished_at: '',
    total_firms: 0,
    successful_firms: 0,
    failed_firms: 0,
    version: PARSER_VERSION,
    firms: [],
    errors: [],
  };

  try {
    // Step 1: Scrape the firms table
    console.log('\n📋 Step 1: Scraping firms list...');
    const firmEntries = await scrapeFirmsTable(page, opts.limit);
    output.total_firms = firmEntries.length;

    // Step 2: Scrape each firm's profile
    console.log(`\n📄 Step 2: Scraping ${firmEntries.length} firm profiles...`);
    for (let i = 0; i < firmEntries.length; i++) {
      const entry = firmEntries[i];
      console.log(`\n[${i + 1}/${firmEntries.length}] ${entry.firm_name}`);

      if (!entry.firm_name || (!entry.profile_url && !toSlug(entry.firm_name))) {
        console.warn(`  ⚠ Skipping: no name or profile URL`);
        output.errors.push({
          firm_name: entry.firm_name || null,
          profile_url: entry.profile_url || null,
          error_type: 'skip',
          message: 'Missing firm_name or profile_url',
        });
        output.failed_firms++;
        continue;
      }

      try {
        const firm = await scrapeFirmProfile(page, entry, rawDir, opts.skipRiskSearch, searchProvider);
        output.firms.push(firm);
        output.successful_firms++;
        console.log(`  ✓ Done (confidence: ${firm.data_quality.data_confidence})`);
      } catch (err) {
        console.error(`  ✗ Failed: ${err.message}`);
        output.errors.push({
          firm_name: entry.firm_name,
          profile_url: entry.profile_url || null,
          error_type: err.name || 'Error',
          message: err.message,
        });
        output.failed_firms++;
      }

      // Polite delay between requests
      if (i < firmEntries.length - 1) await randomDelay(2000, 4000);
    }
  } finally {
    await browser.close();
  }

  output.crawl_finished_at = new Date().toISOString();

  // Validate output
  const validationErrors = validateOutput(output);
  if (validationErrors.length > 0) {
    console.warn('\n⚠ Validation warnings:');
    for (const e of validationErrors) console.warn(`  - ${e}`);
  }

  // Write output
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');

  // Summary
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║            Crawl Summary                 ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Total firms:      ${output.total_firms}`);
  console.log(`  Successful:       ${output.successful_firms}`);
  console.log(`  Failed:           ${output.failed_firms}`);
  console.log(`  Output:           ${outputPath}`);
  console.log(`  Duration:         ${((new Date(output.crawl_finished_at) - new Date(output.crawl_started_at)) / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1; });
