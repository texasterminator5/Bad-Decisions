/**
 * Infer card finish / stamping from OCR text and simple photo cues.
 * EX-era reverse holos often carry a set-logo stamp in the artwork.
 */
export function detectFinishHints(rawText = "", extras = {}) {
  const text = String(rawText || "");
  const lower = text.toLowerCase();

  const hints = {
    reverseHolo: false,
    stamped: false,
    holofoil: false,
    firstEdition: false,
    confidence: 0,
    reasons: [],
  };

  if (/\breverse\b/.test(lower) || /\breverse\s*holo/.test(lower)) {
    hints.reverseHolo = true;
    hints.confidence += 40;
    hints.reasons.push("ocr:reverse");
  }

  if (/\bstamp(?:ed)?\b/.test(lower) || /\bset[- ]?logo\b/.test(lower)) {
    hints.stamped = true;
    hints.reverseHolo = true;
    hints.confidence += 35;
    hints.reasons.push("ocr:stamp");
  }

  // Set-name stamps printed in the art box (common on EX reverse holos).
  // OCR often only catches a fragment like "FORCES" or "UNSEEN".
  const stampFragments = [
    [/unseen\s*forces/i, 50],
    [/\bforces\b/i, 40],
    [/\bunseen\b/i, 35],
    [/hidden\s*legends/i, 50],
    [/\blegends\b/i, 25],
    [/delta\s*species/i, 50],
    [/firered|leafgreen/i, 40],
    [/team\s*rocket/i, 40],
    [/\bdeoxys\b/i, 40],
    [/\bemerald\b/i, 35],
    [/legend\s*maker/i, 45],
    [/holon\s*phantoms/i, 50],
    [/crystal\s*guardians/i, 50],
    [/dragon\s*frontiers/i, 50],
    [/power\s*keepers/i, 45],
  ];
  for (const [re, pts] of stampFragments) {
    if (re.test(text)) {
      hints.stamped = true;
      hints.reverseHolo = true;
      hints.confidence += pts;
      hints.reasons.push(`ocr:set-stamp:${re.source}`);
      break;
    }
  }

  // Bare "EX" near a set word is a weak stamp signal on EX-era cards
  if (/\bex\b/i.test(text) && /forces|legends|species|guardians|frontiers|keepers|phantoms|deoxys|emerald/i.test(text)) {
    hints.stamped = true;
    hints.reverseHolo = true;
    hints.confidence += 20;
    hints.reasons.push("ocr:ex-set");
  }

  if (/\b1st\b|\bfirst\s*edition\b/i.test(text)) {
    hints.firstEdition = true;
    hints.confidence += 25;
    hints.reasons.push("ocr:1st");
  }

  if (/\bholo(?:foil)?\b/i.test(lower) && !hints.reverseHolo) {
    hints.holofoil = true;
    hints.confidence += 15;
    hints.reasons.push("ocr:holo");
  }

  // Caller can pass set name from a matched card to reinforce stamp detection
  if (extras.setName && stampSets.some((re) => re.test(extras.setName))) {
    // only useful combined with EX/stamp evidence already present
  }

  return hints;
}

/**
 * Pick the headline price row for the inferred finish.
 */
export function pickHeadline(priceRows, finishHints = {}) {
  const usd = (priceRows || []).filter((p) => p.currency === "USD" && p.market != null);
  if (!usd.length) {
    const any = (priceRows || []).find((p) => p.market != null);
    return any
      ? { amount: any.market, currency: any.currency, variant: any.variant }
      : null;
  }

  const find = (...preds) => usd.find((p) => preds.every((fn) => fn(p)));

  let preferred = null;
  if (finishHints.reverseHolo || finishHints.stamped) {
    preferred =
      find((p) => /reverse/i.test(p.variant)) ||
      find((p) => /holo/i.test(p.variant) && /reverse|rh/i.test(p.variant));
  } else if (finishHints.firstEdition) {
    preferred = find((p) => /1st|first/i.test(p.variant));
  } else if (finishHints.holofoil) {
    preferred = find((p) => /holo/i.test(p.variant) && !/reverse/i.test(p.variant));
  }

  if (!preferred) {
    preferred =
      find((p) => /normal/i.test(p.variant)) ||
      find((p) => /holo/i.test(p.variant) && !/reverse/i.test(p.variant)) ||
      usd[0];
  }

  return {
    amount: preferred.market,
    currency: preferred.currency,
    variant: preferred.variant,
  };
}
