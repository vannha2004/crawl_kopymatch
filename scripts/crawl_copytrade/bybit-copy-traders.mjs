import process from 'node:process';

import {
  buildOutput,
  createRequestContext,
  fetchJsonWithRequest,
  formatMinutesAsDuration,
  formatNumber,
  formatPercentValue,
  formatSignedNumber,
  parseBasicArgs,
  printBasicHelp,
  urlEncode,
  writeJson,
} from '../copy-trading-utils.mjs';

const DEFAULT_OUTPUT = 'artifacts/bybit-copy-traders.json';
const BYBIT_HOME_URL = 'https://www.bybit.com/copyTrade/';
const BYBIT_LIST_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list';
const BYBIT_INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income';
const BYBIT_SHARE_TRADE_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/share-trade-data';
const BYBIT_DURATION = 'DATA_DURATION_NINETY_DAY';

function findDurationValue(source, baseKey) {
  if (!source || !baseKey)
    return undefined;

  const baseLower = baseKey.toLowerCase();
  const preferredPrefixes = ['ninetyday', '90day', 'day90', 'sevenday'];

  for (const prefix of preferredPrefixes) {
    const expected = `${prefix}${baseLower}`;
    const key = Object.keys(source).find(entry => entry.toLowerCase() === expected);
    if (key !== undefined)
      return source[key];
  }

  const fallbackKey = Object.keys(source).find(entry => entry.toLowerCase() === baseLower);
  return fallbackKey ? source[fallbackKey] : undefined;
}

function findValueByKeys(source, keys) {
  if (!source)
    return undefined;

  const lowerMap = Object.fromEntries(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const match = lowerMap[key.toLowerCase()];
    if (match !== undefined)
      return match;
  }
  return undefined;
}

function findDeepValue(obj, matchers = []) {
  if (!obj || typeof obj !== 'object')
    return undefined;

  const lowerEntries = Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]);

  for (const matcher of matchers) {
    const matcherLower = matcher.toLowerCase();
    for (const [key, value] of lowerEntries) {
      if (key.includes(matcherLower) && value !== null && value !== undefined && value !== '')
        return value;
    }
  }
  return undefined;
}

function formatBybitPercentFromE4(value, options = {}) {
  return formatPercentValue(Number(value || 0) / 100, options);
}

function formatBybitAmountFromE8(value, options = {}) {
  return formatSignedNumber(Number(value || 0) / 1e8, options);
}

function formatUnsignedAmountFromE8(value, options = {}) {
  return formatNumber(Number(value || 0) / 1e8, options);
}

function buildProfitLossRatio(income) {
  const wins = Number(income.sevenDayWinCount || 0);
  const losses = Number(income.sevenDayLossCount || 0);
  const average = formatUnsignedAmountFromE8(income.sevenDayAvgYieldLossE8);
  return `${average} : ${losses === 0 ? 0 : losses}`;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '')
    return 0;
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function formatBybitTimestamp(value) {
  if (!value)
    return null;

  const formatter = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return formatter.format(new Date(Number(value))).replace('T', ' ');
}

async function main() {
  const options = parseBasicArgs(process.argv.slice(2), DEFAULT_OUTPUT);
  if (options.help) {
    printBasicHelp('crawl_copytrade/bybit-copy-traders.mjs', DEFAULT_OUTPUT);
    return;
  }

  const context = await createRequestContext({
    accept: 'application/json, text/plain, */*',
    referer: BYBIT_HOME_URL,
    origin: 'https://www.bybit.com',
  });

  try {
    await context.get(BYBIT_HOME_URL, { failOnStatusCode: false });
    const listUrl = `${BYBIT_LIST_URL}?pageNo=1&pageSize=${options.count}&nickName=&dataDuration=${BYBIT_DURATION}&sortField=LEADER_SORT_FIELD_SORT_FOLLOWERS_YIELD&sortType=SORT_TYPE_DESC`;
    const listResponse = await fetchJsonWithRequest(context, 'GET', listUrl);
    const leaders = listResponse.result?.leaderDetails || [];
    console.log(`Fetched ${leaders.length} ranked traders from Bybit`);

    const traders = [];
    for (const [index, leader] of leaders.entries()) {
      const leaderMark = leader.leaderMark;
      console.log(`Fetching detail ${index + 1}/${leaders.length}: ${leader.nickName} (${leaderMark})`);
      let income = {};
      let shareTrade = {};

      try {
        const incomeResponse = await fetchJsonWithRequest(
          context,
          'GET',
          `${BYBIT_INCOME_URL}?leaderMark=${urlEncode(leaderMark)}&dataDuration=${BYBIT_DURATION}`,
        );
        income = incomeResponse.result || {};
      } catch (error) {
        console.log(`Income fallback for ${leaderMark}: ${error.message}`);
      }

      try {
        const shareTradeResponse = await fetchJsonWithRequest(
          context,
          'GET',
          `${BYBIT_SHARE_TRADE_URL}?leaderMark=${urlEncode(leaderMark)}`,
        );
        shareTrade = shareTradeResponse.result || {};
      } catch (error) {
        console.log(`Share trade fallback for ${leaderMark}: ${error.message}`);
      }
      const leaderDetail = shareTrade.leaderIncomeDetail || {};
      const tradingDays = findDurationValue(income, 'TradeDays')
        ?? findDurationValue(income, 'TransactionDays')
        ?? leader.tradeDays
        ?? leader.transactionDays
        ?? leaderDetail.tradeDays
        ?? leaderDetail.transactionDays
        ?? leaderDetail.transactionDay
        ?? findValueByKeys(leaderDetail, ['transactionDays', 'transactionDay', 'tradeDays'])
        ?? findDeepValue(income, ['tradedays', 'transactiondays'])
        ?? findDeepValue(leaderDetail, ['tradedays', 'transactiondays'])
        ?? findDeepValue(shareTrade, ['tradedays', 'transactiondays']);
      const tradingDaysNum = tradingDays ? toNumber(tradingDays) : null;
      const profitSharing = findDurationValue(income, 'ProfitShareRate')
        ?? findDurationValue(income, 'ProfitShareRatio')
        ?? leader.profitShareRate
        ?? leader.profitShareRatio
        ?? leaderDetail.profitShareRate
        ?? leaderDetail.profitShareRatio
        ?? findValueByKeys(leaderDetail, ['profitShareRate', 'profitShareRatio'])
        ?? findDeepValue(income, ['profitsharerate', 'profitshareratio', 'profitshare'])
        ?? findDeepValue(leaderDetail, ['profitsharerate', 'profitshareratio', 'profitshare'])
        ?? findDeepValue(shareTrade, ['profitsharerate', 'profitshareratio', 'profitshare']);
      const profitShareNumber = profitSharing === undefined ? undefined : toNumber(profitSharing);
      const profitSharePercent = profitShareNumber === undefined || profitShareNumber === 0
        ? null
        : profitShareNumber > 1
          ? profitShareNumber
          : profitShareNumber * 100;
      const roiE4 = findDurationValue(income, 'YieldRateE4');
      const masterProfitE8 = findDurationValue(income, 'ProfitE8');
      const followerProfitE8 = findDurationValue(income, 'FollowerYieldE8');
      const drawdownE4 = findDurationValue(income, 'DrawDownE4');
      const avgYieldLossE8 = findDurationValue(income, 'AvgYieldLossE8');
      const winRateE4 = findDurationValue(income, 'WinRateE4');
      const winCount = findDurationValue(income, 'WinCount');
      const lossCount = findDurationValue(income, 'LossCount');
      const positionMinutes = findDurationValue(income, 'AvePositionTime');
      const volatilityE4 = findDurationValue(income, 'ReturnVolatilityE4');
      const sharpeE4 = findDurationValue(income, 'SharpeRatioE4');
      const sortinoE4 = findDurationValue(income, 'SortinoRatioE4');
      const lastTradeTime = findDurationValue(income, 'LastTradeTime')
        ?? leaderDetail.lastTradeTime
        ?? findValueByKeys(leaderDetail, ['lastTradeTime', 'lastTrade', 'tradetime', 'updateTime'])
        ?? findDeepValue(income, ['lasttradetime', 'lasttrade', 'updatetime'])
        ?? findDeepValue(leaderDetail, ['lasttradetime', 'lasttrade', 'updatetime'])
        ?? findDeepValue(shareTrade, ['lasttradetime', 'lasttrade', 'updatetime']);

      traders.push({
        rank: index + 1,
        trader_name: leader.nickName,
        profile_url: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${urlEncode(leaderMark)}`,
        Followers: String(income.currentFollowerCount ?? leader.currentFollowerCount ?? 0),
        'Trading Day': tradingDaysNum ?? null,
        'Profit Sharing': profitSharePercent !== null ? `${formatNumber(profitSharePercent, { decimals: 0 })}%` : null,
        ROI: formatBybitPercentFromE4(roiE4, { signed: true }),
        'Master Profit and Loss': formatBybitAmountFromE8(masterProfitE8),
        'Win rate': formatBybitPercentFromE4(winRateE4),
        'Follower profit and loss': formatBybitAmountFromE8(followerProfitE8),
        'Maximum drawdown': formatBybitPercentFromE4(drawdownE4),
        'average profit/loss': formatBybitAmountFromE8(avgYieldLossE8),
        'profit and loss ratio': buildProfitLossRatio({
          sevenDayWinCount: winCount,
          sevenDayLossCount: lossCount,
          sevenDayAvgYieldLossE8: avgYieldLossE8,
        }),
        'Average position holding time': formatMinutesAsDuration(positionMinutes),
        'ROI fluctuation rate': formatBybitPercentFromE4(volatilityE4),
        'Sharpe ratio': formatNumber(Number(sharpeE4 || 0) / 10000),
        'Sortino Ratio': formatNumber(Number(sortinoE4 || 0) / 10000),
        'Last trading day': formatBybitTimestamp(lastTradeTime),
      });

      if (shareTrade.leaderIncomeDetail?.leaderUserName && shareTrade.leaderIncomeDetail.leaderUserName !== leader.nickName)
        traders[traders.length - 1].trader_name = shareTrade.leaderIncomeDetail.leaderUserName;
    }

    const outputPath = await writeJson(options.output, buildOutput('bybit', traders));
    console.log(`Saved ${traders.length} traders to ${outputPath}`);
  } finally {
    await context.dispose();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
