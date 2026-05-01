/**
 * PropFirm Leaderboard Crawler - Profile Detail Scraper
 *
 * Navigates to each firm's profile page and extracts detailed information
 * including overview, challenges, offers, payout policy, and rules.
 */

import {
  parseMoney,
  parsePercentage,
  parseBoolean,
  cleanText,
  randomDelay,
  parseCount,
} from './utils.mjs';

// ─── Helper: safe evaluate ──────────────────────────────────────────────────────

/**
 * Safely run page.evaluate and return null on error.
 */
async function safeEval(page, fn, fallback = null) {
  try {
    return await page.evaluate(fn);
  } catch {
    return fallback;
  }
}

// ─── Overview Section ───────────────────────────────────────────────────────────

async function scrapeOverview(page) {
  try {
    // Try clicking "Overview" tab or "Firm Overview" sidebar link
    const overviewClickable = page.locator('text=Overview').first();
    if (await overviewClickable.isVisible({ timeout: 2000 }).catch(() => false)) {
      await overviewClickable.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    // Look for the overview/firm-overview section content
    const overviewText = await safeEval(page, () => {
      // Try multiple selectors for overview content
      const selectors = [
        '[class*="overview"]',
        '[class*="Overview"]',
        '#firm-overview',
        'section:has(h2:is(:has-text("Overview"), :has-text("About")))',
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 50) {
          return el.textContent.trim();
        }
      }

      // Fallback: get main content area text (first large text block after header)
      const mainContent = document.querySelector('main') || document.querySelector('[class*="content"]');
      if (mainContent) {
        const paragraphs = mainContent.querySelectorAll('p');
        const texts = [];
        for (const p of paragraphs) {
          const text = p.textContent.trim();
          if (text.length > 30) texts.push(text);
          if (texts.length >= 5) break;
        }
        if (texts.length > 0) return texts.join('\n');
      }

      return null;
    });

    return cleanText(overviewText);
  } catch {
    return null;
  }
}

// ─── Challenges Section ─────────────────────────────────────────────────────────

async function scrapeChallenges(page) {
  try {
    // Click on the "Challenges" tab/section
    const challengesTab = page.locator('button:has-text("Challenges"), a:has-text("Challenges")').first();
    if (await challengesTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await challengesTab.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Also try sidebar link
    const sidebarLink = page.locator('a:has-text("Challenges")').first();
    if (await sidebarLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      await sidebarLink.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    const challenges = await safeEval(page, () => {
      const results = [];

      // Look for challenge cards/blocks
      // Pattern observed: cards with challenge name, price, original price
      const headingEl = Array.from(document.querySelectorAll('h2, h3')).find(
        h => h.textContent.trim().toLowerCase() === 'challenges'
      );

      if (!headingEl) return results;

      // Get the container after the heading
      let container = headingEl.nextElementSibling;
      if (!container) container = headingEl.parentElement;

      // Look for individual challenge cards
      const cards = container ? container.querySelectorAll('[class*="card"], [class*="challenge"], div > div') : [];

      // Also try: look for all cards that contain price-like text
      const allCards = document.querySelectorAll('div');
      const challengeCards = [];

      for (const card of allCards) {
        const text = card.textContent;
        // A challenge card typically has a name with firm name + program/challenge name, and a price
        if (text && text.includes('$') && card.children.length >= 2 && card.children.length <= 15) {
          const hasName = card.querySelector('h3, h4, [class*="title"], [class*="name"], p');
          const hasPrice = /\$[\d.,]+/.test(text);
          if (hasName && hasPrice && text.length < 500) {
            // Avoid duplicate parent/child
            if (!challengeCards.some(existing =>
              existing.contains(card) || card.contains(existing)
            )) {
              challengeCards.push(card);
            }
          }
        }
      }

      // Parse visible challenge cards near the "Challenges" heading
      const section = headingEl.closest('section') || headingEl.parentElement?.parentElement;
      if (!section) return results;

      const sectionCards = section.querySelectorAll('a[href*="challenge"], a[href*="buy"], div[class*="card"]');

      const processedCards = sectionCards.length > 0 ? sectionCards : (cards.length > 0 ? cards : challengeCards.slice(0, 20));

      for (const card of processedCards) {
        const cardText = card.textContent.trim();
        if (cardText.length < 10 || !cardText.includes('$')) continue;

        // Extract challenge name (first meaningful text)
        const nameEl = card.querySelector('h3, h4, p, [class*="title"], [class*="name"]');
        const challengeName = nameEl ? nameEl.textContent.trim() : null;

        // Extract prices
        const priceMatches = cardText.match(/\$([\d.,]+)/g) || [];
        const prices = priceMatches.map(p => parseFloat(p.replace(/[$,]/g, '')));

        results.push({
          challenge_name: challengeName,
          original_price: prices[0] || null,
          account_size: null, // Will try to parse from name
          profit_target: null,
          max_daily_loss: null,
          max_total_loss: null,
          min_trading_days: null,
          other_rules_text: cardText.length < 300 ? cardText : null,
        });
      }

      return results;
    }, []);

    // Try to extract account size from challenge name
    for (const challenge of challenges) {
      if (challenge.challenge_name) {
        const sizeMatch = challenge.challenge_name.match(/(\d+\.?\d*)\s*[Kk]/);
        if (sizeMatch) {
          challenge.account_size = parseFloat(sizeMatch[1]) * 1000;
        }
      }
    }

    return challenges;
  } catch (err) {
    console.warn(`  ⚠ Error scraping challenges: ${err.message}`);
    return [];
  }
}

// ─── Offer Section ──────────────────────────────────────────────────────────────

async function scrapeOffer(page) {
  try {
    const offer = await safeEval(page, () => {
      // Look for offer/promo banners
      const offerEl = document.querySelector(
        '[class*="offer"], [class*="promo"], [class*="coupon"], [class*="discount"]'
      );

      // Also check for the top offer banner that's visible on profile pages
      const bannerEls = document.querySelectorAll('[class*="banner"], [class*="NEW OFFER"]');
      let offerText = null;
      let discountPercent = null;
      let couponCode = null;

      // Search all text for offer patterns
      const bodyText = document.body.innerText;
      const discountMatch = bodyText.match(/(\d+)\s*%\s*OFF/i);
      if (discountMatch) {
        discountPercent = parseInt(discountMatch[1], 10);
      }

      // Look for coupon code - often in a "Code" label
      const codeEls = document.querySelectorAll('[aria-label*="Copy"], [class*="code"], button');
      for (const el of codeEls) {
        const text = el.textContent.trim();
        if (text.length >= 3 && text.length <= 30 && /^[A-Z0-9]+$/i.test(text)) {
          couponCode = text;
          break;
        }
      }

      // Get the offer text from the banner
      if (offerEl) {
        offerText = offerEl.textContent.trim().substring(0, 500);
      }

      // Try the visible offer description
      const descEls = document.querySelectorAll('p, span');
      for (const el of descEls) {
        const text = el.textContent.trim();
        if (text.includes('off') && text.includes('%') && text.length > 20 && text.length < 300) {
          offerText = text;
          break;
        }
      }

      return {
        offer_text: offerText,
        discount_percent: discountPercent,
        coupon_code: couponCode,
        valid_until: null,
      };
    }, { offer_text: null, discount_percent: null, coupon_code: null, valid_until: null });

    return offer;
  } catch {
    return { offer_text: null, discount_percent: null, coupon_code: null, valid_until: null };
  }
}

// ─── Payout Section ─────────────────────────────────────────────────────────────

async function scrapePayout(page) {
  try {
    // Click on "Payout Policy" sidebar or "Payouts" tab
    const payoutTab = page.locator('button:has-text("Payouts"), a:has-text("Payout Policy")').first();
    if (await payoutTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await payoutTab.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    const payout = await safeEval(page, () => {
      const result = {
        payout_frequency: null,
        first_payout_days: null,
        min_payout: null,
        payout_methods: [],
        payout_proof_url: null,
      };

      // Look for payout-related text
      const bodyText = document.body.innerText.toLowerCase();

      // Payout frequency
      const freqPatterns = [
        /payout\s*(?:frequency|cycle|schedule)[:\s]*([^\n.]+)/i,
        /(?:bi-?weekly|weekly|monthly|daily|on.?demand)/i,
      ];
      for (const pattern of freqPatterns) {
        const match = bodyText.match(pattern);
        if (match) {
          result.payout_frequency = match[1] || match[0];
          break;
        }
      }

      // First payout days
      const firstPayoutMatch = bodyText.match(/first\s*payout[:\s]*(\d+)\s*days?/i);
      if (firstPayoutMatch) {
        result.first_payout_days = parseInt(firstPayoutMatch[1], 10);
      }

      // Min payout
      const minPayoutMatch = bodyText.match(/min(?:imum)?\s*(?:payout|withdrawal)[:\s]*\$?([\d,]+)/i);
      if (minPayoutMatch) {
        result.min_payout = parseFloat(minPayoutMatch[1].replace(/,/g, ''));
      }

      // Payout methods - look for payment method badges/icons
      const paymentMethods = new Set();
      const methodKeywords = ['crypto', 'bitcoin', 'bank transfer', 'wire', 'paypal',
        'credit card', 'debit card', 'skrill', 'neteller', 'payoneer',
        'google pay', 'apple pay', 'rise', 'deel'];
      const allText = document.body.innerText;
      for (const method of methodKeywords) {
        if (allText.toLowerCase().includes(method)) {
          paymentMethods.add(method.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '));
        }
      }

      // Also look for payment method containers
      const paymentEls = document.querySelectorAll('[class*="payment"], [class*="method"]');
      for (const el of paymentEls) {
        const text = el.textContent.trim();
        if (text.length > 2 && text.length < 50) {
          paymentMethods.add(text);
        }
      }

      result.payout_methods = Array.from(paymentMethods);

      return result;
    }, {
      payout_frequency: null,
      first_payout_days: null,
      min_payout: null,
      payout_methods: [],
      payout_proof_url: null,
    });

    return payout;
  } catch {
    return {
      payout_frequency: null,
      first_payout_days: null,
      min_payout: null,
      payout_methods: [],
      payout_proof_url: null,
    };
  }
}

// ─── Rules Section ──────────────────────────────────────────────────────────────

async function scrapeRules(page) {
  try {
    // Click on "Firm Rules" sidebar link
    const rulesLink = page.locator('a:has-text("Firm Rules"), a:has-text("Rules")').first();
    if (await rulesLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await rulesLink.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Also click "Consistency Rules"
    const consistencyLink = page.locator('a:has-text("Consistency Rules")').first();
    if (await consistencyLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      await consistencyLink.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    const rules = await safeEval(page, () => {
      const result = {
        raw_rules_text: null,
        news_trading_rule: null,
        copy_trading_rule: null,
        ea_allowed: null,
        weekend_holding_allowed: null,
        lot_size_limit: null,
        consistency_rule: null,
        kyc_restriction: null,
        hidden_rule_flags: [],
      };

      const bodyText = document.body.innerText;

      // Raw rules text - collect from rules sections
      const rulesHeadings = Array.from(document.querySelectorAll('h2, h3')).filter(
        h => /rules?|policy|restriction/i.test(h.textContent)
      );

      const rulesTexts = [];
      for (const heading of rulesHeadings) {
        let sibling = heading.nextElementSibling;
        let collected = '';
        while (sibling && !['H2', 'H3'].includes(sibling.tagName)) {
          collected += sibling.textContent.trim() + '\n';
          sibling = sibling.nextElementSibling;
          if (collected.length > 1000) break;
        }
        if (collected.trim()) rulesTexts.push(collected.trim());
      }
      result.raw_rules_text = rulesTexts.join('\n---\n').substring(0, 3000) || null;

      // Parse specific rules from body text
      const lowerText = bodyText.toLowerCase();

      // News trading
      if (lowerText.includes('news trading')) {
        const newsMatch = bodyText.match(/news\s*trading[:\s]*([^\n]{5,100})/i);
        result.news_trading_rule = newsMatch ? newsMatch[1].trim() : (
          lowerText.includes('news trading allowed') ? 'Allowed' :
          lowerText.includes('no news trading') ? 'Not Allowed' : null
        );
      }

      // Copy trading
      if (lowerText.includes('copy trading') || lowerText.includes('copy-trading')) {
        const copyMatch = bodyText.match(/copy[- ]?trading[:\s]*([^\n]{5,100})/i);
        result.copy_trading_rule = copyMatch ? copyMatch[1].trim() : null;
      }

      // EA/Expert Advisors
      if (lowerText.includes('ea ') || lowerText.includes('expert advisor') || lowerText.includes('robot')) {
        if (lowerText.includes('ea allowed') || lowerText.includes('eas allowed') || lowerText.includes('expert advisors allowed')) {
          result.ea_allowed = true;
        } else if (lowerText.includes('no ea') || lowerText.includes('ea not allowed') || lowerText.includes('eas not allowed')) {
          result.ea_allowed = false;
        }
      }

      // Weekend holding
      if (lowerText.includes('weekend')) {
        if (lowerText.includes('weekend holding allowed') || lowerText.includes('hold over weekend')) {
          result.weekend_holding_allowed = true;
        } else if (lowerText.includes('no weekend holding') || lowerText.includes('close before weekend')) {
          result.weekend_holding_allowed = false;
        }
      }

      // Lot size limit
      const lotMatch = bodyText.match(/lot\s*size[:\s]*([^\n]{5,100})/i);
      if (lotMatch) result.lot_size_limit = lotMatch[1].trim();

      // Consistency rule
      const consistencyMatch = bodyText.match(/consistency\s*rule[:\s]*([^\n]{5,200})/i);
      if (consistencyMatch) result.consistency_rule = consistencyMatch[1].trim();

      // KYC restriction
      if (lowerText.includes('kyc')) {
        const kycMatch = bodyText.match(/kyc[:\s]*([^\n]{5,200})/i);
        result.kyc_restriction = kycMatch ? kycMatch[1].trim() : 'KYC Required';
      }

      return result;
    }, {
      raw_rules_text: null,
      news_trading_rule: null,
      copy_trading_rule: null,
      ea_allowed: null,
      weekend_holding_allowed: null,
      lot_size_limit: null,
      consistency_rule: null,
      kyc_restriction: null,
      hidden_rule_flags: [],
    });

    return rules;
  } catch {
    return {
      raw_rules_text: null,
      news_trading_rule: null,
      copy_trading_rule: null,
      ea_allowed: null,
      weekend_holding_allowed: null,
      lot_size_limit: null,
      consistency_rule: null,
      kyc_restriction: null,
      hidden_rule_flags: [],
    };
  }
}

// ─── Main Profile Scraper ───────────────────────────────────────────────────────

/**
 * Scrape all profile details from a firm's profile page.
 * @param {import('playwright').Page} page - Playwright page already on the profile URL
 * @returns {Promise<object>} profile_detail object
 */
export async function scrapeProfileDetail(page) {
  // Wait for page to load content
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // Dismiss any modals/popups
  try {
    const closeBtn = page.locator('[class*="close"], button:has-text("×"), button:has-text("Close")').first();
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }
  } catch {}

  // Accept cookies if needed
  try {
    const acceptBtn = page.locator('button:has-text("Accept")').first();
    if (await acceptBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await acceptBtn.click();
      await page.waitForTimeout(500);
    }
  } catch {}

  // Close any newsletter popups
  try {
    const popupClose = page.locator('button[aria-label="Close"], [class*="modal"] button:has-text("×")').first();
    if (await popupClose.isVisible({ timeout: 1000 }).catch(() => false)) {
      await popupClose.click();
      await page.waitForTimeout(500);
    }
  } catch {}

  console.log('    Scraping overview...');
  const overview_text = await scrapeOverview(page);

  console.log('    Scraping challenges...');
  const challenges = await scrapeChallenges(page);

  console.log('    Scraping offer...');
  const offer = await scrapeOffer(page);

  console.log('    Scraping payout...');
  const payout = await scrapePayout(page);

  console.log('    Scraping rules...');
  const rules = await scrapeRules(page);

  return {
    overview_text,
    challenges,
    offer,
    payout,
    rules,
  };
}

/**
 * Get raw HTML snapshot of the current page.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
export async function getPageSnapshot(page) {
  return page.content();
}
