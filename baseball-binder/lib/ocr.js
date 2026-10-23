import Tesseract from "tesseract.js";
import sharp from "sharp";

const BRANDS = [
  "Topps",
  "Upper Deck",
  "Bowman",
  "Donruss",
  "Fleer",
  "Score",
  "Panini",
  "Leaf",
  "Stadium Club",
  "Chrome",
  "Heritage",
  "Update",
  "Finest",
  "Prizm",
  "Select",
  "Mosaic",
  "Optic",
  "Chronicles",
  "Allen & Ginter",
  "Gypsy Queen",
  "Archives",
  "Series 1",
  "Series 2",
  "Opening Day",
  "Fire",
  "Absolute",
  "Immaculate",
  "National Treasures",
  "Contenders",
  "Donruss Optic",
  "Topps Chrome",
  "Bowman Chrome",
  "SP Authentic",
  "SPX",
  "Pinnacle",
  "Pacific",
  "O-Pee-Chee",
  "OPC",
];

const BRAND_RE = new RegExp(
  `\\b(${BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "gi"
);

const YEAR_RE = /\b((?:19|20)\d{2})\b/g;
const NUMBER_RE =
  /(?:#|No\.?\s*|Card\s*)?([A-Z]{0,3}\d{1,4}[A-Z]?(?:-[A-Z0-9]+)?)\b/gi;
const RC_RE = /\b(RC|Rookie(?:\s*Card)?|Rated Rookie)\b/i;

const NOISE =
  /^(baseball|card|cards|trading|official|licensed|mlb|major|league|base|set|series|rookie|autograph|auto|relic|parallel|refractor|chrome|insert|checklist|team|logo|copyright|made|usa|printed|in|the|of|and|for|with|all|rights|reserved)$/i;

function fixOcrDigits(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/S/g, "5")
    .replace(/Z/g, "2");
}

async function deglare(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max >= 245 && max - min < 18) {
      data[i] = 210;
      data[i + 1] = 210;
      data[i + 2] = 210;
    } else if (max >= 235 && max - min < 12) {
      data[i] = Math.min(220, r);
      data[i + 1] = Math.min(220, g);
      data[i + 2] = Math.min(220, b);
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels },
  })
    .removeAlpha()
    .png()
    .toBuffer();
}

async function preprocessForOcr(buffer) {
  const cleaned = await deglare(buffer);
  const image = sharp(cleaned);
  const meta = await image.metadata();
  const width = meta.width || 1000;
  const height = meta.height || 1400;

  const full = await image
    .clone()
    .resize({
      width: Math.min(1600, Math.max(900, width)),
      withoutEnlargement: false,
    })
    .grayscale()
    .normalize()
    .modulate({ brightness: 1.05 })
    .sharpen()
    .png()
    .toBuffer();

  const safeExtract = async (region) => {
    if (width < 20 || height < 20) return full;
    let left = Math.max(0, Math.floor(region.left));
    let top = Math.max(0, Math.floor(region.top));
    let w = Math.floor(region.width);
    let h = Math.floor(region.height);
    if (left >= width || top >= height) return full;
    w = Math.min(w, width - left);
    h = Math.min(h, height - top);
    if (w < 10 || h < 10) return full;
    try {
      return await sharp(cleaned)
        .extract({ left, top, width: w, height: h })
        .resize({
          width: Math.min(1400, Math.max(600, w * 2)),
          withoutEnlargement: false,
        })
        .grayscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
    } catch {
      return full;
    }
  };

  // Name band is usually lower third on modern cards, top on many vintage
  const bottom = await safeExtract({
    left: Math.floor(width * 0.05),
    top: Math.floor(height * 0.62),
    width: Math.floor(width * 0.9),
    height: Math.max(40, Math.floor(height * 0.32)),
  });

  const top = await safeExtract({
    left: Math.floor(width * 0.05),
    top: Math.floor(height * 0.02),
    width: Math.floor(width * 0.9),
    height: Math.max(40, Math.floor(height * 0.18)),
  });

  return { full, top, bottom };
}

async function ocrBuffer(buf) {
  const { data } = await Tesseract.recognize(buf, "eng", {
    logger: () => {},
  });
  return {
    text: data.text || "",
    confidence: data.confidence || 0,
  };
}

function extractBrands(text) {
  const found = [];
  const seen = new Set();
  for (const m of text.matchAll(BRAND_RE)) {
    const brand = m[1].replace(/\s+/g, " ").trim();
    const key = brand.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(brand);
    }
  }
  return found;
}

function extractYears(text) {
  const years = [];
  const seen = new Set();
  for (const m of text.matchAll(YEAR_RE)) {
    const y = Number(m[1]);
    if (y < 1869 || y > new Date().getFullYear() + 1) continue;
    if (!seen.has(y)) {
      seen.add(y);
      years.push(String(y));
    }
  }
  return years;
}

function extractNumbers(text) {
  const nums = [];
  const seen = new Set();
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[1];
    if (!raw) continue;
    // Skip bare years mistaken as numbers
    if (/^(19|20)\d{2}$/.test(raw)) continue;
    if (/^\d$/.test(raw) && !m[0].includes("#")) continue;
    const cleaned = fixOcrDigits(raw).replace(/^0+(\d)/, "$1");
    if (!/\d/.test(cleaned)) continue;
    if (cleaned.length > 8) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    nums.push({ raw: m[0].trim(), number: cleaned });
  }
  return nums.slice(0, 6);
}

function cleanNameLine(line) {
  return String(line || "")
    .replace(/[|]/g, " ")
    .replace(/[^A-Za-z0-9.'\-\s]/g, " ")
    .replace(/\bRC\b/gi, " ")
    .replace(/^#?\d{1,4}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function polishPlayerName(line) {
  let words = cleanNameLine(line).split(/\s+/).filter(Boolean);
  // Drop leading/trailing single-letter OCR crumbs (keep Jr/Sr)
  while (words.length && /^[A-Za-z]$/.test(words[0])) words.shift();
  // Drop short leading tokens like "GB" / "AB" before a real first name
  while (
    words.length >= 3 &&
    words[0].length <= 2 &&
    !/^(jr|sr)$/i.test(words[0])
  ) {
    words.shift();
  }
  while (
    words.length &&
    /^[A-Za-z]\.?$/.test(words[words.length - 1]) &&
    !/^(jr|sr)\.?$/i.test(words[words.length - 1])
  ) {
    words.pop();
  }
  // Drop trailing dots-only junk
  words = words
    .map((w) => w.replace(/\.+$/g, (m) => (m.length > 1 ? "" : m)))
    .filter(Boolean);
  return words.join(" ").replace(/\s+/g, " ").trim();
}

function looksLikePlayerName(line) {
  const cleaned = polishPlayerName(line);
  if (cleaned.length < 4 || cleaned.length > 36) return false;
  if (/^\d+$/.test(cleaned)) return false;
  if (NOISE.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (words.every((w) => NOISE.test(w))) return false;
  const substantial = words.filter((w) => {
    if (/^(jr|sr|ii|iii|iv)\.?$/i.test(w)) return true;
    return /^[A-Za-z][A-Za-z.'.-]+$/.test(w) && w.replace(/\./g, "").length >= 3;
  });
  if (substantial.length < 2) return false;
  const singleLetters = words.filter((w) => /^[A-Za-z]\.?$/.test(w)).length;
  if (singleLetters > 1) return false;
  if (/^(topps|upper deck|bowman|donruss|fleer|score|panini)/i.test(cleaned)) {
    return false;
  }
  return true;
}

function titleCaseName(line) {
  return polishPlayerName(line)
    .split(/\s+/)
    .map((w) => {
      if (/^(jr|sr)\.?$/i.test(w)) return "Jr.";
      if (/^(ii|iii|iv)$/i.test(w)) return w.toUpperCase();
      if (w.length <= 2) return w.toUpperCase();
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ")
    .replace(/\bJr\.$/i, "Jr.");
}

function extractPlayerNames(text) {
  const lines = String(text)
    .split(/\n+/)
    .map((l) => polishPlayerName(l))
    .filter(Boolean);

  const candidates = [];
  for (const line of lines) {
    if (!looksLikePlayerName(line)) continue;
    candidates.push(titleCaseName(line));
  }

  // Scan full text for First Last [Jr] patterns with real word lengths
  const blob = cleanNameLine(text);
  for (const m of blob.matchAll(
    /\b([A-Za-z]{3,})\s+([A-Za-z]{3,})(?:\s+(Jr\.?|Sr\.?|II|III))?\b/g
  )) {
    const candidate = polishPlayerName(m[0]);
    if (looksLikePlayerName(candidate)) candidates.push(titleCaseName(candidate));
  }

  const nameScore = (c) => {
    const words = c.split(/\s+/);
    let s = c.length;
    // Prefer classic First Last [Jr] shapes
    if (words.length === 2 || words.length === 3) s += 8;
    if (words.some((w) => /^(jr|sr)\.?$/i.test(w))) s += 4;
    // Penalize odd tokens
    for (const w of words) {
      if (/\d/.test(w)) s -= 10;
      if (w.includes("..")) s -= 8;
      if (w.length <= 2 && !/^(jr|sr)\.?$/i.test(w)) s -= 3;
    }
    return s;
  };

  const seen = new Set();
  const unique = [];
  for (const c of candidates.sort((a, b) => nameScore(b) - nameScore(a))) {
    const key = c.toLowerCase().replace(/\./g, "");
    if (seen.has(key)) continue;
    if ([...seen].some((s) => s.includes(key) || key.includes(s))) continue;
    seen.add(key);
    unique.push(c);
  }
  return unique.slice(0, 5);
}

function buildQuery({ players, years, brands, numbers, isRookie }) {
  const parts = [];
  if (years[0]) parts.push(years[0]);
  if (brands[0]) parts.push(brands[0]);
  if (numbers[0]?.number) parts.push(`#${numbers[0].number}`);
  if (players[0]) parts.push(players[0]);
  if (isRookie) parts.push("RC");
  return parts.join(" ").trim();
}

/**
 * OCR a single card crop → structured baseball hints.
 */
async function upscaleForOcr(buffer) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 0;
  // Binder pocket crops are often small — upscale before OCR
  if (w > 0 && w < 900) {
    return sharp(buffer)
      .resize({ width: Math.min(1400, Math.round(w * 2.4)), withoutEnlargement: false })
      .sharpen()
      .jpeg({ quality: 92 })
      .toBuffer();
  }
  return buffer;
}

export async function identifyFromImage(buffer) {
  const enlarged = await upscaleForOcr(buffer);
  const { full, top, bottom } = await preprocessForOcr(enlarged);
  const [fullOcr, topOcr, bottomOcr] = await Promise.all([
    ocrBuffer(full),
    ocrBuffer(top),
    ocrBuffer(bottom),
  ]);

  const combined = [fullOcr.text, topOcr.text, bottomOcr.text].join("\n");
  const players = [
    ...extractPlayerNames(bottomOcr.text),
    ...extractPlayerNames(topOcr.text),
    ...extractPlayerNames(fullOcr.text),
  ];
  // dedupe players
  const playerSeen = new Set();
  const playerNames = [];
  for (const p of players) {
    const k = p.toLowerCase();
    if (playerSeen.has(k)) continue;
    playerSeen.add(k);
    playerNames.push(p);
  }

  const years = extractYears(combined);
  const brands = extractBrands(combined);
  const numbers = extractNumbers(combined);
  const isRookie = RC_RE.test(combined);
  const query = buildQuery({
    players: playerNames,
    years,
    brands,
    numbers,
    isRookie,
  });

  return {
    players: playerNames,
    years,
    brands,
    numbers,
    isRookie,
    query,
    rawText: combined.slice(0, 1200),
    confidence: Math.round(
      (fullOcr.confidence + topOcr.confidence + bottomOcr.confidence) / 3
    ),
  };
}
