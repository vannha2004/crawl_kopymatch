import process from 'node:process';

import {
  buildOutput,
  createRequestContext,
  fetchJsonWithRequest,
  formatNumber,
  formatPercentFromRatio,
  formatSignedNumber,
  parseBasicArgs,
  printBasicHelp,
  writeJson,
} from '../copy-trading-utils.mjs';

const DEFAULT_OUTPUT = 'artifacts/kucoin-copy-traders.json';
const LOCALE = 'vi-VN';
const LIST_URL = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=vi_VN';
const SUMMARY_URL = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/summary?lang=vi_VN';
const OVERVIEW_URL = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/overview?lang=vi_VN';

function formatKucoinNumber(value) {
  return formatNumber(value, { locale: LOCALE });
}

function formatKucoinSigned(value) {
  return formatSignedNumber(value, { locale: LOCALE });
}

async function main() {
  const options = parseBasicArgs(process.argv.slice(2), DEFAULT_OUTPUT);
  if (options.help) {
    printBasicHelp('crawl_copytrade/kucoin-copy-traders.mjs', DEFAULT_OUTPUT);
    return;
  }

  const context = await createRequestContext({
    accept: 'application/json',
    'content-type': 'application/json',
    referer: 'https://www.kucoin.com/vi/copytrading',
    'x-request-with': 'null',
    'x-site': 'global',
  });

  try {
    const listResponse = await fetchJsonWithRequest(context, 'POST', LIST_URL, {
      data: {
        criteria: [],
        sort: {
          field: 'ranking_score',
          direction: 'DESC',
        },
        hideFull: false,
        currentPage: 1,
        pageSize: options.count,
      },
    });

    const leaders = listResponse.data?.items || [];
    console.log(`Fetched ${leaders.length} ranked traders from KuCoin`);

    const traders = [];
    for (const [index, leader] of leaders.entries()) {
      const leadConfigId = leader.leadConfigId;
      console.log(`Fetching detail ${index + 1}/${leaders.length}: ${leader.nickName} (${leadConfigId})`);
      const [summaryResponse, overviewResponse] = await Promise.all([
        fetchJsonWithRequest(context, 'GET', `${SUMMARY_URL}&leadConfigId=${leadConfigId}`),
        fetchJsonWithRequest(context, 'GET', `${OVERVIEW_URL}&leadConfigId=${leadConfigId}`),
      ]);

      const summary = summaryResponse.data || {};
      const overview = overviewResponse.data || {};
      traders.push({
        rank: index + 1,
        name: leader.nickName,
        trader_url: `https://www.kucoin.com/vi/copytrading/trader-profile/${leadConfigId}`,
        Followers: String(summary.followersSum ?? 0),
        'Copy trader': String(leader.currentCopyUserCount ?? 0),
        'Leading Transaction Funds (USDT)': formatKucoinNumber(overview.leadPrincipal ?? leader.leadPrincipal),
        'Leading size (USDT)': formatKucoinNumber(leader.leadAmount),
        "Copy Trader's PNL (USDT)": formatKucoinSigned(leader.followerPnl ?? overview.copyTradingPnl),
        'Profit sharing ratio': formatPercentFromRatio(overview.profitSharingRatio, { locale: LOCALE, decimals: 0 }),
      });
    }

    const outputPath = await writeJson(options.output, buildOutput('kucoin', traders));
    console.log(`Saved ${traders.length} traders to ${outputPath}`);
  } finally {
    await context.dispose();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
