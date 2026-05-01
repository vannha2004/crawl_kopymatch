import process from 'node:process';

import {
  buildOutput,
  createRequestContext,
  formatNumber,
  formatPercentFromRatio,
  parseBasicArgs,
  printBasicHelp,
  ratioString,
  writeJson,
  fetchJsonWithRequest,
} from '../copy-trading-utils.mjs';

const DEFAULT_OUTPUT = 'artifacts/okx-copy-traders.json';
const OKX_LIST_URL = 'https://www.okx.com/priapi/v5/ecotrade/public/follow-rank';
const OKX_DETAIL_URL = 'https://www.okx.com/priapi/v5/ecotrade/public/trader/trade-data';
const OKX_PAGE_SIZE = 20;
const DETAIL_REQUEST_DELAY_MS = 300;
const RETRYABLE_STATUS_CODES = ['HTTP 429', 'HTTP 500', 'HTTP 502', 'HTTP 503', 'HTTP 504'];

function getPartMap(parts = []) {
  return new Map(parts.map(item => [item.functionId, item.value]));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  return RETRYABLE_STATUS_CODES.some(code => error.message.includes(code));
}

async function fetchJsonWithRetry(context, method, url, {
  retries = 4,
  retryDelayMs = 1500,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJsonWithRequest(context, method, url);
    } catch (error) {
      if (attempt >= retries || !isRetryableError(error))
        throw error;
      const delayMs = retryDelayMs * (attempt + 1);
      console.warn(`Retrying after ${delayMs}ms due to ${error.message}`);
      await sleep(delayMs);
    }
  }
}

async function fetchRankPage(context, page, size) {
  const params = new URLSearchParams({
    size: String(size),
    type: '',
    start: String(page),
    latestNum: '90',
    fullState: '2',
    apiTrader: '0',
    instNumLimit: '4',
    t: String(Date.now()),
  });
  return fetchJsonWithRetry(context, 'GET', `${OKX_LIST_URL}?${params.toString()}`);
}

async function main() {
  const options = parseBasicArgs(process.argv.slice(2), DEFAULT_OUTPUT);
  if (options.help) {
    printBasicHelp('crawl_copytrade/okx-copy-traders.mjs', DEFAULT_OUTPUT);
    return;
  }

  const context = await createRequestContext();
  try {
    const ranks = [];
    let currentPage = 1;
    let totalPages = 1;
    const pageSize = Math.min(options.count, OKX_PAGE_SIZE);

    while (ranks.length < options.count && currentPage <= totalPages) {
      const listResponse = await fetchRankPage(context, currentPage, pageSize);
      const pageData = listResponse.data?.[0] || {};
      const pageRanks = pageData.ranks || [];
      totalPages = Number(pageData.pages || totalPages);
      ranks.push(...pageRanks);
      currentPage += 1;
      if (pageRanks.length === 0)
        break;
    }

    const limitedRanks = ranks.slice(0, options.count);
    console.log(`Fetched ${limitedRanks.length} ranked traders from OKX`);

    const traders = [];
    for (const [index, rank] of limitedRanks.entries()) {
      const uniqueName = rank.uniqueName;
      console.log(`Fetching detail ${index + 1}/${limitedRanks.length}: ${rank.nickName} (${uniqueName})`);
      const detailParams = new URLSearchParams({
        latestNum: '0',
        bizType: 'SWAP',
        uniqueName,
        t: String(Date.now()),
      });
      const detailUrl = `${OKX_DETAIL_URL}?${detailParams.toString()}`;
      const detailResponse = await fetchJsonWithRetry(context, 'GET', detailUrl);
      const detail = detailResponse.data?.[0] || {};
      const nonPeriodic = getPartMap(detail.nonPeriodicPart);
      const periodic = getPartMap(detail.periodicPart);

      traders.push({
        rank: index + 1,
        trader_name: rank.nickName,
        profile_url: `https://www.okx.com/copy-trading/account/${uniqueName}?tab=swap`,
        Followers: String(rank.historyFollowerNum ?? 0),
        'Win rate': formatPercentFromRatio(periodic.get('winRatio')),
        'Profit/Loss Ratio': periodic.get('pnlProfitLossRatio') || null,
        'Average position value': formatNumber(periodic.get('avgPositionValue')),
        'Number of main trading days': String(nonPeriodic.get('initialDay') ?? rank.initialDay ?? 0),
        'Primary trading asset (USDT)': formatNumber(nonPeriodic.get('asset')),
        AUM: formatNumber(nonPeriodic.get('aum')),
        'Current PNL of the copy trading platform (USDT)': formatNumber(nonPeriodic.get('currentFollowPnl')),
        'Copy trading': nonPeriodic.get('followerNum') || `${rank.followerNum ?? 0}/${rank.followerLimit ?? 0}`,
        'Profit sharing ratio': formatPercentFromRatio(nonPeriodic.get('profitShareRatio'), { decimals: 0 }),
        'Total accumulated': null,
      });

      if (index + 1 < limitedRanks.length)
        await sleep(DETAIL_REQUEST_DELAY_MS);
    }

    const outputPath = await writeJson(options.output, buildOutput('okx', traders));
    console.log(`Saved ${traders.length} traders to ${outputPath}`);
  } finally {
    await context.dispose();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
