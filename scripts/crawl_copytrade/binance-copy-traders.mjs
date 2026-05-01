import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

const DEFAULT_COUNT = 50;
const DEFAULT_TIME_RANGE = '180D';
const DEFAULT_OUTPUT = 'artifacts/binance-copy-traders.json';
const BINANCE_COPY_TRADING_URL = 'https://www.binance.com/en/copy-trading';

function parseArgs(argv) {
  const options = {
    count: DEFAULT_COUNT,
    timeRange: DEFAULT_TIME_RANGE,
    output: DEFAULT_OUTPUT,
    channel: null,
    headless: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count')
      options.count = Number(argv[++i]);
    else if (arg === '--time-range')
      options.timeRange = String(argv[++i]).toUpperCase();
    else if (arg === '--output')
      options.output = argv[++i];
    else if (arg === '--channel')
      options.channel = argv[++i];
    else if (arg === '--headed')
      options.headless = false;
    else if (arg === '--help')
      options.help = true;
    else
      throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.count) || options.count <= 0)
    throw new Error('--count must be a positive integer');

  if (!/^\d+D$/i.test(options.timeRange))
    throw new Error('--time-range must look like 30D, 90D, 180D');

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/crawl_copytrade/binance-copy-traders.mjs [options]

Options:
  --count <number>        Number of traders to crawl. Default: ${DEFAULT_COUNT}
  --time-range <range>    Performance window. Default: ${DEFAULT_TIME_RANGE}
  --output <path>         Output JSON path. Default: ${DEFAULT_OUTPUT}
  --channel <name>        Browser channel, for example chrome or msedge
  --headed                Run with visible browser
  --help                  Show this help
`);
}

async function launchBrowser(channel, headless) {
  const candidates = channel ? [channel] : ['chrome', 'msedge'];
  let lastError;

  for (const candidate of candidates) {
    try {
      const browser = await chromium.launch({ channel: candidate, headless });
      return { browser, channel: candidate };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function fetchJson(page, url, options = {}) {
  const response = await page.evaluate(async ({ url, options }) => {
    const fetchOptions = { ...options };
    const headers = { ...(fetchOptions.headers || {}) };
    if (fetchOptions.body && !headers['content-type'])
      headers['content-type'] = 'application/json';
    fetchOptions.headers = headers;

    const result = await fetch(url, fetchOptions);
    const text = await result.text();
    return {
      ok: result.ok,
      status: result.status,
      text,
    };
  }, { url, options });

  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}`);
  }

  if (!response.ok || payload.success === false)
    throw new Error(`Request failed for ${url}: HTTP ${response.status} ${payload.code || ''} ${payload.message || ''}`.trim());

  return payload;
}

function formatNumber(value, decimals = 2) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatSignedNumber(value, decimals = 2) {
  const numericValue = Number(value || 0);
  const sign = numericValue > 0 ? '+' : numericValue < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(numericValue), decimals)}`;
}

function formatPercent(value, { signed = false } = {}) {
  const numericValue = Number(value || 0);
  const sign = signed && numericValue > 0 ? '+' : numericValue < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(numericValue), 2)}%`;
}

function formatRatio(value) {
  const numericValue = Number(value || 0);
  const sign = numericValue < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(numericValue), 2)}`;
}

function formatUsd(value) {
  return `${formatNumber(value, 2)} USDT`;
}

function formatSignedUsd(value) {
  return `${formatSignedNumber(value, 2)} USDT`;
}

function formatLockPeriod(days) {
  const numericDays = Number(days || 0);
  return numericDays === 0 ? '0' : `${numericDays} Days`;
}

function formatMinimumCopyAmount(detail) {
  const fixedRatioMin = Number(detail.fixedRadioMinCopyUsd || 0);
  const fixedAmountMin = Number(detail.fixedAmountMinCopyUsd || 0);
  return `${formatNumber(fixedRatioMin, 0)}/${formatNumber(fixedAmountMin, 0)} USDT`;
}

function formatCopiers(detail) {
  const maxCopyCount = detail.finalEffectiveMaxCopyCount ?? detail.riskControlMaxCopyCount ?? detail.maxCopyCount ?? 0;
  return `${detail.currentCopyCount ?? 0}/${maxCopyCount}`;
}

function calculateDaysTrading(startTime) {
  if (!startTime)
    return '0';
  return String(Math.max(0, Math.floor((Date.now() - Number(startTime)) / 86400000)));
}

function buildProfileUrl(leadPortfolioId, timeRange) {
  return `https://www.binance.com/en/copy-trading/lead-details/${leadPortfolioId}?timeRange=${timeRange}&isSmartFilter=true`;
}

async function fetchTopTraders(page, count, timeRange) {
  const payload = {
    pageNumber: 1,
    pageSize: count,
    timeRange,
    dataType: 'PNL',
    favoriteOnly: false,
    hideFull: false,
    nickname: '',
    order: 'DESC',
    userAsset: 0,
    portfolioType: 'ALL',
    useAiRecommended: true,
  };

  const response = await fetchJson(
      page,
      '/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
  );

  return response.data?.list || [];
}

async function fetchTraderSnapshot(page, rank, leadPortfolioId, timeRange) {
  const [detailResponse, performanceResponse] = await Promise.all([
    fetchJson(page, `/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${leadPortfolioId}`),
    fetchJson(page, `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${leadPortfolioId}&timeRange=${timeRange}`),
  ]);

  const detail = detailResponse.data || {};
  const performance = performanceResponse.data || {};

  return {
    rank,
    trader_name: String(detail.nickname || '').trim(),
    profile_url: buildProfileUrl(leadPortfolioId, timeRange),
    ROI: formatPercent(performance.roi, { signed: true }),
    PnL: formatSignedNumber(performance.pnl, 2),
    'Copier PnL': formatSignedUsd(performance.copierPnl),
    'Sharpe Ratio': formatRatio(performance.sharpRatio),
    MDD: formatPercent(performance.mdd),
    'Win Rate': formatPercent(performance.winRate),
    'Win Positions': String(performance.winOrders ?? 0),
    'Total Positions': String(performance.totalOrder ?? 0),
    AUM: formatUsd(detail.aumAmount),
    'Profit Sharing': formatPercent(detail.profitSharingRate),
    'Leading Margin Balance': formatUsd(detail.marginBalance),
    'Lock-up period': formatLockPeriod(detail.lockPeriod),
    'Minimum Copy Amount': formatMinimumCopyAmount(detail),
    'Days Trading': calculateDaysTrading(detail.startTime),
    Copiers: formatCopiers(detail),
    'Total Copiers': formatNumber(detail.totalCopyCount || 0, 0),
    'Mock Copiers': formatNumber(detail.mockCopyCount || 0, 0),
    'Closed Portfolios': formatNumber(detail.closeLeadCount || 0, 0),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { browser, channel } = await launchBrowser(options.channel, options.headless);
  console.log(`Using browser channel: ${channel}`);

  try {
    const page = await browser.newPage();
    await page.goto(BINANCE_COPY_TRADING_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForResponse(
        response => response.url().includes('/copy-trade/home-page/query-list') && response.status() === 200,
        { timeout: 120000 },
    );

    const topTraders = await fetchTopTraders(page, options.count, options.timeRange);
    console.log(`Fetched ${topTraders.length} ranked traders from Binance`);

    const traders = [];
    for (const [index, trader] of topTraders.entries()) {
      const rank = index + 1;
      const leadPortfolioId = trader.leadPortfolioId;
      console.log(`Fetching detail ${rank}/${topTraders.length}: ${String(trader.nickname || '').trim()} (${leadPortfolioId})`);
      const snapshot = await fetchTraderSnapshot(page, rank, leadPortfolioId, options.timeRange);
      traders.push(snapshot);
    }

    const output = {
      exchange: 'binance',
      generated_at: new Date().toISOString(),
      trader_count: traders.length,
      traders,
    };

    const outputPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');

    console.log(`Saved ${traders.length} traders to ${outputPath}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
