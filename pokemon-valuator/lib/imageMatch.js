import sharp from "sharp";

const HASH_SIZE = 16;

/**
 * Focus on the card body — phone photos include wood/table borders that
 * destroy naive whole-frame hashes.
 */
async function cardFocusedBuffer(buffer) {
  const image = sharp(buffer).rotate();
  const meta = await image.metadata();
  const width = meta.width || 1000;
  const height = meta.height || 1400;

  // Trim near-uniform borders, then take a centered card-shaped crop
  const trimmed = await image
    .clone()
    .trim({ threshold: 18 })
    .toBuffer({ resolveWithObject: true })
    .catch(async () => ({
      data: await image.clone().toBuffer(),
      info: { width, height },
    }));

  const tw = trimmed.info.width || width;
  const th = trimmed.info.height || height;
  const sidePad = Math.floor(tw * 0.08);
  const topPad = Math.floor(th * 0.06);
  const bottomPad = Math.floor(th * 0.1);
  const left = Math.max(0, sidePad);
  const top = Math.max(0, topPad);
  const cropW = Math.max(32, tw - sidePad * 2);
  const cropH = Math.max(32, th - topPad - bottomPad);

  return sharp(trimmed.data)
    .extract({
      left,
      top,
      width: Math.min(cropW, tw - left),
      height: Math.min(cropH, th - top),
    })
    .normalize()
    .toBuffer();
}

/**
 * Build a simple average-hash fingerprint for a card photo / official scan.
 */
export async function averageHash(buffer) {
  const focused = await cardFocusedBuffer(buffer);
  const { data, info } = await sharp(focused)
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
 */
export async function rankByVisualSimilarity(uploadBuffer, cards, { limit = 16 } = {}) {
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
        const visualScore = Math.max(0, 140 - distance);
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
