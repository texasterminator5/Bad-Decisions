import { identifyFromImage } from "./ocr.js";
import { resolveFromHints, identifyCardDescription } from "./catalog.js";
import { enrichWithPrices, seedCandidatesFromPriceSearch } from "./prices.js";
import { rankByVisualSimilarity } from "./imageMatch.js";

/**
 * Full identify → catalogue match → price pipeline for one card crop.
 */
export async function appraiseCardBuffer(buffer) {
  const hints = await identifyFromImage(buffer);
  let { source, cards: rawCards, confidence, parsed, error, usedQuery } =
    await resolveFromHints(hints);

  // If year/set OCR is thin, seed from SportsCardsPro titles for the player
  const thinMeta = !(hints?.years?.length || hints?.brands?.length);
  const player =
    (hints?.players || []).find(
      (p) =>
        /^[A-Za-z][A-Za-z.'.-]+(?:\s+[A-Za-z][A-Za-z.'.-]+){1,3}$/.test(p) &&
        p.split(/\s+/).filter((w) => w.replace(/\./g, "").length >= 3).length >=
          2 &&
        !/\d/.test(p)
    ) || "";
  const playerTrustworthy = Boolean(player);
  if (thinMeta && playerTrustworthy) {
    try {
      const seeds = (await seedCandidatesFromPriceSearch(player)).slice(0, 6);
      const promoted = [];
      const seen = new Set();
      for (const seed of seeds) {
        const desc = [seed.year, seed.product, seed.name, seed.number ? `#${seed.number}` : null]
          .filter(Boolean)
          .join(" ");
        let card = seed;
        try {
          const identified = await identifyCardDescription(desc);
          if (identified.matches[0]) {
            card = { ...identified.matches[0], seedPrices: seed.seedPrices };
          }
        } catch {
          // keep seed itself
        }
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        promoted.push(card);
      }
      // Seeded/priced candidates first so visual ranking sees the likely hits
      const rest = (rawCards || []).filter((c) => !seen.has(c.id));
      rawCards = [...promoted, ...rest];
      source = source ? `${source}+scp-seed` : "sportscardspro-seed";
    } catch (err) {
      console.warn("seed merge failed:", err.message);
    }
  }

  const rawLower = String(hints?.rawText || "").toLowerCase();
  const scoreCard = (card) => {
    let score = 0;
    if (!String(card.id).startsWith("ebay_") && !String(card.id).startsWith("ing_")) {
      score += 5;
    }
    const wantNum = hints?.numbers?.[0]?.number;
    if (wantNum && String(card.number || "") === String(wantNum)) score += 8;
    const wantYear = hints?.years?.[0];
    if (wantYear && String(card.year) === String(wantYear)) score += 6;
    for (const brand of hints?.brands || []) {
      if (
        String(card.product || "").toLowerCase().includes(brand.toLowerCase()) ||
        String(card.set || "").toLowerCase().includes(brand.toLowerCase())
      ) {
        score += 4;
      }
    }
    if (card.year && rawLower.includes(String(card.year))) score += 2;
    if (card.product) {
      for (const token of String(card.product).toLowerCase().split(/\s+/)) {
        if (token.length > 3 && rawLower.includes(token)) score += 1;
      }
    }
    if (card.number && rawLower.includes(String(card.number).toLowerCase())) score += 1;
    if (typeof card.visualDistance === "number" && card.visualDistance < 9000) {
      // Lower Hamming distance = better visual match
      score += Math.max(0, 40 - card.visualDistance / 10);
    }
    if (card.seedPrices) score += 3;
    return score;
  };

  let ranked = [...(rawCards || [])];
  try {
    ranked = await rankByVisualSimilarity(buffer, ranked, {
      limit: Math.min(10, ranked.length || 0),
    });
  } catch (err) {
    console.warn("visual rank failed:", err.message);
  }
  ranked.sort((a, b) => scoreCard(b) - scoreCard(a));

  const head = [];
  for (const card of ranked.slice(0, 4)) {
    try {
      head.push(await enrichWithPrices(card));
    } catch (err) {
      head.push({ ...card, headline: null, prices: [], priceError: err.message });
    }
  }
  const cards = [...head, ...ranked.slice(4)];

  return {
    hints: {
      ...hints,
      catalogConfidence: confidence || null,
      parsed: parsed || null,
      resolveError: error || null,
      usedQuery: usedQuery || null,
    },
    source,
    cards,
    best: cards[0] || null,
  };
}
