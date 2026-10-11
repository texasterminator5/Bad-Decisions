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
    // Prefer longer names first when scanning OCR text
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
  "umbreon",
  "charmeleon",
  "charmander",
].sort((a, b) => b.length - a.length);

/**
 * Find Pokémon names mentioned in noisy OCR text.
 * Prefers names near an HP marker and deprioritizes "Evolves from X" mentions.
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
    evolvesFrom.add(m[1].trim());
  }

  const scored = [];
  for (const name of dictionary) {
    const re = new RegExp(`(?:^|\\s)(${escapeReg(name)})(?:\\s|$)`, "gi");
    let match;
    while ((match = re.exec(normalized))) {
      const idx = match.index;
      const window = normalized.slice(Math.max(0, idx - 12), idx + name.length + 18);
      let score = 10;
      if (/\b\d{2,3}\s*hp\b/.test(window) || /\bhp\b/.test(window)) score += 40;
      // Top-of-card mentions tend to appear earlier in OCR output
      score += Math.max(0, 20 - Math.floor(idx / 80));
      if ([...evolvesFrom].some((e) => e.includes(name) || name.includes(e))) {
        score -= 35;
      }
      scored.push({ name: titleCase(name), score });
      break;
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return scored
    .filter((s) => {
      const key = s.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return s.score > 0;
    })
    .map((s) => s.name);
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
