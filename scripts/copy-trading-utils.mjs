import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { chromium, request } from 'playwright';

export const DEFAULT_COUNT = 50;
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

export function parseBasicArgs(argv, defaultOutput) {
  const options = {
    count: DEFAULT_COUNT,
    output: defaultOutput,
    channel: null,
    headless: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count')
      options.count = Number(argv[++i]);
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

  return options;
}

export function printBasicHelp(scriptName, defaultOutput) {
  console.log(`Usage: node scripts/${scriptName} [options]

Options:
  --count <number>    Number of traders to crawl. Default: ${DEFAULT_COUNT}
  --output <path>     Output JSON path. Default: ${defaultOutput}
  --channel <name>    Browser channel, for example chrome or msedge
  --headed            Run with visible browser
  --help              Show this help
`);
}

export async function launchBrowser(channel, headless) {
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

export async function createRequestContext(extraHTTPHeaders = {}) {
  return request.newContext({
    extraHTTPHeaders: {
      'user-agent': DEFAULT_USER_AGENT,
      ...extraHTTPHeaders,
    },
  });
}

export async function fetchJsonWithPage(page, url, options = {}) {
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

  return parseJsonResponse(response, url);
}

export async function fetchJsonWithRequest(context, method, url, options = {}) {
  const normalizedMethod = method.toUpperCase();
  let response;
  if (normalizedMethod === 'POST')
    response = await context.post(url, { failOnStatusCode: false, ...options });
  else if (normalizedMethod === 'GET')
    response = await context.get(url, { failOnStatusCode: false, ...options });
  else
    response = await context.fetch(url, { method: normalizedMethod, failOnStatusCode: false, ...options });

  const raw = {
    ok: response.ok(),
    status: response.status(),
    text: await response.text(),
  };
  return parseJsonResponse(raw, url);
}

function parseJsonResponse(response, url) {
  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}`);
  }

  if (!response.ok)
    throw new Error(`Request failed for ${url}: HTTP ${response.status}`);

  if (
    payload.success === false ||
    (payload.retCode !== undefined && String(payload.retCode) !== '0') ||
    (payload.code !== undefined && !['0', '00000', '200'].includes(String(payload.code)))
  )
    throw new Error(`Request failed for ${url}: ${payload.code || payload.retCode || 'unknown'} ${payload.msg || payload.retMsg || payload.message || ''}`.trim());

  return payload;
}

export async function writeJson(outputPath, payload) {
  const resolvedPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, JSON.stringify(payload, null, 2), 'utf8');
  return resolvedPath;
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '')
    return 0;
  return Number(value);
}

export function formatNumber(value, { locale = 'en-US', decimals = 2 } = {}) {
  return toNumber(value).toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatSignedNumber(value, options = {}) {
  const numericValue = toNumber(value);
  const sign = numericValue > 0 ? '+' : numericValue < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(numericValue), options)}`;
}

export function formatPercentValue(value, {
  locale = 'en-US',
  decimals = 2,
  signed = false,
  spaceBeforePercent = false,
} = {}) {
  const numericValue = toNumber(value);
  const sign = signed && numericValue > 0 ? '+' : numericValue < 0 ? '-' : '';
  const spacer = spaceBeforePercent ? ' ' : '';
  return `${sign}${formatNumber(Math.abs(numericValue), { locale, decimals })}${spacer}%`;
}

export function formatPercentFromRatio(value, options = {}) {
  return formatPercentValue(toNumber(value) * 100, options);
}

export function formatTimestamp(timestamp, {
  timeZone = 'UTC',
} = {}) {
  if (!timestamp)
    return null;

  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(Number(timestamp))).map(part => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function ratioString(value, {
  locale = 'en-US',
  decimals = 2,
  suffix = '',
} = {}) {
  return `${formatNumber(value, { locale, decimals })}${suffix}`;
}

export function buildOutput(exchange, traders) {
  return {
    exchange,
    generated_at: new Date().toISOString(),
    trader_count: traders.length,
    traders,
  };
}

export function nowMs() {
  return Date.now();
}

export function daysSince(timestamp) {
  if (!timestamp)
    return '0';
  return String(Math.max(0, Math.floor((nowMs() - Number(timestamp)) / 86400000)));
}

export function formatMinutesAsDuration(minutes) {
  const totalMinutes = Math.max(0, toNumber(minutes));
  if (totalMinutes >= 1440)
    return `${formatNumber(totalMinutes / 1440, { decimals: 2 })}Days`;
  if (totalMinutes >= 60)
    return `${formatNumber(totalMinutes / 60, { decimals: 2 })}Hours`;
  return `${formatNumber(totalMinutes, { decimals: 2 })}Minutes`;
}

export function urlEncode(value) {
  return encodeURIComponent(String(value));
}

export function rootUrl(pathname) {
  return new URL(pathname, process.cwd()).pathname;
}
