import { pickHeadline } from "./finish.js";

function formatMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return Number(n);
}

export function normalizeTcgplayerPrices(tcgplayer) {
  if (!tcgplayer?.prices) return [];
  return Object.entries(tcgplayer.prices).map(([variant, prices]) => ({
    source: "TCGPlayer",
    variant,
    low: formatMoney(prices.low),
    mid: formatMoney(prices.mid),
    high: formatMoney(prices.high),
    market: formatMoney(prices.market),
    directLow: formatMoney(prices.directLow),
    currency: "USD",
    url: tcgplayer.url || null,
    updatedAt: tcgplayer.updatedAt || null,
  }));
}

export function normalizeCardmarketPrices(cardmarket) {
  if (!cardmarket?.prices) return [];
  const p = cardmarket.prices;
  return [
    {
      source: "Cardmarket",
      variant: "raw",
      low: formatMoney(p.lowPrice),
      mid: formatMoney(p.averageSellPrice),
      high: null,
      market: formatMoney(p.trendPrice),
      directLow: null,
      currency: "EUR",
      url: cardmarket.url || null,
      updatedAt: cardmarket.updatedAt || null,
    },
  ].filter((row) => row.low != null || row.mid != null || row.market != null);
}

export function bestMarket(priceRows, finishHints) {
  return pickHeadline(priceRows, finishHints);
}

export function mapPokemonTcgCard(card) {
  const prices = [
    ...normalizeTcgplayerPrices(card.tcgplayer),
    ...normalizeCardmarketPrices(card.cardmarket),
  ];
  return {
    id: card.id,
    name: card.name,
    number: card.number,
    rarity: card.rarity || null,
    set: {
      id: card.set?.id,
      name: card.set?.name,
      series: card.set?.series || null,
      printedTotal: card.set?.printedTotal || null,
      releaseDate: card.set?.releaseDate || null,
    },
    images: {
      small: card.images?.small || null,
      large: card.images?.large || null,
    },
    artist: card.artist || null,
    hp: card.hp || null,
    types: card.types || [],
    attacks: (card.attacks || []).map((a) => a.name).filter(Boolean),
    prices,
    headline: bestMarket(prices),
    links: {
      tcgplayer: card.tcgplayer?.url || null,
      cardmarket: card.cardmarket?.url || null,
    },
  };
}
