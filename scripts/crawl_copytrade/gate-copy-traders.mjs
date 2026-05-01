import process from 'node:process';

import {
  buildOutput,
  fetchJsonWithPage,
  formatNumber,
  formatPercentFromRatio,
  formatSignedNumber,
  launchBrowser,
  parseBasicArgs,
  printBasicHelp,
  ratioString,
  writeJson,
} from '../copy-trading-utils.mjs';

const DEFAULT_OUTPUT = 'artifacts/gate-copy-traders.json';
const GATE_COPY_TRADING_URL = 'https://www.gate.com/vi/copytrading';
const LOCALE = 'vi-VN';

function formatGateNumber(value, decimals = 2) {
  return formatNumber(value, { locale: LOCALE, decimals });
}

function formatGateSigned(value, decimals = 2) {
  return formatSignedNumber(value, { locale: LOCALE, decimals });
}

async function main() {
  const options = parseBasicArgs(process.argv.slice(2), DEFAULT_OUTPUT);
  if (options.help) {
    printBasicHelp('crawl_copytrade/gate-copy-traders.mjs', DEFAULT_OUTPUT);
    return;
  }

  const { browser, channel } = await launchBrowser(options.channel, options.headless);
  console.log(`Using browser channel: ${channel}`);

  try {
    const page = await browser.newPage();
    await page.goto(GATE_COPY_TRADING_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForResponse(response => response.url().includes('/apiw/v2/copy/leader/list') && response.status() === 200, { timeout: 120000 });

    const listUrl = `/apiw/v2/copy/leader/list?page=1&page_size=${options.count}&trader_name=&private_type=0&is_curated=0&status=running&label_ids=&order_by=follow_profit&sort_by=desc&cycle=month`;
    const listResponse = await fetchJsonWithPage(page, listUrl);
    const leaders = listResponse.data?.list || [];
    console.log(`Fetched ${leaders.length} ranked traders from Gate`);

    const traders = [];
    for (const [index, leader] of leaders.entries()) {
      const leaderId = leader.leader_id;
      console.log(`Fetching detail ${index + 1}/${leaders.length}: ${leader.user_info?.nickname || leader.user_info?.nick} (${leaderId})`);
      const detailResponse = await fetchJsonWithPage(page, `/api/copytrade/copy_trading/trader/detail/${leaderId}?leaderId=${leaderId}`);
      const detail = detailResponse.data || {};
      const profit = detail.profit || {};
      const config = detail.config || {};
      const userInfo = config.user_info || {};

      traders.push({
        rank: index + 1,
        name: userInfo.nickname || userInfo.nick_en || userInfo.nick || leader.user_info?.nickname || leader.user_info?.nick || '',
        trader_url: `https://www.gate.com/vi/copytrading/trader/futures/${leaderId}`,
        Copyist: `${profit.curr_follow_num ?? leader.curr_follow_num ?? 0}/${profit.max_follow_num ?? leader.max_follow_num ?? 0}`,
        'Date of participation': String(profit.duration_day ?? leader.leading_days ?? 0),
        'Profit sharing': formatPercentFromRatio(config.follow_fee_rate, { locale: LOCALE, decimals: 0 }),
        'Simple Profit': formatPercentFromRatio(profit.simple_profit_rate, { locale: LOCALE, signed: true }),
        PnL: formatGateSigned(profit.profit),
        'Win rate': formatPercentFromRatio(profit.month_win_rate ?? profit.win_rate, { locale: LOCALE }),
        "Trader's assets": formatGateNumber(profit.total_invest),
        'New copyist': formatGateSigned(profit.incremental_num, 0),
        "Copyer's PnL": formatGateSigned(profit.follow_profit),
        'Sharpe Ratio': Number(profit.sharp_ratio || 0) === 0 ? '--' : ratioString(profit.sharp_ratio, { locale: LOCALE }),
        AUM: formatGateNumber(profit.aum),
        MDD: formatPercentFromRatio(profit.max_drawdown, { locale: LOCALE }),
        'Profit/Loss Ratio': `${formatGateNumber(profit.pl_ratio)}:1`,
        'Cumulative number of copyists': String(profit.total_follow_num ?? leader.total_follow_num ?? 0),
      });
    }

    const outputPath = await writeJson(options.output, buildOutput('gate', traders));
    console.log(`Saved ${traders.length} traders to ${outputPath}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
