import process from 'node:process';

import {
  buildOutput,
  formatNumber,
  formatPercentValue,
  formatSignedNumber,
  formatTimestamp,
  launchBrowser,
  parseBasicArgs,
  printBasicHelp,
  toNumber,
  writeJson,
} from '../copy-trading-utils.mjs';

const DEFAULT_OUTPUT = 'artifacts/bitget-copy-traders.json';
const BITGET_URL = 'https://www.bitget.com/copy-trading/futures';
const DETAIL_ENDPOINT = '/v1/trigger/trace/public/traderDetailPageV2';
const CYCLE_ENDPOINT = '/v1/trigger/trace/public/cycleData';
const DETAIL_TIMEZONE = 'Asia/Saigon';
const BITGET_CYCLE_DAYS = 90;
const BITGET_FILTER_LABEL = '90D';

function findItemValue(itemVoList, code) {
  return itemVoList?.find(item => item.showColumnCode === code) || null;
}

function formatBitgetPercent(value, { signed = false } = {}) {
  return formatPercentValue(value, { signed, spaceBeforePercent: true });
}

function formatBitgetUsd(value, { signed = false } = {}) {
  const numericValue = toNumber(value);
  if (!signed)
    return `$${formatNumber(numericValue)}`;
  if (numericValue < 0)
    return `-$${formatNumber(Math.abs(numericValue))}`;
  return `$${formatNumber(numericValue)}`;
}

function formatBitgetCount(value) {
  return formatNumber(value, { decimals: 0 });
}

function buildFallbackTrader(rank, listItem) {
  const itemVoList = listItem.itemVoList || [];
  const getComparedValue = code => findItemValue(itemVoList, code)?.comparedValue;

  return {
    rank,
    name: listItem.displayName || listItem.traderNickName || listItem.userName || '',
    trader_url: `${BITGET_URL}-trader-v1/${listItem.traderUid}`,
    ROI: formatBitgetPercent(getComparedValue('profit_rate'), { signed: true }),
    'Total profit': formatBitgetUsd(getComparedValue('total_income'), { signed: true }),
    'Maximum drawdown': formatBitgetPercent(getComparedValue('max_retracement')),
    'Total copiers': null,
    "Copiers' PnL": formatBitgetUsd(getComparedValue('total_follow_profit'), { signed: true }),
    'Trading frequency': String(listItem.viewDataVO?.tradeFrequency || 0),
    'Win rate': formatBitgetPercent(getComparedValue('winning_rate')),
    'Profitable trades': null,
    'Losing trades': null,
    'Currently copying': `${listItem.followCount ?? 0}/${listItem.maxFollowCount ?? 0}`,
    AUM: formatBitgetUsd(getComparedValue('total_follow_trade_amount')),
    'Total assets': listItem.totalEquity ?? '****',
    'Last trade': null,
    'Profit share ratio': '0 %',
  };
}

function buildTraderFromDetail(rank, listItem, detail, cycleData) {
  const fallback = buildFallbackTrader(rank, listItem);
  const itemVoList = detail.itemVoList || [];
  const cycleColumns = cycleData?.pageScoreDTO?.pageColumnVOList || cycleData?.pageScoreDTO?.itemVoList || [];
  const traderStats = cycleData?.pageScoreDTO?.traderUserDetail || {};
  const detailValue = code => findItemValue(itemVoList, code)?.comparedValue;
  const cycleValue = code => findItemValue(cycleColumns, code)?.comparedValue;
  const fallbackItemValue = code => findItemValue(listItem.itemVoList || [], code)?.comparedValue;
  const roiValue = cycleValue('profit_rate') ?? cycleValue('yield') ?? cycleValue('profitRate') ?? cycleValue('profit_rate_pct') ?? cycleValue('profit_ratio')
    ?? detailValue('profit_rate') ?? detailValue('yield') ?? detailValue('profitRate') ?? detailValue('profit_rate_pct') ?? detailValue('profit_ratio');
  const maxDrawdownValue = cycleValue('max_retracement') ?? cycleValue('max_drawdown')
    ?? detailValue('max_retracement') ?? detailValue('max_drawdown');
  const winRateValue = cycleValue('total_winning_rate') ?? cycleValue('winning_rate')
    ?? detailValue('total_winning_rate') ?? detailValue('winning_rate');
  const totalProfitValue = cycleValue('income') ?? detailValue('income') ?? detail.totalIncome;

  return {
    rank,
    name: detail.displayName || fallback.name,
    trader_url: `${BITGET_URL}-trader-v1/${listItem.traderUid}`,
    ROI: roiValue !== undefined
      ? formatBitgetPercent(roiValue, { signed: true })
      : fallback.ROI,
    'Total profit': totalProfitValue !== undefined
      ? formatBitgetUsd(totalProfitValue, { signed: true })
      : fallback['Total profit'],
    'Maximum drawdown': maxDrawdownValue !== undefined
      ? formatBitgetPercent(maxDrawdownValue)
      : fallback['Maximum drawdown'],
    'Total copiers': String(findItemValue(itemVoList, 'total_followers')?.showColumnValue ?? detail.totalFollowers ?? 0),
    "Copiers' PnL": formatBitgetUsd(cycleValue('total_follow_profit') ?? fallbackItemValue('total_follow_profit'), { signed: true }),
    'Trading frequency': String(findItemValue(itemVoList, 'total_trade_frequency')?.showColumnValue ?? detail.tradeFrequency ?? 0),
    'Win rate': winRateValue !== undefined
      ? formatBitgetPercent(winRateValue)
      : fallback['Win rate'],
    'Profitable trades': String(traderStats.win ?? 0),
    'Losing trades': String(traderStats.loss ?? 0),
    'Currently copying': `${detail.followCount ?? listItem.followCount ?? 0}/${detail.maxFollowCount ?? listItem.maxFollowCount ?? 0}`,
    AUM: formatBitgetUsd(detail.aum ?? findItemValue(itemVoList, 'total_follow_trade_amount')?.comparedValue),
    'Total assets': detail.totalEquity ?? fallback['Total assets'],
    'Last trade': formatTimestamp(detail.lastActiveTime, { timeZone: DETAIL_TIMEZONE }) ?? '0',
    'Profit share ratio': `${formatNumber(detail.distributeRatio, { decimals: 0 })} %`,
  };
}

async function postJson(page, url, body) {
  return page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      text: await response.text(),
    };
  }, { url, body });
}

async function postJsonWithRetry(page, url, body, { retries = 4, delayMs = 1200 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await postJson(page, url, body);
    if (response.status === 429) {
      lastError = new Error(`Rate limited at ${url}`);
      await page.waitForTimeout(delayMs * (attempt + 1));
      continue;
    }

    if (!response.text)
      throw new Error(`Empty response from ${url}`);

    const payload = JSON.parse(response.text);
    if (payload.code === '00000' && payload.success !== false)
      return payload.data;

    const message = `${payload.code || 'unknown'} ${payload.msg || ''}`.trim();
    if (payload.msg && payload.msg.includes('not a futures elite trader'))
      return null;

    lastError = new Error(`Request failed for ${url}: ${message}`.trim());
    if (payload.code === '30082')
      return null;

    await page.waitForTimeout(delayMs * (attempt + 1));
  }

  throw lastError || new Error(`Request failed for ${url}`);
}

async function extractTopCards(page, count) {
  return page.evaluate(cardCount => {
    const cards = Array.from(document.querySelectorAll('div'))
        .filter(el => {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return text.includes('Total PnL') && text.includes('Copier profit') && text.includes('Win rate') && text.includes('Copy') && text.length < 250;
        })
        .slice(0, cardCount)
        .map(el => {
          const reactKey = Object.getOwnPropertyNames(el).find(key => key.startsWith('__reactProps'));
          return reactKey ? el[reactKey]?.children?.[0]?.props?.listItem ?? null : null;
        })
        .filter(Boolean);

    return cards;
  }, count);
}

async function apply90dFilter(page) {
  await page.evaluate(label => {
    const candidates = Array.from(document.querySelectorAll('button, div, span, a'))
      .filter(el => (el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase() === label);
    const target = candidates.find(el => !el.getAttribute('aria-disabled')) || candidates[0];
    target?.click();
  }, BITGET_FILTER_LABEL);
}

async function main() {
  const options = parseBasicArgs(process.argv.slice(2), DEFAULT_OUTPUT);
  if (options.help) {
    printBasicHelp('crawl_copytrade/bitget-copy-traders.mjs', DEFAULT_OUTPUT);
    return;
  }

  if (options.headless)
    console.log('Bitget trader list does not reliably render in headless mode; switching to headed browser.');

  const { browser, channel } = await launchBrowser(options.channel, false);
  console.log(`Using browser channel: ${channel}`);

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto(BITGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await apply90dFilter(page);
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('div')).filter(el => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return text.includes('Total PnL') && text.includes('Copier profit') && text.includes('Win rate') && text.includes('Copy') && text.length < 250;
      }).length >= 20;
    }, undefined, { timeout: 120000 });

    const cards = await extractTopCards(page, options.count);
    console.log(`Fetched ${cards.length} ranked traders from Bitget`);

    const traders = [];
    for (const [index, card] of cards.entries()) {
      console.log(`Fetching detail ${index + 1}/${cards.length}: ${card.displayName} (${card.traderUid})`);
      let detail = null;
      let cycleData = null;

      try {
        detail = await postJsonWithRetry(page, DETAIL_ENDPOINT, {
          traderUid: card.traderUid,
          cycleTime: BITGET_CYCLE_DAYS,
        });
        await page.waitForTimeout(700);
        cycleData = await postJsonWithRetry(page, CYCLE_ENDPOINT, {
          triggerUserId: card.traderUid,
          cycleTime: BITGET_CYCLE_DAYS,
        });
      } catch (error) {
        console.log(`Detail fallback for ${card.traderUid}: ${error.message}`);
      }

      const trader = detail
        ? buildTraderFromDetail(index + 1, card, detail, cycleData)
        : buildFallbackTrader(index + 1, card);
      traders.push(trader);

      await page.waitForTimeout(700);
    }

    const outputPath = await writeJson(options.output, buildOutput('bitget', traders));
    console.log(`Saved ${traders.length} traders to ${outputPath}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
