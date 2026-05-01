/**
 * Unit tests for PropFirm Crawler utilities
 * Run: node scripts/crawl_propfirm/test-utils.mjs
 */
import {
  parseMoney, parsePercentage, parseYears, parseCount, parseRating,
  toSlug, extractSlugFromUrl, computeDataConfidence, validateFirm, validateOutput,
} from './utils.mjs';

let passed = 0;
let failed = 0;

function assert(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${desc}`); }
  else { failed++; console.error(`  ✗ ${desc}\n    Expected: ${JSON.stringify(expected)}\n    Actual:   ${JSON.stringify(actual)}`); }
}

console.log('\n── parseMoney ──');
assert('$400,000', parseMoney('$400,000'), 400000);
assert('$100K', parseMoney('$100K'), 100000);
assert('$1.5M', parseMoney('$1.5M'), 1500000);
assert('$597.5K', parseMoney('$597.5K'), 597500);
assert('400000', parseMoney('400000'), 400000);
assert('$330K', parseMoney('$330K'), 330000);
assert('null', parseMoney(null), null);
assert('empty string', parseMoney(''), null);
assert('number passthrough', parseMoney(250000), 250000);
assert('$2B', parseMoney('$2B'), 2000000000);

console.log('\n── parsePercentage ──');
assert('80%', parsePercentage('80%'), 80);
assert('Up to 90%', parsePercentage('Up to 90%'), 90);
assert('80', parsePercentage('80'), 80);
assert('null', parsePercentage(null), null);
assert('12.5%', parsePercentage('12.5%'), 12.5);
assert('number passthrough', parsePercentage(75), 75);

console.log('\n── parseYears ──');
assert('10', parseYears('10'), 10);
assert('10+', parseYears('10+'), 10);
assert('3 years', parseYears('3 years'), 3);
assert('Less than 1', parseYears('Less than 1'), 0.5);
assert('Less than 2', parseYears('Less than 2'), 1.5);
assert('null', parseYears(null), null);
assert('number passthrough', parseYears(5), 5);

console.log('\n── parseCount ──');
assert('1,155', parseCount('1,155'), 1155);
assert('1155', parseCount('1155'), 1155);
assert('1155 reviews', parseCount('1155 reviews'), 1155);
assert('null', parseCount(null), null);

console.log('\n── toSlug ──');
assert('The5ers', toSlug('The5ers'), 'the5ers');
assert('E8 Markets', toSlug('E8 Markets'), 'e8-markets');
assert("Firm's Name", toSlug("Firm's Name"), 'firms-name');

console.log('\n── extractSlugFromUrl ──');
assert('the-5-ers', extractSlugFromUrl('https://propfirmmatch.com/prop-firms/the-5-ers'), 'the-5-ers');
assert('e8-markets', extractSlugFromUrl('https://propfirmmatch.com/prop-firms/e8-markets'), 'e8-markets');

console.log('\n── computeDataConfidence ──');
const fullFirm = {
  country: 'US',
  list_metrics: { years_in_operation: 5, star_point: 4.5, review_count: 100, payout_proof_status: 'available', platforms: ['MT5'], country: 'US', max_allocation: 100000, profit_split: 80, assets: ['FX'] },
  profile_detail: {
    overview_text: 'test overview',
    challenges: [{ challenge_name: 'test' }],
    offer: { offer_text: 'test' },
    payout: { payout_frequency: 'weekly' },
    rules: { raw_rules_text: 'test' },
  },
};
const fullResult = computeDataConfidence(fullFirm);
assert('full firm confidence = 1', fullResult.data_confidence, 1);
assert('full firm no missing', fullResult.missing_fields.length, 0);

const emptyFirm = { list_metrics: {}, profile_detail: {} };
const emptyResult = computeDataConfidence(emptyFirm);
assert('empty firm confidence low', emptyResult.data_confidence <= 0.1, true);
assert('empty firm many missing', emptyResult.missing_fields.length > 5, true);

console.log('\n── validateFirm ──');
assert('valid firm', validateFirm({ firm_name: 'Test', profile_url: 'http://test.com' }).length, 0);
assert('missing name', validateFirm({ profile_url: 'http://test.com' }).length > 0, true);
assert('missing url', validateFirm({ firm_name: 'Test' }).length > 0, true);

console.log('\n── validateOutput ──');
const validOutput = { source: 'test', crawl_type: 'test', crawl_started_at: 'x', crawl_finished_at: 'x', firms: [] };
assert('valid output', validateOutput(validOutput).length, 0);
assert('missing source', validateOutput({}).length > 0, true);

console.log(`\n════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
