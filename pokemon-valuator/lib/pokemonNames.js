let cached = null;

/**
 * Load a dictionary of Pokémon species names for OCR matching.
 * Cached in-memory for the process lifetime.
 */
export async function getPokemonNames() {
  if (cached) return cached;

  try {
    const res = await fetch(
      "https://pokeapi.co/api/v2/pokemon-species?limit=2000"
    );
    if (!res.ok) throw new Error(`pokeapi ${res.status}`);
    const data = await res.json();
    const names = (data.results || [])
      .map((r) => r.name.replace(/-/g, " "))
      .filter((n) => n.length >= 3);
    names.sort((a, b) => b.length - a.length);
    cached = names;
    return cached;
  } catch (err) {
    console.warn("Pokemon name dictionary unavailable:", err.message);
    cached = FALLBACK_NAMES;
    return cached;
  }
}

const FALLBACK_NAMES = [
  "charizard",
  "blastoise",
  "venusaur",
  "pikachu",
  "mewtwo",
  "mew",
  "lugia",
  "ho oh",
  "rayquaza",
  "gengar",
  "umbreon",
  "espeon",
  "sylveon",
  "eevee",
  "snorlax",
  "gyarados",
  "dragonite",
  "gardevoir",
  "lucario",
  "greninja",
  "mimikyu",
  "miraidon",
  "koraidon",
  "totodile",
  "croconaw",
  "feraligatr",
  "cyndaquil",
  "quilava",
  "typhlosion",
  "chikorita",
  "bayleef",
  "meganium",
  "charmeleon",
  "charmander",
].sort((a, b) => b.length - a.length);

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = new Array(cols);
  for (let j = 0; j < cols; j++) dp[j] = j;
  for (let i = 1; i < rows; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j < cols; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[cols - 1];
}

/** OCR often confuses lookalike glyphs — normalize before comparing. */
function ocrFold(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/5/g, "s")
    .replace(/\$/g, "s")
    .replace(/[^a-z]/g, "");
}

function thresholdFor(name) {
  const n = name.replace(/\s/g, "").length;
  // Short names are too collision-prone for fuzzy OCR matching
  if (n <= 4) return 0;
  if (n <= 6) return 1;
  if (n <= 9) return 2;
  return 3;
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function collectCandidateTokens(normalized, dictionary = []) {
  const tokens = new Set();

  for (const t of normalized.split(/\s+/)) {
    if (t.length >= 4 && t.length <= 14) tokens.add(t);
  }

  // NAME … HP patterns, including broken spacing and "HP 40" order
  const hpChunks = [
    ...normalized.matchAll(/([a-z][a-z\s']{2,24}?)\s+(\d{2,3})\s*hp\b/g),
    ...normalized.matchAll(/([a-z][a-z\s']{2,24}?)\s+hp\s*(\d{2,3})\b/g),
  ];
  for (const m of hpChunks) {
    const chunk = m[1].replace(/\s+/g, " ").trim();
    tokens.add(chunk.replace(/\s+/g, ""));
    for (const part of chunk.split(" ")) {
      if (part.length >= 4) tokens.add(part);
    }
    const parts = chunk.split(" ").filter(Boolean);
    if (parts.length >= 2) {
      tokens.add(parts.slice(-2).join(""));
      tokens.add(parts.slice(-2).join(" "));
    }
    if (parts.length >= 3) {
      tokens.add(parts.slice(-3).join(""));
    }
  }

  // Scan letter-only stream for dictionary names (and near-miss windows)
  const letters = normalized.replace(/[^a-z]/g, "");
  for (const name of dictionary) {
    const folded = ocrFold(name);
    if (folded.length < 5) continue;
    if (letters.includes(folded)) tokens.add(folded);
    // Also keep same-length windows around each occurrence for fuzzy neighbors
    let from = 0;
    while (from < letters.length) {
      const hit = letters.indexOf(folded.slice(0, 4), from);
      if (hit < 0) break;
      tokens.add(letters.slice(hit, hit + folded.length));
      tokens.add(letters.slice(Math.max(0, hit - 1), hit - 1 + folded.length));
      from = hit + 1;
    }
  }

  // Small sliding-window sample near the top of the OCR text
  const head = letters.slice(0, 220);
  for (let len = 6; len <= 10; len++) {
    for (let i = 0; i + len <= head.length; i += 1) {
      tokens.add(head.slice(i, i + len));
    }
  }

  return [...tokens];
}

/**
 * Find Pokémon names mentioned in noisy OCR text.
 * Prefers names near an HP marker and deprioritizes "Evolves from X" mentions.
 * Uses fuzzy matching so OCR mistakes like "Totodiie" still resolve.
 */
export function findNamesInText(text, dictionary) {
  if (!text) return [];
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'/]/g, " ")
    .replace(/\s+/g, " ");

  const evolvesFrom = new Set();
  for (const m of normalized.matchAll(
    /evolves?\s+from\s+([a-z][a-z\s']{1,30}?)(?:\s|$)/g
  )) {
    evolvesFrom.add(ocrFold(m[1]));
  }

  const scored = new Map(); // name -> score

  const bump = (name, score) => {
    const prev = scored.get(name) || 0;
    if (score > prev) scored.set(name, score);
  };

  // 1) Exact word matches (high confidence)
  for (const name of dictionary) {
    const re = new RegExp(`(?:^|\\s)(${escapeReg(name)})(?:\\s|$)`, "gi");
    const match = re.exec(normalized);
    if (!match) continue;
    const idx = match.index;
    const window = normalized.slice(
      Math.max(0, idx - 12),
      idx + name.length + 18
    );
    let score = 50;
    if (/\b\d{2,3}\s*hp\b/.test(window) || /\bhp\b/.test(window)) score += 40;
    score += Math.max(0, 20 - Math.floor(idx / 80));
    if ([...evolvesFrom].some((e) => e.includes(ocrFold(name)))) score -= 35;
    bump(name, score);
  }

  // 2) Fuzzy token / window matches for mangled OCR
  const tokens = collectCandidateTokens(normalized, dictionary);
  const foldedDict = dictionary.map((name) => ({
    name,
    folded: ocrFold(name),
  }));

  for (const token of tokens) {
    const foldedToken = ocrFold(token);
    if (foldedToken.length < 5) continue;

    for (const { name, folded } of foldedDict) {
      if (!folded || folded.length < 5) continue;
      const lenDiff = Math.abs(foldedToken.length - folded.length);
      if (lenDiff > 2) continue;
      const dist = editDistance(foldedToken, folded);
      const maxDist = thresholdFor(folded);
      // dist 0 is still useful: OCR often glues the name to junk ("2ezsdtotodile")
      // so the whitespace-exact pass above misses it.
      if (dist > maxDist) continue;

      // Prefer same first letter, but allow OCR first-letter flips
      // when the rest is clearly the same (Motodile → Totodile).
      const sameFirst = foldedToken[0] === folded[0];
      const sharedSuffix =
        foldedToken.length >= 6 &&
        folded.length >= 6 &&
        foldedToken.slice(1) === folded.slice(1);
      if (!sameFirst && !(dist <= 1 && sharedSuffix)) continue;

      let score = dist === 0 ? 48 : 34 - dist * 10;
      const approxIdx = normalized.indexOf(token.toLowerCase());
      if (approxIdx >= 0) {
        const window = normalized.slice(
          Math.max(0, approxIdx - 10),
          approxIdx + token.length + 16
        );
        if (/\b\d{2,3}\s*hp\b/.test(window) || /\bhp\b/.test(window)) score += 20;
      }
      if ([...evolvesFrom].some((e) => e.includes(folded))) score -= 30;
      // Only keep reasonably confident fuzzy hits
      if (score >= 24) bump(name, score);
    }
  }

  return [...scored.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => titleCase(name));
}
