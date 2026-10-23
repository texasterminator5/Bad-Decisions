import sharp from "sharp";

async function fingerprint(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(32, 44, { fit: "fill" })
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Average hash
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const avg = sum / data.length;
  const bits = [];
  for (let i = 0; i < data.length; i++) bits.push(data[i] >= avg ? 1 : 0);
  return { bits, width: info.width, height: info.height };
}

function hamming(a, b) {
  const n = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) dist++;
  return dist + Math.abs(a.length - b.length);
}

async function fetchImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "image/*",
        "User-Agent":
          "Mozilla/5.0 (compatible; NineSlot/1.0; +https://localhost)",
      },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Re-rank catalogue cards by visual similarity to the crop.
 */
export async function rankByVisualSimilarity(cropBuffer, cards, { limit = 8 } = {}) {
  if (!cards?.length) return cards || [];
  const head = cards.slice(0, Math.min(limit, cards.length));
  let probe;
  try {
    probe = await fingerprint(cropBuffer);
  } catch {
    return cards;
  }

  const scored = [];
  for (const card of head) {
    const buf = await fetchImage(card.image);
    if (!buf) {
      scored.push({ card, dist: 9999 });
      continue;
    }
    try {
      const fp = await fingerprint(buf);
      scored.push({ card, dist: hamming(probe.bits, fp.bits) });
    } catch {
      scored.push({ card, dist: 9999 });
    }
  }

  scored.sort((a, b) => a.dist - b.dist);
  const rest = cards.slice(head.length);
  return [...scored.map((s) => ({ ...s.card, visualDistance: s.dist })), ...rest];
}
