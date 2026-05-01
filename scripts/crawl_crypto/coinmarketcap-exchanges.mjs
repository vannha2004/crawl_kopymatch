// coinmarketcap-exchanges.mjs
// Crawl exchange rankings from CoinMarketCap and save to JSON.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const DEFAULT_COUNT = 100;
const DEFAULT_OUTPUT = 'artifacts/coinmarketcap-exchanges.json';
const CMC_URL = 'https://coinmarketcap.com/rankings/exchanges/';

function parseArgs(argv) {
  const options = {
    count: DEFAULT_COUNT,
    output: DEFAULT_OUTPUT,
    headless: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count') options.count = Number(argv[++i]);
    else if (arg === '--output') options.output = argv[++i];
    else if (arg === '--headed') options.headless = false;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.count) || options.count <= 0) {
    throw new Error('--count must be a positive integer');
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/crawl_crypto/coinmarketcap-exchanges.mjs [options]

Options:
  --count <number>   Number of exchanges to crawl (default ${DEFAULT_COUNT})
  --output <path>    Output JSON path (default ${DEFAULT_OUTPUT})
  --headed           Run with visible browser
  --help             Show this help`);
}

async function launchBrowser(headless) {
  return await chromium.launch({ headless });
}

async function extractExchanges(page, limit) {
  await page.waitForSelector('table', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length > 0, { timeout: 120000 });

  return page.$$eval('table tbody tr', (trs, max) => {
    const table = trs[0]?.closest('table');
    const headerCells = table ? Array.from(table.querySelectorAll('thead th')) : [];
    const headers = headerCells.map(cell => (cell.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase());

    const indexFor = matcher => headers.findIndex(text => matcher(text));
    const rankIndex = indexFor(text => text === '#' || text.includes('rank'));
    const nameIndex = indexFor(text => text.includes('exchange'));
    const volumeIndex = indexFor(text => text.includes('volume'));
    const marketsIndex = indexFor(text => text.includes('markets'));

    const data = [];
    for (let i = 0; i < Math.min(trs.length, max); i++) {
      const row = trs[i];
      const cells = Array.from(row.querySelectorAll('td'));

      const cellText = index => {
        if (index < 0)
          return null;
        return cells[index]?.textContent?.replace(/\s+/g, ' ').trim() || null;
      };

      const rankCell = cells[rankIndex] || row.querySelector('td[aria-colindex="1"]');
      const nameCell = cells[nameIndex] || row.querySelector('td[aria-colindex="2"]');
      const volumeCell = cells[volumeIndex] || row.querySelector('td[aria-colindex="3"]');
      const marketsCell = cells[marketsIndex] || row.querySelector('td[aria-colindex="4"]');

      const rank = rankCell?.textContent?.replace(/\s+/g, ' ').trim() || cellText(rankIndex);
      const nameLink = nameCell?.querySelector('a');
      const name = nameLink?.textContent?.replace(/\s+/g, ' ').trim() || nameCell?.textContent?.replace(/\s+/g, ' ').trim() || cellText(nameIndex);
      const volume = volumeCell?.textContent?.replace(/\s+/g, ' ').trim() || cellText(volumeIndex);
      const markets = marketsCell?.textContent?.replace(/\s+/g, ' ').trim() || cellText(marketsIndex);
      const url = nameLink?.href || null;

      data.push({
        rank: rank ? Number(rank.replace(/[^0-9]/g, '')) : null,
        name: name || null,
        volume: volume || null,
        markets: markets ? Number(markets.replace(/[^0-9]/g, '')) : null,
        url,
      });
    }

    return data;
  }, limit);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const browser = await launchBrowser(options.headless);
  const page = await browser.newPage();
  await page.goto(CMC_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  const exchanges = await extractExchanges(page, options.count);

  const output = {
    source: 'coinmarketcap',
    generated_at: new Date().toISOString(),
    exchange_count: exchanges.length,
    exchanges,
  };

  const outputPath = path.resolve(options.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Saved ${exchanges.length} exchanges to ${outputPath}`);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
