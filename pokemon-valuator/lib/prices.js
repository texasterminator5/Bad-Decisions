import { pickHeadline } from "./finish.js";
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
    // Avoid quoted wildcard queries — they intermittently 500 on pokemontcg.io
    const cleaned = name.replace(/[^\w\s'.\-]/g, " ").trim();
    const token = cleaned.split(/\s+/).filter(Boolean)[0];
    if (token) parts.push(`name:${token}*`);
  }
  if (number) {
    const n = String(number).replace(/^0+(\d)/, "$1");
    parts.push(`number:${n}`);
  }
  if (hp) {
    parts.push(`hp:${hp}`);
  }
  return parts.join(" ");
}

async function fetchPokemonTcgCards(q, pageSize) {
  const url = new URL(`${POKEMONTCG_BASE}/cards`);
  url.searchParams.set("q", q);
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("orderBy", "-set.releaseDate");
  const data = await fetchJson(url);
  return (data.data || []).map(mapPokemonTcgCard);
}

export async function searchPokemonTcgByAttack({ attack, hp, pageSize = 20 }) {
  if (!attack) return [];
  const token = String(attack).replace(/[^\w\s'.\-]/g, " ").trim().split(/\s+/)[0];
  if (!token || token.length < 4) return [];

  const queries = [
    hp ? `attacks.name:${token}* hp:${hp}` : null,
    `attacks.name:${token}*`,
    `attacks.name:${token}`,
    `abilities.name:${token}*`,
  ].filter(Boolean);

  for (const q of queries) {
    try {
      const batch = await fetchPokemonTcgCards(q, pageSize);
      if (batch.length) return batch;
    } catch {
      // try next query form
    }
  }
  return [];
}

/**
 * Search the Pokémon TCG API for matching cards.
 */
export async function searchPokemonTcg({ name, number, hp, pageSize = 24 }) {
  const q = buildPokemonTcgQuery({ name, number, hp });
  if (!q) return [];

  try {
    return await fetchPokemonTcgCards(q, pageSize);
  } catch (err) {
    // Retry with simpler name-only query, then bare name
    if (name) {
      const token = name.replace(/[^\w\s'.\-]/g, " ").trim().split(/\s+/)[0];
      const retries = [`name:${token}`, `name:${token}*`];
      for (const retryQ of retries) {
        try {
          let mapped = await fetchPokemonTcgCards(retryQ, pageSize);
          if (number) {
            const num = String(number).replace(/^0+(\d)/, "$1").toLowerCase();
            const filtered = mapped.filter(
              (c) =>
                String(c.number).replace(/^0+(\d)/, "$1").toLowerCase() === num
            );
            if (filtered.length) mapped = filtered;
          }
          if (mapped.length) return mapped;
        } catch {
          // continue
        }
      }
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
 * Merge TCGdex finish prices (esp. reverse-holofoil) onto a mapped card.
 */
export async function enrichCardFinishes(card) {
  if (!card?.id) return card;
  try {
    const detail = await fetchJson(
      `${TCGDEX_BASE}/cards/${encodeURIComponent(card.id)}`
    );
    const tp = detail.pricing?.tcgplayer;
    if (!tp) return card;

    const existing = new Set(
      (card.prices || []).map((p) => `${p.source}:${p.variant}:${p.currency}`)
    );
    const prices = [...(card.prices || [])];

    for (const [variant, row] of Object.entries(tp)) {
      if (
        !row ||
        typeof row !== "object" ||
        !("marketPrice" in row || "lowPrice" in row)
      ) {
        continue;
      }
      const key = `TCGPlayer:${variant}:USD`;
      if (existing.has(key)) continue;
      prices.push({
        source: "TCGPlayer",
        variant,
        low: formatMoney(row.lowPrice),
        mid: formatMoney(row.midPrice),
        high: formatMoney(row.highPrice),
        market: formatMoney(row.marketPrice),
        directLow: formatMoney(row.directLowPrice),
        currency: "USD",
        url: null,
        updatedAt: tp.updated || null,
      });
    }

    // Cardmarket reverse/holo trend when present
    const cm = detail.pricing?.cardmarket;
    if (cm?.["trend-holo"] != null) {
      prices.push({
        source: "Cardmarket",
        variant: "reverseHolo",
        low: formatMoney(cm["low-holo"]),
        mid: formatMoney(cm["avg-holo"]),
        high: null,
        market: formatMoney(cm["trend-holo"]),
        directLow: null,
        currency: cm.unit || "EUR",
        url: null,
        updatedAt: cm.updated || null,
      });
    }

    const stamped =
      Array.isArray(detail.variants_detailed) &&
      detail.variants_detailed.some(
        (v) =>
          /reverse/i.test(v.type || "") &&
          Array.isArray(v.stamp) &&
          v.stamp.length > 0
      );

    return {
      ...card,
      prices,
      finishes: {
        hasReverse: prices.some((p) => /reverse/i.test(p.variant)),
        stampedReverseAvailable: Boolean(stamped),
        variants: detail.variants || null,
      },
      headline: card.headline,
    };
  } catch {
    return card;
  }
}

export function applyFinishHeadline(card, finishHints = {}) {
  if (!card) return card;
  const hints = { ...finishHints };

  // Catalogue knows this print's reverse is the stamped set-logo version
  if (card.finishes?.stampedReverseAvailable) {
    if (finishHints?.stamped || finishHints?.reverseHolo || (finishHints?.confidence || 0) >= 25) {
      hints.stamped = true;
      hints.reverseHolo = true;
    }
  }

  if (finishHints?.stamped || finishHints?.reverseHolo) {
    hints.reverseHolo = true;
  }

  // Reinforce: matched set name appears in stamp OCR reasons / raw cues
  const setName = (card.set?.name || "").toLowerCase();
  if (
    card.finishes?.stampedReverseAvailable &&
    setName &&
    (finishHints?.reasons || []).some((r) => /set-stamp/i.test(r))
  ) {
    hints.stamped = true;
    hints.reverseHolo = true;
  }

  return {
    ...card,
    finishHints: hints,
    headline: pickHeadline(card.prices, hints),
  };
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
    const localId = String(card.localId ?? "");
    const setId = card.set?.id;
    // Fallback art for promo sets that omit TCGdex image URLs
    const ptcgSmall =
      !imageBase && setId && localId
        ? `https://images.pokemontcg.io/${setId}/${localId.replace(/^0+/, "")}.png`
        : null;

    return {
      id: card.id,
      name: card.name,
      number: localId,
      rarity: card.rarity || null,
      set: {
        id: setId,
        name: card.set?.name,
        series: null,
        printedTotal: card.set?.cardCount?.official || null,
        releaseDate: null,
      },
      images: {
        small: imageBase ? `${imageBase}/low.webp` : ptcgSmall,
        large: imageBase ? `${imageBase}/high.webp` : ptcgSmall,
      },
      artist: card.illustrator || null,
      hp: card.hp != null ? String(card.hp) : null,
      types: card.types || [],
      attacks: (card.attacks || []).map((a) => a.name).filter(Boolean),
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

  if (hints.hp && card.hp && String(card.hp) === String(hints.hp)) score += 25;

  const attackHints = (hints.attacks || []).map((a) => a.toLowerCase());
  const cardAttacks = (card.attacks || []).map((a) => a.toLowerCase());
  for (const attack of attackHints) {
    if (cardAttacks.some((a) => a === attack || a.includes(attack) || attack.includes(a))) {
      score += 60;
    }
  }

  const promo = hints.promo || {};
  const setId = String(card.set?.id || card.id || "").toLowerCase();
  const setName = String(card.set?.name || "").toLowerCase();
  if (promo.isPromo) {
    if (/promo|black star|svp|mep/.test(setName) || /(^|-)(svp|mep)(-|$)/.test(setId)) {
      score += 50;
    }
    if (promo.sets?.includes("25th") && /mep|celebrations|25/.test(`${setId} ${setName}`)) {
      score += 35;
    }
    for (const n of promo.numbers || []) {
      const cardNum = String(card.number || "").replace(/^0+/, "");
      if (cardNum && cardNum === String(n).replace(/^0+/, "")) score += 55;
    }
  }

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
  const attacks = hints.attacks || [];

  let results = [];
  let source = "pokemontcg";
  const byId = new Map();

  // Attack + HP is often more reliable than a mangled Pokémon name
  for (const attack of attacks.slice(0, 3)) {
    try {
      const batch = await searchPokemonTcgByAttack({ attack, hp });
      for (const card of batch) {
        if (!byId.has(card.id)) byId.set(card.id, card);
      }
    } catch {
      // continue
    }
  }

  // Prefer the top OCR/dictionary guess; only fall back to weaker names if needed
  for (const name of nameCandidates.slice(0, 3)) {
    try {
      // Search name(+number) without HP first — bad OCR HP was wiping real hits
      let batch = await searchPokemonTcg({ name, number, hp: null });
      if (!batch.length && hp) {
        batch = await searchPokemonTcg({ name, number: null, hp });
      }
      if (!batch.length) {
        batch = await searchPokemonTcg({ name, number: null, hp: null });
      }
      if (number) {
        const num = String(number).replace(/^0+(\d)/, "$1").toLowerCase();
        const filtered = batch.filter(
          (c) =>
            String(c.number).replace(/^0+(\d)/, "$1").toLowerCase() === num
        );
        if (filtered.length) batch = filtered;
      }
      for (const card of batch) {
        if (!byId.has(card.id)) byId.set(card.id, card);
      }
    } catch {
      // continue to TCGdex
    }

    // Always merge TCGdex for the primary name — catches promo sets
    // (e.g. MEP / SVP) missing from pokemontcg.io.
    try {
      const fallback = await searchTcgdex({
        name,
        number: name === nameCandidates[0] ? number : null,
        limit: name === nameCandidates[0] ? 24 : 8,
      });
      for (const card of fallback) {
        if (!byId.has(card.id)) byId.set(card.id, card);
      }
      if (fallback.length) source = source || "tcgdex";
    } catch {
      // try next name
    }

    if (byId.size && name === nameCandidates[0]) break;
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
