/**
 * PropFirm Crawler - Search Provider Interface & Mock
 *
 * Provides a pluggable interface for risk evidence search.
 * The mock implementation returns empty results.
 * Replace with Google Search API, Gemini Search Grounding, or SerpAPI later.
 */

// ─── Search Query Templates ─────────────────────────────────────────────────────

/**
 * Generate search queries for a firm's risk evidence.
 * @param {string} firmName
 * @returns {Array<{query: string, incident_type: string}>}
 */
export function buildRiskSearchQueries(firmName) {
  return [
    { query: `${firmName} payout denied`, incident_type: 'payout_denied' },
    { query: `${firmName} payout proof`, incident_type: 'review_complaint' },
    { query: `${firmName} scam`, incident_type: 'scam_accusation' },
    { query: `${firmName} review`, incident_type: 'review_complaint' },
    { query: `${firmName} Trustpilot`, incident_type: 'review_complaint' },
    { query: `${firmName} hidden rules`, incident_type: 'hidden_rule' },
    { query: `${firmName} withdrawal problem`, incident_type: 'delayed_payout' },
    { query: `${firmName} account banned`, incident_type: 'account_ban' },
  ];
}

// ─── SearchProvider Interface ───────────────────────────────────────────────────

/**
 * @typedef {Object} SearchResult
 * @property {string} title
 * @property {string} source_url
 * @property {string|null} source_domain
 * @property {string|null} snippet
 * @property {string|null} published_date
 * @property {string} incident_type
 * @property {string} severity - 'low' | 'medium' | 'high' | 'critical' | 'unknown'
 * @property {number} confidence - 0 to 1
 */

/**
 * @typedef {Object} SearchProvider
 * @property {string} name
 * @property {function(string): Promise<SearchResult[]>} search
 */

// ─── Mock Search Provider ───────────────────────────────────────────────────────

/**
 * Mock search provider that returns empty results.
 * Replace this with a real implementation using Google Custom Search API,
 * Gemini Search Grounding, or SerpAPI.
 *
 * Example real implementation:
 * ```
 * export class GoogleSearchProvider {
 *   constructor(apiKey, cseId) { ... }
 *   async search(query) {
 *     const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${cseId}`;
 *     const res = await fetch(url);
 *     const data = await res.json();
 *     return data.items.map(item => ({
 *       title: item.title,
 *       source_url: item.link,
 *       source_domain: new URL(item.link).hostname,
 *       snippet: item.snippet,
 *       published_date: null,
 *       incident_type: 'unknown',
 *       severity: 'unknown',
 *       confidence: 0.5,
 *     }));
 *   }
 * }
 * ```
 */
export class MockSearchProvider {
  constructor() {
    this.name = 'mock';
  }

  /**
   * @param {string} _query
   * @returns {Promise<SearchResult[]>}
   */
  async search(_query) {
    return [];
  }
}

// ─── Risk Evidence Collector ────────────────────────────────────────────────────

/**
 * Collect risk evidence for a firm using a search provider.
 * @param {string} firmName
 * @param {SearchProvider} provider
 * @returns {Promise<SearchResult[]>}
 */
export async function collectRiskEvidence(firmName, provider) {
  const queries = buildRiskSearchQueries(firmName);
  const allResults = [];

  for (const { query, incident_type } of queries) {
    try {
      const results = await provider.search(query);
      for (const result of results) {
        allResults.push({
          ...result,
          incident_type: result.incident_type || incident_type,
          severity: result.severity || 'unknown',
          confidence: result.confidence ?? 0.5,
        });
      }
    } catch (error) {
      console.warn(`  ⚠ Search failed for "${query}": ${error.message}`);
    }
  }

  // Deduplicate by source_url
  const seen = new Set();
  return allResults.filter(r => {
    if (seen.has(r.source_url)) return false;
    seen.add(r.source_url);
    return true;
  });
}
