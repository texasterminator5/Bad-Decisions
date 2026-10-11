import Tesseract from "tesseract.js";
import sharp from "sharp";
import { extractAttackNames, KNOWN_MOVE_FRAGMENTS } from "./attacks.js";
import { detectFinishHints } from "./finish.js";
import { findNamesInText, getPokemonNames } from "./pokemonNames.js";

const NUMBER_RE =
  /\b([A-Z]{0,3}[\dOIlSZ]{1,3})\s*[\/|]\s*([A-Z]{0,3}[\dOIlSZ]{1,3})\b/gi;
const HP_RE = /\b(\d{2,3})\s*HP\b/i;
const NAME_BEFORE_HP_RE =
  /([A-Za-z][A-Za-z0-9'’.\- ]{1,40}?)\s+(\d{2,3})\s*HP\b/gi;

function fixOcrDigits(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/S/g, "5")
    .replace(/Z/g, "2");
}

const NOISE =
  /^(basic|stage|trainer|energy|weakness|resistance|retreat|ability|pokémon|pokemon|power|attack|rule|item|supporter|stadium|evolves|from|length|weight|cost)$/i;

const SUFFIXES = ["ex", "EX", "GX", "V", "VMAX", "VSTAR", "LV.X", "BREAK"];

/**
 * Preprocess an uploaded card photo for more reliable OCR.
 */
async function deglare(buffer) {
  // Top loaders create specular white blowouts — flatten the brightest pixels
  // so OCR can still read name/HP underneath.
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
    // Hot specular highlight: very bright and low saturation
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

export async function preprocessForOcr(buffer) {
  const cleaned = await deglare(buffer);
  const image = sharp(cleaned);
  const meta = await image.metadata();
  const width = meta.width || 1000;
  const height = meta.height || 1400;

  const full = await image
    .clone()
    .resize({ width: Math.min(1600, Math.max(900, width)), withoutEnlargement: false })
    .grayscale()
    .normalize()
    .modulate({ brightness: 1.05 })
    .sharpen()
    .png()
    .toBuffer();

  const top = await sharp(cleaned)
    .extract({
      left: Math.floor(width * 0.05),
      top: Math.floor(height * 0.02),
      width: Math.floor(width * 0.7),
      height: Math.max(40, Math.floor(height * 0.16)),
    })
    .resize({ width: 1400, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();

  const bottom = await sharp(cleaned)
    .extract({
      left: 0,
      top: Math.floor(height * 0.78),
      width,
      height: Math.max(40, Math.floor(height * 0.22)),
    })
    .resize({ width: 1400, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .threshold(155)
    .png()
    .toBuffer();

  // EX reverse holos often stamp the set name in the lower-right of the art box.
  // Capture a couple crops/thresholds so fragments like "FORCES" still land.
  const stampA = await sharp(cleaned)
    .extract({
      left: Math.floor(width * 0.42),
      top: Math.floor(height * 0.38),
      width: Math.max(40, Math.floor(width * 0.52)),
      height: Math.max(40, Math.floor(height * 0.2)),
    })
    .resize({ width: 1400, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();

  const stampB = await sharp(cleaned)
    .extract({
      left: Math.floor(width * 0.5),
      top: Math.floor(height * 0.45),
      width: Math.max(40, Math.floor(width * 0.45)),
      height: Math.max(40, Math.floor(height * 0.14)),
    })
    .resize({ width: 1400, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .threshold(145)
    .png()
    .toBuffer();

  return { full, top, bottom, stampA, stampB };
}

async function recognize(buffer) {
  const result = await Tesseract.recognize(buffer, "eng", {
    logger: () => {},
  });
  return result.data.text || "";
}

function extractCollectorNumbers(text) {
  const found = [];
  // Normalize common OCR slash lookalikes before matching
  const normalized = String(text || "").replace(/[|\\]/g, "/");
  for (const match of normalized.matchAll(NUMBER_RE)) {
    const local = fixOcrDigits(match[1]);
    const printed = fixOcrDigits(match[2]);
    // Ignore nonsense like 1/1 from attack text unless it looks like a set size
    const printedN = Number(printed);
    if (!Number.isFinite(printedN) || printedN < 10) continue;
    found.push({
      localId: local.replace(/^0+(\d)/, "$1"),
      localIdRaw: local,
      printedTotal: printed,
      raw: `${local}/${printed}`,
    });
  }
  const seen = new Set();
  return found.filter((n) => {
    if (seen.has(n.raw)) return false;
    seen.add(n.raw);
    return true;
  });
}

function extractHp(text) {
  // Only trust clear HP markers — glare OCR invents numbers constantly.
  const matches = [...String(text).matchAll(/\b(\d{2,3})\s*HP\b/gi)];
  for (const m of matches) {
    const n = Number(m[1]);
    if (n >= 30 && n <= 340) return n;
  }
  return null;
}

function scrubName(raw) {
  let s = raw
    .replace(/[^A-Za-z0-9'’.\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Drop leading OCR junk words
  s = s
    .replace(/^(stage\s*[12]|basic|trainer|item|supporter)\s+/i, "")
    .replace(/\b\d{2,3}\s*HP\b/gi, "")
    .trim();

  // Keep only letter-ish tokens
  const tokens = s.split(" ").filter((t) => {
    if (!t) return false;
    if (NOISE.test(t)) return false;
    if (/^\d+$/.test(t)) return false;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    return letters >= 2 || SUFFIXES.includes(t);
  });

  s = tokens.join(" ").trim();
  if (s.length < 3 || s.length > 42) return null;

  const letterRatio =
    (s.replace(/[^A-Za-z]/g, "").length || 0) / Math.max(1, s.length);
  if (letterRatio < 0.7) return null;

  return s;
}

function extractNameCandidates(text) {
  const names = [];

  for (const match of text.matchAll(NAME_BEFORE_HP_RE)) {
    const scrubbed = scrubName(match[1]);
    if (scrubbed) names.push(scrubbed);
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  for (const line of lines) {
    const scrubbed = scrubName(line);
    if (!scrubbed) continue;
    if (scrubbed.split(" ").length > 5) continue;
    names.push(scrubbed);
  }

  const seen = new Set();
  return names.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Run OCR on a card image and pull out identity hints.
 */
export async function identifyFromImage(buffer) {
  const dictionary = await getPokemonNames();
  const { full, top, bottom, stampA, stampB } = await preprocessForOcr(buffer);

  const [fullText, topText, bottomText, stampTextA, stampTextB] =
    await Promise.all([
      recognize(full),
      recognize(top),
      recognize(bottom),
      recognize(stampA),
      recognize(stampB),
    ]);

  const combined = `${topText}\n${fullText}\n${bottomText}\n${stampTextA}\n${stampTextB}`;
  const numbers = [
    ...extractCollectorNumbers(bottomText),
    ...extractCollectorNumbers(fullText),
  ];
  const seenNum = new Set();
  const uniqueNumbers = numbers.filter((n) => {
    if (seenNum.has(n.raw)) return false;
    seenNum.add(n.raw);
    return true;
  });

  // Only return Pokémon-dictionary names for search. Raw OCR tokens like
  // "Fie" / "Splatter" previously poisoned lookups into trainer cards.
  const dictNames = findNamesInText(combined, dictionary);
  const dictSet = new Set(dictionary);
  const attacks = extractAttackNames(combined).filter((a) => {
    const key = a.toLowerCase();
    if (dictSet.has(key)) return false;
    // Drop OCR near-misses of Pokémon names (Motodile → Totodile)
    return !dictNames.some((n) => {
      const dn = n.toLowerCase();
      return key.slice(1) === dn.slice(1) || key.includes(dn) || dn.includes(key);
    });
  });

  // Rescue known move/ability fragments from noisy glare OCR
  const lowerCombined = combined.toLowerCase();
  for (const frag of KNOWN_MOVE_FRAGMENTS) {
    if (lowerCombined.includes(frag) && !attacks.some((a) => a.toLowerCase().includes(frag))) {
      attacks.unshift(frag.replace(/\b\w/g, (c) => c.toUpperCase()));
    }
  }

  const rawText = combined.trim();
  const promo = extractPromoHints(combined);
  return {
    rawText,
    names: dictNames.slice(0, 6),
    numbers: uniqueNumbers.slice(0, 6),
    hp: extractHp(combined),
    attacks: attacks.slice(0, 6),
    finish: detectFinishHints(rawText),
    promo,
  };
}

function extractPromoHints(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  const codes = new Set();
  if (/\bpromo\b/i.test(t) || /\bsvp\b/i.test(t) || /\bmep\b/i.test(t)) {
    codes.add("promo");
  }
  if (/\bsvp\b/i.test(t)) codes.add("svp");
  if (/\bmep\b/i.test(t)) codes.add("mep");
  if (/25(?:th)?/.test(lower) || /anniversary/.test(lower)) codes.add("25th");

  const numbers = [];
  for (const m of t.matchAll(/\b(?:svp|mep|en)?\s*0*([0-9]{2,3})\b/gi)) {
    const n = m[1];
    if (Number(n) >= 1 && Number(n) <= 300) numbers.push(n);
  }

  return {
    isPromo: codes.has("promo") || codes.has("svp") || codes.has("mep") || codes.has("25th"),
    sets: [...codes],
    numbers: [...new Set(numbers)].slice(0, 6),
  };
}
