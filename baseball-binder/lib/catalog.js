/**
 * MyCardfolio MCP client — free sports-card catalogue (no API key).
 */

const MCP_URL = "https://mycardfolio.com/api/mcp";

function parseSseJson(body) {
  // SSE: "event: message\ndata: {...}\n\n"
  const lines = String(body).split(/\n/);
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const raw = line.slice(5).trim();
      if (!raw) continue;
      return JSON.parse(raw);
    }
  }
  // Sometimes a bare JSON body
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Unexpected MCP response: ${String(body).slice(0, 200)}`);
  }
}

async function mcpCall(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MyCardfolio ${res.status}: ${text.slice(0, 200)}`);
  }
  const msg = parseSseJson(text);
  if (msg.error) {
    throw new Error(msg.error.message || "MyCardfolio error");
  }
  const content = msg.result?.content?.[0]?.text;
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return { raw: content };
  }
}

function subjectName(card) {
  const subjects = card?.subjects || [];
  return subjects
    .map((s) => s.subject_name)
    .filter(Boolean)
    .join(" / ");
}

export function mapCatalogCard(card) {
  if (!card) return null;
  const name = subjectName(card) || "Unknown player";
  return {
    id: String(card.card_id),
    name,
    year: card.year || null,
    product: card.product || null,
    set: card.set || null,
    number: card.card_number || null,
    sport: card.sport || "Baseball",
    details: card.card_details || "",
    team: (card.subjects || []).map((s) => s.team_name).filter(Boolean)[0] || null,
    url: card.url || null,
    image: card.image_url || null,
    source: "MyCardfolio",
  };
}

/**
 * Identify a card from OCR/query text.
 */
export async function identifyCardDescription(description) {
  const desc = String(description || "").trim();
  if (desc.length < 3) return { matches: [], confidence: null, parsed: null };

  const data = await mcpCall("identify_card", { description: desc });
  const matches = (data?.matches || []).map(mapCatalogCard).filter(Boolean);
  return {
    matches,
    confidence: data?.confidence || null,
    parsed: data?.parsed || null,
  };
}

export async function searchCatalog({ query, year, sport = "baseball", limit = 12 }) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const args = { query: q, sport, limit };
  if (year) args.year = String(year);
  const data = await mcpCall("search_cards", args);
  return (data?.results || []).map(mapCatalogCard).filter(Boolean);
}

function buildQueryVariants(hints) {
  const player = hints?.players?.[0];
  const year = hints?.years?.[0];
  const brand = hints?.brands?.[0];
  const number = hints?.numbers?.[0]?.number;
  const variants = [];
  const full = [year, brand, player, number ? `#${number}` : null]
    .filter(Boolean)
    .join(" ");
  if (hints?.query) variants.push(hints.query);
  if (full) variants.push(full);
  if (player && year && number) variants.push(`${year} ${player} #${number}`);
  if (player && year && brand) variants.push(`${year} ${brand} ${player}`);
  if (player && year) variants.push(`${year} ${player}`);
  if (player && brand) variants.push(`${brand} ${player}`);
  if (player) variants.push(player);
  // unique
  const seen = new Set();
  return variants.filter((q) => {
    const k = q.toLowerCase();
    if (k.length < 3 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Resolve OCR hints → ranked catalogue matches.
 */
export async function resolveFromHints(hints) {
  const variants = buildQueryVariants(hints);
  const hasPlayer = (hints?.players || []).length > 0;
  const hasStrongMeta =
    (hints?.years || []).length > 0 &&
    ((hints?.brands || []).length > 0 || (hints?.numbers || []).length > 0);
  if (!variants.length || (!hasPlayer && !hasStrongMeta)) {
    return { source: null, cards: [], confidence: null };
  }

  const byId = new Map();
  let confidence = null;
  let parsed = null;
  let usedQuery = null;
  let source = null;

  // Prefer identify_card (structured parse) across query variants
  for (const query of variants) {
    try {
      const identified = await identifyCardDescription(query);
      if (identified.matches.length) {
        source = "mycardfolio-identify";
        usedQuery = usedQuery || query;
        confidence = confidence || identified.confidence;
        parsed = parsed || identified.parsed;
        for (const card of identified.matches) {
          if (!byId.has(card.id)) byId.set(card.id, card);
        }
        // Strong structured hit — still merge a search for visual ranking depth
        break;
      }
    } catch (err) {
      console.warn("identify_card failed:", err.message);
    }
  }

  // Always try a catalogue search for the best player/year query to widen candidates
  try {
    const year = hints?.years?.[0] || null;
    const searchQueries = variants.slice(0, 3);
    for (const query of searchQueries) {
      const results = await searchCatalog({ query, year, limit: 20 });
      if (results.length) {
        source = source || "mycardfolio-search";
        usedQuery = usedQuery || query;
        for (const card of results) {
          if (!byId.has(card.id)) byId.set(card.id, card);
        }
        break;
      }
    }
  } catch (err) {
    console.warn("search_cards failed:", err.message);
    if (!byId.size) {
      return { source: null, cards: [], confidence: null, error: err.message };
    }
  }

  return {
    source,
    cards: [...byId.values()],
    confidence,
    parsed,
    usedQuery,
  };
}
