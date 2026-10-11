import Tesseract from "tesseract.js";
import sharp from "sharp";
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
export async function preprocessForOcr(buffer) {
  const image = sharp(buffer).rotate();
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

  const top = await sharp(buffer)
    .rotate()
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

  const bottom = await sharp(buffer)
    .rotate()
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

  return { full, top, bottom };
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
  const m = text.match(HP_RE);
  return m ? Number(m[1]) : null;
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
  const { full, top, bottom } = await preprocessForOcr(buffer);

  const [fullText, topText, bottomText] = await Promise.all([
    recognize(full),
    recognize(top),
    recognize(bottom),
  ]);

  const combined = `${topText}\n${fullText}\n${bottomText}`;
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

  const dictNames = findNamesInText(combined, dictionary);
  const ocrNames = [
    ...extractNameCandidates(topText),
    ...extractNameCandidates(fullText),
  ];

  // Dictionary hits first — much more reliable than raw OCR lines
  const cleanOcr = ocrNames.filter((n) => {
    if (n.split(" ").length > 3) return false;
    if (/[^A-Za-z0-9'’.\-\s]/.test(n)) return false;
    // Require at least one capital letter token that looks like a title
    return /[A-Z][a-z]{2,}/.test(n);
  });
  const names = [...dictNames, ...cleanOcr];
  const seenName = new Set();
  const uniqueNames = names.filter((n) => {
    const key = n.toLowerCase();
    if (seenName.has(key)) return false;
    seenName.add(key);
    return true;
  });

  return {
    rawText: combined.trim(),
    names: uniqueNames.slice(0, 8),
    numbers: uniqueNumbers.slice(0, 6),
    hp: extractHp(combined),
  };
}
