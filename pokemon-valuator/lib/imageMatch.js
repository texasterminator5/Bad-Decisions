import sharp from "sharp";

const HASH_SIZE = 16;

/**
 * Build a simple average-hash fingerprint for a card photo / official scan.
 */
export async function averageHash(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(HASH_SIZE, HASH_SIZE, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = info.width * info.height;
  let sum = 0;
  for (let i = 0; i < pixels; i++) sum += data[i];
  const avg = sum / pixels;

  let bits = "";
  for (let i = 0; i < pixels; i++) {
    bits += data[i] >= avg ? "1" : "0";
  }
  return bits;
}

export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist += 1;
  }
  return dist;
}

async function fetchImageBuffer(url) {
  const res = await fetch(url, {
    headers: { Accept: "image/*" },
  });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Re-rank catalogue matches by visual similarity to the uploaded photo.
 * Returns cards with `visualScore` (higher is better) and boosted `matchScore`.
 */
export async function rankByVisualSimilarity(uploadBuffer, cards, { limit = 12 } = {}) {
  if (!uploadBuffer || !cards?.length) return cards || [];

  const uploadHash = await averageHash(uploadBuffer);
  const pool = cards.slice(0, limit);

  const scored = await Promise.all(
    pool.map(async (card) => {
      const url = card.images?.small || card.images?.large;
      if (!url) {
        return { card, distance: 999, visualScore: 0 };
      }
      try {
        const buf = await fetchImageBuffer(url);
        const hash = await averageHash(buf);
        const distance = hammingDistance(uploadHash, hash);
        // 256-bit hash (16x16). Lower distance = closer match.
        const visualScore = Math.max(0, 120 - distance);
        return { card, distance, visualScore };
      } catch {
        return { card, distance: 999, visualScore: 0 };
      }
    })
  );

  scored.sort(
    (a, b) =>
      b.visualScore - a.visualScore ||
      (b.card.matchScore || 0) - (a.card.matchScore || 0)
  );

  const rest = cards.slice(limit);
  return [
    ...scored.map(({ card, distance, visualScore }) => ({
      ...card,
      visualDistance: distance,
      visualScore,
      matchScore: (card.matchScore || 0) + visualScore,
    })),
    ...rest,
  ].sort(
    (a, b) =>
      (b.matchScore || 0) - (a.matchScore || 0) ||
      (b.visualScore || 0) - (a.visualScore || 0)
  );
}
