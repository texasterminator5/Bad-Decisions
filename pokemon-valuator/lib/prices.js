import { bestMarket, mapPokemonTcgCard } from "./mapCard.js";

const POKEMONTCG_BASE = "https://api.pokemontcg.io/v2";
const TCGDEX_BASE = "https://api.tcgdex.net/v2/en";

function formatMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return Number(n);
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upstream ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function buildPokemonTcgQuery({ name, number, hp }) {
  const parts = [];
  if (name) {
    const cleaned = name.replace(/[^\w\s'.\-]/g, " ").trim();
    parts.push(`name:"*${cleaned}*"`);
  }
  if (number) {
    const n = String(number).replace(/^0+(\d)/, "$1");
    parts.push(`number:"${n}"`);
  }
  if (hp) {
    parts.push(`hp:${hp}`);
  }
  return parts.join(" ");
}

/**
 * Search the Pokémon TCG API for matching cards.
 */
export async function searchPokemonTcg({ name, number, hp, pageSize = 12 }) {
  const q = buildPokemonTcgQuery({ name, number, hp });
  if (!q) return [];

  const url = new URL(`${POKEMONTCG_BASE}/cards`);
  url.searchParams.set("q", q);
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("orderBy", "-set.releaseDate");

  try {
    const data = await fetchJson(url);
    return (data.data || []).map(mapPokemonTcgCard);
  } catch (err) {
    if (name && number) {
      const fallback = new URL(`${POKEMONTCG_BASE}/cards`);
      fallback.searchParams.set("q", `name:"*${name}*"`);
      fallback.searchParams.set("pageSize", String(pageSize));
      const data = await fetchJson(fallback);
      const mapped = (data.data || []).map(mapPokemonTcgCard);
      const num = String(number).replace(/^0+(\d)/, "$1").toLowerCase();
      const filtered = mapped.filter(
        (c) => String(c.number).replace(/^0+(\d)/, "$1").toLowerCase() === num
      );
      return filtered.length ? filtered : mapped;
    }
    throw err;
  }
}

export async function getPokemonTcgCard(id) {
  const data = await fetchJson(
    `${POKEMONTCG_BASE}/cards/${encodeURIComponent(id)}`
  );
  return mapPokemonTcgCard(data.data);
}

/**
 * Search TCGdex (no key) and hydrate pricing from detail endpoints.
 */
export async function searchTcgdex({ name, number, limit = 8 }) {
  if (!name) return [];
  const listUrl = new URL(`${TCGDEX_BASE}/cards`);
  listUrl.searchParams.set("name", name);

  const list = await fetchJson(listUrl);
  let candidates = Array.isArray(list) ? list : [];

  if (number) {
    const num = String(number).replace(/^0+(\d)/, "$1").toLowerCase();
    const filtered = candidates.filter((c) => {
      const local = String(c.localId || "")
        .replace(/^0+(\d)/, "$1")
        .toLowerCase();
      return local === num;
    });
    if (filtered.length) candidates = filtered;
  }

  candidates = candidates.slice(0, limit);

  const details = await Promise.all(
    candidates.map(async (c) => {
      try {
        return await fetchJson(`${TCGDEX_BASE}/cards/${encodeURIComponent(c.id)}`);
      } catch {
        return null;
      }
    })
  );

  return details.filter(Boolean).map((card) => {
    const prices = [];
    const tp = card.pricing?.tcgplayer;
    if (tp) {
      for (const [variant, row] of Object.entries(tp)) {
        if (
          !row ||
          typeof row !== "object" ||
          !("marketPrice" in row || "lowPrice" in row)
        ) {
          continue;
        }
        prices.push({
          source: "TCGPlayer",
          variant,
          low: formatMoney(row.lowPrice),
          mid: formatMoney(row.midPrice),
          high: formatMoney(row.highPrice),
          market: formatMoney(row.marketPrice),
          directLow: formatMoney(row.directLowPrice),
          currency: tp.unit || "USD",
          url: null,
          updatedAt: tp.updated || null,
        });
      }
    }
    const cm = card.pricing?.cardmarket;
    if (cm) {
      prices.push({
        source: "Cardmarket",
        variant: "raw",
        low: formatMoney(cm.low),
        mid: formatMoney(cm.avg),
        high: null,
        market: formatMoney(cm.trend),
        directLow: null,
        currency: cm.unit || "EUR",
        url: null,
        updatedAt: cm.updated || null,
      });
    }

    const imageBase = card.image || null;
    return {
      id: card.id,
      name: card.name,
      number: String(card.localId ?? ""),
      rarity: card.rarity || null,
      set: {
        id: card.set?.id,
        name: card.set?.name,
        series: null,
        printedTotal: card.set?.cardCount?.official || null,
        releaseDate: null,
      },
      images: {
        small: imageBase ? `${imageBase}/low.webp` : null,
        large: imageBase ? `${imageBase}/high.webp` : null,
      },
      artist: card.illustrator || null,
      hp: card.hp != null ? String(card.hp) : null,
      types: card.types || [],
      prices,
      headline: bestMarket(prices),
      links: { tcgplayer: null, cardmarket: null },
    };
  });
}

function scoreMatch(card, hints) {
  let score = 0;
  const nameHints = (hints.names || []).map((n) => n.toLowerCase());
  const cardName = (card.name || "").toLowerCase();

  nameHints.forEach((n, idx) => {
    const recencyBonus = Math.max(0, 12 - idx * 3);
    if (cardName === n) score += 50 + recencyBonus;
    else if (cardName.includes(n) || n.includes(cardName)) score += 28 + recencyBonus;
    else {
      const a = new Set(cardName.split(/\s+/));
      const b = n.split(/\s+/);
      const overlap = b.filter((t) => a.has(t)).length;
      score += overlap * 8;
    }
  });

  if (hints.numbers?.length) {
    const cardNum = String(card.number || "")
      .replace(/^0+(\d)/, "$1")
      .toLowerCase();
    for (const num of hints.numbers) {
      const hintNum = String(num.localIdRaw || num.localId || "")
        .replace(/^0+(\d)/, "$1")
        .toLowerCase();
      if (cardNum === hintNum) {
        score += 55;
        if (
          num.printedTotal &&
          card.set?.printedTotal &&
          String(card.set.printedTotal) === String(Number(num.printedTotal) || num.printedTotal)
        ) {
          score += 45;
        }
      }
    }
  }

  if (hints.hp && card.hp && String(card.hp) === String(hints.hp)) score += 15;
  if (card.headline?.amount != null) score += 2;
  return score;
}

/**
 * Resolve the best card matches from OCR hints and/or a manual query.
 */
export async function resolveCards(hints = {}) {
  const nameCandidates = [
    ...(hints.names || []),
    hints.name || null,
  ].filter(Boolean);
  const number = hints.numbers?.[0]?.localIdRaw || hints.number || null;
  const printedTotal = hints.numbers?.[0]?.printedTotal || null;
  const hp = hints.hp || null;

  let results = [];
  let source = "pokemontcg";
  const byId = new Map();

  // Merge hits across top name candidates, then rank globally
  for (const name of nameCandidates.slice(0, 4)) {
    try {
      let batch = await searchPokemonTcg({ name, number, hp });
      if (!batch.length) {
        batch = await searchPokemonTcg({ name, number: null, hp: null });
        if (number) {
          const num = String(number).replace(/^0+(\d)/, "$1").toLowerCase();
          const filtered = batch.filter(
            (c) =>
              String(c.number).replace(/^0+(\d)/, "$1").toLowerCase() === num
          );
          if (filtered.length) batch = filtered;
        }
      }
      for (const card of batch) {
        if (!byId.has(card.id)) byId.set(card.id, card);
      }
    } catch {
      // try next name
    }
  }

  results = [...byId.values()];

  if (!results.length && nameCandidates[0]) {
    source = "tcgdex";
    results = await searchTcgdex({
      name: nameCandidates[0],
      number,
    });
  }

  // Last resort: number + HP (+ printed total) without a clean name
  if (!results.length && number) {
    try {
      const qParts = [`number:"${String(number).replace(/^0+(\d)/, "$1")}"`];
      if (hp) qParts.push(`hp:${hp}`);
      const url = new URL(`${POKEMONTCG_BASE}/cards`);
      url.searchParams.set("q", qParts.join(" "));
      url.searchParams.set("pageSize", "20");
      const data = await fetchJson(url);
      results = (data.data || []).map(mapPokemonTcgCard);
      if (printedTotal) {
        const filtered = results.filter(
          (c) => String(c.set?.printedTotal) === String(Number(printedTotal) || printedTotal)
        );
        if (filtered.length) results = filtered;
      }
      source = "pokemontcg";
    } catch {
      // ignore
    }
  }

  const ranked = results
    .map((card) => ({ ...card, matchScore: scoreMatch(card, hints) }))
    .sort(
      (a, b) =>
        b.matchScore - a.matchScore ||
        (b.headline?.amount || 0) - (a.headline?.amount || 0)
    );

  return { source, cards: ranked };
}
