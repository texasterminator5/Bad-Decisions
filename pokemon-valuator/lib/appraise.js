import {
  applyFinishHeadline,
  enrichCardFinishes,
  resolveCards,
} from "./prices.js";
import { identifyFromImage } from "./ocr.js";
import { rankByVisualSimilarity } from "./imageMatch.js";

/**
 * Full identify → match → finish pipeline for a single card crop.
 */
export async function appraiseCardBuffer(buffer) {
  const hints = await identifyFromImage(buffer);
  const { source, cards: rawCards } = await resolveCards(hints);

  let cards = await rankByVisualSimilarity(buffer, rawCards, {
    limit: Math.min(16, rawCards.length || 0),
  });

  const head = await Promise.all(
    cards.slice(0, 8).map(async (card) => {
      const enriched = await enrichCardFinishes(card);
      return applyFinishHeadline(enriched, hints.finish || {});
    })
  );
  cards = [...head, ...cards.slice(8)];

  return {
    hints,
    source,
    cards,
    best: cards[0] || null,
  };
}
