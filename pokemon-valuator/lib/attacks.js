/** Distinctive attack phrases often OCR'd cleanly even when the name is mangled. */
const ATTACK_LINE_RE =
  /\b([A-Z][A-Za-z][A-Za-z'’\-]{2,24})(?:\s+[A-Z][A-Za-z'’\-]{2,18}){0,2}\b/g;

const NOISE =
  /^(basic|stage|weakness|resistance|retreat|pokemon|pokémon|choose|this|attack|damage|energy|length|weight|ability|power|put|each|your|opponent|affected|plus|more|does|cost|nintendo|creatures|freak)$/i;

/** Distinctive ability / attack phrases worth forcing into search even if OCR is messy */
export const KNOWN_MOVE_FRAGMENTS = [
  "voraciousness",
  "thudding",
  "splatter",
  "leftovers",
  "thudding press",
];

/**
 * Pull likely attack names from OCR text.
 */
export function extractAttackNames(text) {
  if (!text) return [];
  const found = [];

  // Prefer lines that look like attack headers (Title Case, short)
  for (const line of String(text).split(/\r?\n/)) {
    const cleaned = line.trim().replace(/\s+/g, " ");
    if (cleaned.length < 4 || cleaned.length > 28) continue;
    if (!/^[A-Z][A-Za-z'’\-]+(?:\s+[A-Z][A-Za-z'’\-]+)?$/.test(cleaned)) {
      continue;
    }
    if (NOISE.test(cleaned)) continue;
    if (/hp/i.test(cleaned)) continue;
    found.push(cleaned);
  }

  // Also scan free text for known-looking tokens near damage numbers
  for (const m of String(text).matchAll(
    /\b([A-Z][a-z]{3,16})\b(?:\s+\d{1,3})?/g
  )) {
    const name = m[1];
    if (!NOISE.test(name)) found.push(name);
  }

  const seen = new Set();
  return found.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}
