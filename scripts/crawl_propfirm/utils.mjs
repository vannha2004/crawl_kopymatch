/**
 * PropFirm Crawler - Utility Functions
 * Parsing, normalization, data quality, and schema validation helpers.
 */

// ─── Money Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a money string into a numeric value (USD).
 * Handles formats like "$400,000", "$100K", "$1.5M", "400000", "$597.5K", etc.
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;

  const str = String(raw).trim();
  if (!str) return null;

  // Remove currency symbols and whitespace
  let cleaned = str.replace(/[€£¥₹]/g, '').replace(/\$/g, '').trim();

  // Handle K/M/B suffixes
  const multiplierMatch = cleaned.match(/^([0-9.,]+)\s*([KkMmBb])$/);
  if (multiplierMatch) {
    const num = parseFloat(multiplierMatch[1].replace(/,/g, ''));
    if (isNaN(num)) return null;
    const suffix = multiplierMatch[2].toUpperCase();
    const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
    return num * (multipliers[suffix] || 1);
  }

  // Remove commas and parse as float
  cleaned = cleaned.replace(/,/g, '');
  const result = parseFloat(cleaned);
  return isNaN(result) ? null : result;
}

// ─── Percentage Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a percentage string into a number.
 * "80%" -> 80, "Up to 90%" -> 90, "80" -> 80
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function parsePercentage(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;

  const str = String(raw).trim();
  if (!str) return null;

  // Extract percentage from text like "Up to 90%" or "80%"
  const match = str.match(/([\d.]+)\s*%/);
  if (match) return parseFloat(match[1]);

  // Try plain number
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

// ─── Years Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse years in operation from various formats.
 * "10" -> 10, "10+" -> 10, "3 years" -> 3, "Less than 1" -> 0.5
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function parseYears(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;

  const str = String(raw).trim().toLowerCase();
  if (!str) return null;

  if (str.includes('less than')) {
    const match = str.match(/less\s+than\s+([\d.]+)/);
    if (match) return Math.max(0, parseFloat(match[1]) - 0.5);
    return 0.5;
  }

  // Extract number, ignoring trailing + or "years"
  const match = str.match(/([\d.]+)/);
  if (match) return parseFloat(match[1]);

  return null;
}

// ─── Number Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse review count or generic integer.
 * "1,155" -> 1155, "1155" -> 1155, "1155 reviews" -> 1155
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function parseCount(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;

  const str = String(raw).trim();
  if (!str) return null;

  const match = str.replace(/,/g, '').match(/([\d]+)/);
  if (match) return parseInt(match[1], 10);

  return null;
}

/**
 * Parse star rating like "4.8" -> 4.8
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function parseRating(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;

  const str = String(raw).trim();
  if (!str) return null;

  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

// ─── Slug Generation ────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a firm name.
 * @param {string} name
 * @returns {string}
 */
export function toSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract slug from a PropFirmMatch profile URL.
 * "https://propfirmmatch.com/prop-firms/the-5-ers" -> "the-5-ers"
 * @param {string} url
 * @returns {string}
 */
export function extractSlugFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

// ─── Data Quality ───────────────────────────────────────────────────────────────

/** Important fields and their penalty weights for data confidence */
const IMPORTANT_FIELDS = [
  { path: 'list_metrics.years_in_operation', weight: 0.05 },
  { path: 'list_metrics.star_point', weight: 0.08 },
  { path: 'list_metrics.review_count', weight: 0.05 },
  { path: 'list_metrics.payout_proof_status', weight: 0.05 },
  { path: 'list_metrics.platforms', weight: 0.04, isArray: true },
  { path: 'country', weight: 0.04 },
  { path: 'list_metrics.max_allocation', weight: 0.05 },
  { path: 'list_metrics.profit_split', weight: 0.05 },
  { path: 'list_metrics.assets', weight: 0.04, isArray: true },
  { path: 'profile_detail.overview_text', weight: 0.1 },
  { path: 'profile_detail.challenges', weight: 0.15, isArray: true },
  { path: 'profile_detail.offer', weight: 0.05, isObject: true },
  { path: 'profile_detail.payout', weight: 0.1, isObject: true },
  { path: 'profile_detail.rules', weight: 0.1, isObject: true },
];

/**
 * Get a nested value from an object by dot-path.
 * @param {object} obj
 * @param {string} path
 * @returns {*}
 */
function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

/**
 * Compute data confidence for a firm object.
 * Starts at 1.0 and subtracts penalties for missing important fields.
 * @param {object} firm
 * @returns {{ data_confidence: number, missing_fields: string[], warnings: string[] }}
 */
export function computeDataConfidence(firm) {
  let score = 1.0;
  const missing_fields = [];
  const warnings = [];

  for (const field of IMPORTANT_FIELDS) {
    const value = getByPath(firm, field.path);

    if (field.isArray) {
      if (!Array.isArray(value) || value.length === 0) {
        score -= field.weight;
        missing_fields.push(field.path);
      }
    } else if (field.isObject) {
      if (!value || typeof value !== 'object') {
        score -= field.weight;
        missing_fields.push(field.path);
      } else {
        // Check if all values in the object are null
        const allNull = Object.values(value).every(v =>
          v === null || v === undefined || (Array.isArray(v) && v.length === 0)
        );
        if (allNull) {
          score -= field.weight * 0.5;
          warnings.push(`${field.path}: all sub-fields are null`);
        }
      }
    } else {
      if (value === null || value === undefined || value === '') {
        score -= field.weight;
        missing_fields.push(field.path);
      }
    }
  }

  return {
    data_confidence: Math.max(0, Math.round(score * 100) / 100),
    missing_fields,
    warnings,
  };
}

// ─── Schema Validation ──────────────────────────────────────────────────────────

/**
 * Validate a firm object against the expected schema.
 * Returns an array of error messages (empty if valid).
 * @param {object} firm
 * @returns {string[]}
 */
export function validateFirm(firm) {
  const errors = [];

  if (!firm.firm_name) errors.push('Missing firm_name');
  if (!firm.profile_url) errors.push('Missing profile_url');

  if (firm.list_metrics) {
    if (firm.list_metrics.platforms && !Array.isArray(firm.list_metrics.platforms))
      errors.push('list_metrics.platforms must be an array');
    if (firm.list_metrics.assets && !Array.isArray(firm.list_metrics.assets))
      errors.push('list_metrics.assets must be an array');
  }

  if (firm.profile_detail) {
    if (firm.profile_detail.challenges && !Array.isArray(firm.profile_detail.challenges))
      errors.push('profile_detail.challenges must be an array');

    if (firm.profile_detail.rules) {
      if (firm.profile_detail.rules.hidden_rule_flags &&
          !Array.isArray(firm.profile_detail.rules.hidden_rule_flags))
        errors.push('profile_detail.rules.hidden_rule_flags must be an array');
    }

    if (firm.profile_detail.payout) {
      if (firm.profile_detail.payout.payout_methods &&
          !Array.isArray(firm.profile_detail.payout.payout_methods))
        errors.push('profile_detail.payout.payout_methods must be an array');
    }
  }

  if (firm.risk_evidence && !Array.isArray(firm.risk_evidence))
    errors.push('risk_evidence must be an array');

  return errors;
}

/**
 * Validate the entire output object.
 * @param {object} output
 * @returns {string[]}
 */
export function validateOutput(output) {
  const errors = [];

  if (!output.source) errors.push('Missing source');
  if (!output.crawl_type) errors.push('Missing crawl_type');
  if (!output.crawl_started_at) errors.push('Missing crawl_started_at');
  if (!output.crawl_finished_at) errors.push('Missing crawl_finished_at');
  if (!Array.isArray(output.firms)) errors.push('firms must be an array');

  if (output.firms) {
    for (let i = 0; i < output.firms.length; i++) {
      const firmErrors = validateFirm(output.firms[i]);
      for (const err of firmErrors) {
        errors.push(`firms[${i}] (${output.firms[i].firm_name || 'unknown'}): ${err}`);
      }
    }
  }

  return errors;
}

// ─── Delay Helper ───────────────────────────────────────────────────────────────

/**
 * Wait for a random duration within a range.
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
export function randomDelay(minMs = 1000, maxMs = 3000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Text Extraction Helpers ────────────────────────────────────────────────────

/**
 * Clean up extracted text (trim, collapse whitespace).
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function cleanText(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/**
 * Parse boolean-like strings.
 * @param {string|null|undefined} text
 * @returns {boolean|null}
 */
export function parseBoolean(text) {
  if (text === null || text === undefined) return null;
  const str = String(text).trim().toLowerCase();
  if (['yes', 'allowed', 'true', '✓', '✔', 'permitted'].includes(str)) return true;
  if (['no', 'not allowed', 'false', '✗', '✘', '✕', 'prohibited', 'forbidden', 'restricted'].includes(str)) return false;
  return null;
}
