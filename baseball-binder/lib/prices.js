/**
 * Market values from SportsCardsPro (PriceCharting's sports sister site).
 * Fetched via Python helper — Node's fetch is often blocked by Cloudflare.
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "fetch_prices.py");

function ebaySoldUrl(query) {
  const q = encodeURIComponent(query);
  return `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1&_sop=13`;
}

function sportscardsproSearchUrl(query) {
  const q = encodeURIComponent(query);
  return `https://www.sportscardspro.com/search-products?q=${q}&type=prices`;
}

const priceCache = new Map();
const PRICE_CACHE_TTL_MS = 30 * 60 * 1000;

function runPriceFetch(query) {
  const key = query.toLowerCase().trim();
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < PRICE_CACHE_TTL_MS) {
    return Promise.resolve(cached.data);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SCRIPT, query], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (code !== 0 && !parsed.results) {
          reject(new Error(parsed.error || stderr || `fetch_prices exited ${code}`));
          return;
        }
        priceCache.set(key, { at: Date.now(), data: parsed });
        resolve(parsed);
      } catch {
        reject(new Error(stderr || `Bad price JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

function scoreRow(row, { name, year, number, product }) {
  let score = 0;
  const hay = `${row.title} ${row.setName}`.toLowerCase();
  if (row.isBaseball) score += 8;
  if (year && hay.includes(String(year))) score += 5;
  if (product) {
    const bits = String(product).toLowerCase().split(/\s+/);
    for (const b of bits) {
      if (b.length > 2 && hay.includes(b)) score += 2;
    }
  }
  if (number) {
    const n = String(number).replace(/^#/, "").toLowerCase();
    if (hay.includes(`#${n}`) || hay.includes(` ${n}`) || row.title.endsWith(`#${n}`)) {
      score += 6;
    }
  }
  if (name) {
    const tokens = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9\s.]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && t !== "jr" && t !== "sr");
    for (const t of tokens) {
      if (hay.includes(t)) score += 3;
    }
  }
  // Prefer rows that actually have a mid/low price
  if (row.mid != null || row.low != null) score += 2;
  return score;
}

/**
 * When OCR only got a player name, seed candidates from SportsCardsPro titles.
 */
export async function seedCandidatesFromPriceSearch(query) {
  const q = String(query || "").trim();
  if (q.length < 3) return [];
  try {
    const fetched = await runPriceFetch(q);
    let rows = (fetched.results || []).filter((r) => r.isBaseball);
    if (!rows.length) rows = fetched.results || [];
    return rows.slice(0, 12).map((r) => {
      const yearMatch = String(r.setName || "").match(/\b((?:19|20)\d{2})\b/);
      const setClean = String(r.setName || "")
        .replace(/\(\s*Baseball\s*\)/i, "")
        .replace(/\b(?:19|20)\d{2}\b/, "")
        .trim();
      const numMatch = String(r.title || "").match(/#\s*([A-Za-z0-9-]+)/);
      const name = String(r.title || "")
        .replace(/#\s*[A-Za-z0-9-]+/g, "")
        .replace(/\[[^\]]*\]/g, "")
        .trim();
      return {
        id: `scp-${r.id}`,
        name: name || q,
        year: yearMatch ? yearMatch[1] : null,
        product: setClean || null,
        set: setClean || null,
        number: numMatch ? numMatch[1] : null,
        sport: "Baseball",
        details: "",
        team: null,
        url: r.url,
        image: null,
        source: "SportsCardsPro",
        seedPrices: {
          low: r.low,
          mid: r.mid,
          high: r.high,
          url: r.url,
          title: r.title,
          setName: r.setName,
        },
      };
    });
  } catch (err) {
    console.warn("seed price search failed:", err.message);
    return [];
  }
}

/**
 * Look up guide prices for an identified card.
 */
export async function lookupPrices(card) {
  const name = card?.name || "";
  const year = card?.year || "";
  const product = card?.product || "";
  const number = card?.number || "";
  const query = [year, product, name, number ? `#${number}` : null]
    .filter(Boolean)
    .join(" ")
    .trim();

  const links = {
    ebaySold: ebaySoldUrl(query || name),
    sportscardspro: sportscardsproSearchUrl(query || name),
    catalog: card?.url || null,
  };

  // Reuse prices already attached from seed search
  if (card?.seedPrices && (card.seedPrices.mid != null || card.seedPrices.low != null)) {
    const sp = card.seedPrices;
    const prices = [];
    if (sp.low != null) {
      prices.push({
        source: "SportsCardsPro",
        variant: "Low (raw)",
        market: sp.low,
        low: sp.low,
        mid: sp.mid,
        high: sp.high,
        currency: "USD",
      });
    }
    if (sp.mid != null) {
      prices.push({
        source: "SportsCardsPro",
        variant: "Mid (near mint / grade ~9)",
        market: sp.mid,
        low: sp.low,
        mid: sp.mid,
        high: sp.high,
        currency: "USD",
      });
    }
    if (sp.high != null) {
      prices.push({
        source: "SportsCardsPro",
        variant: "High (gem / PSA 10 guide)",
        market: sp.high,
        low: sp.low,
        mid: sp.mid,
        high: sp.high,
        currency: "USD",
      });
    }
    return {
      headline: {
        amount: sp.mid ?? sp.low ?? sp.high,
        currency: "USD",
        variant: sp.mid != null ? "Mid guide" : "Low guide",
        label: sp.title || card.name,
        setName: sp.setName || card.set,
        url: sp.url || card.url,
      },
      prices,
      matches: [],
      links: {
        ...links,
        sportscardspro: sp.url || links.sportscardspro,
      },
      error: null,
    };
  }

  if (!query || query.length < 4) {
    return {
      headline: null,
      prices: [],
      matches: [],
      links,
      error: "Not enough detail to price",
    };
  }

  try {
    const fetched = await runPriceFetch(query);
    if (fetched.error && !(fetched.results || []).length) {
      throw new Error(fetched.error);
    }
    let rows = fetched.results || [];
    // Prefer baseball
    const baseball = rows.filter((r) => r.isBaseball);
    if (baseball.length) rows = baseball;

    rows = rows
      .map((r) => ({ ...r, score: scoreRow(r, { name, year, number, product }) }))
      .sort((a, b) => b.score - a.score);

    const best = rows[0] || null;
    const prices = [];
    if (best) {
      if (best.low != null) {
        prices.push({
          source: "SportsCardsPro",
          variant: "Low (raw)",
          market: best.low,
          low: best.low,
          mid: best.mid,
          high: best.high,
          currency: "USD",
        });
      }
      if (best.mid != null) {
        prices.push({
          source: "SportsCardsPro",
          variant: "Mid (near mint / grade ~9)",
          market: best.mid,
          low: best.low,
          mid: best.mid,
          high: best.high,
          currency: "USD",
        });
      }
      if (best.high != null) {
        prices.push({
          source: "SportsCardsPro",
          variant: "High (gem / PSA 10 guide)",
          market: best.high,
          low: best.low,
          mid: best.mid,
          high: best.high,
          currency: "USD",
        });
      }
    }

    const headline = best
      ? {
          amount: best.mid ?? best.low ?? best.high,
          currency: "USD",
          variant:
            best.mid != null
              ? "Mid guide"
              : best.low != null
                ? "Low guide"
                : "High guide",
          label: best.title,
          setName: best.setName,
          url: best.url,
        }
      : null;

    return {
      headline,
      prices,
      matches: rows.slice(0, 5).map((r) => ({
        title: r.title,
        setName: r.setName,
        url: r.url,
        low: r.low,
        mid: r.mid,
        high: r.high,
        score: r.score,
      })),
      links: {
        ...links,
        sportscardspro: best?.url || links.sportscardspro,
      },
      error: null,
    };
  } catch (err) {
    console.warn("price lookup failed:", err.message);
    return {
      headline: null,
      prices: [],
      matches: [],
      links,
      error: err.message || "Price lookup failed",
    };
  }
}

/**
 * Attach pricing onto a catalogue card object.
 */
export async function enrichWithPrices(card) {
  const pricing = await lookupPrices(card);
  return {
    ...card,
    headline: pricing.headline,
    prices: pricing.prices,
    priceMatches: pricing.matches,
    links: {
      catalog: card.url,
      ebaySold: pricing.links.ebaySold,
      sportscardspro: pricing.links.sportscardspro,
    },
    priceError: pricing.error,
  };
}
