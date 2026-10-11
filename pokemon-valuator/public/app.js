const fileInput = document.getElementById("file-input");
const libraryInput = document.getElementById("library-input");
const workspace = document.getElementById("workspace");
const previewImg = document.getElementById("preview-img");
const previewEyebrow = document.getElementById("preview-eyebrow");
const statusEl = document.getElementById("status");
const bestEl = document.getElementById("best-result");
const altsEl = document.getElementById("alt-results");
const errorEl = document.getElementById("error-box");
const hintChips = document.getElementById("hint-chips");
const searchForm = document.getElementById("search-form");
const searchResults = document.getElementById("search-results");
const detectionBar = document.getElementById("detection-bar");

let latestDetections = [];
let activeDetectionIndex = 0;

function money(amount, currency = "USD") {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

function variantLabel(v) {
  return String(v || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function setLoading(message) {
  statusEl.hidden = false;
  statusEl.innerHTML = `<div class="spinner" aria-hidden="true"></div><p>${message}</p>`;
  bestEl.hidden = true;
  altsEl.hidden = true;
  errorEl.hidden = true;
}

function showError(message) {
  statusEl.hidden = true;
  bestEl.hidden = true;
  altsEl.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function renderHints(hints) {
  const chips = [];
  for (const n of hints?.names || []) chips.push(n);
  for (const num of hints?.numbers || []) chips.push(num.raw || num.localIdRaw);
  if (hints?.hp) chips.push(`${hints.hp} HP`);

  if (!chips.length) {
    hintChips.hidden = true;
    hintChips.innerHTML = "";
    return;
  }
  hintChips.hidden = false;
  hintChips.innerHTML = chips
    .slice(0, 8)
    .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderBest(card, hints) {
  if (!card) {
    const guess = hints?.names?.[0];
    statusEl.hidden = true;
    bestEl.hidden = true;
    altsEl.hidden = true;
    errorEl.hidden = false;
    errorEl.innerHTML = guess
      ? `Couldn't lock this print. OCR saw <strong>${escapeHtml(guess)}</strong> — try Manual search below, or retake with the name and bottom number sharp.`
      : `Couldn't match this photo. Retake with the card name and collector number sharp and well lit, or use Manual search below.`;
    if (guess && searchForm?.name) {
      searchForm.name.value = guess;
      searchForm.number.value = hints?.numbers?.[0]?.localIdRaw || "";
    }
    return;
  }

  statusEl.hidden = true;
  errorEl.hidden = true;
  bestEl.hidden = false;

  const headline = card.headline;
  const priceRows = (card.prices || [])
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.source)} · ${escapeHtml(variantLabel(p.variant))}</td>
        <td>${money(p.market, p.currency)}</td>
        <td>${money(p.low, p.currency)}</td>
        <td>${money(p.mid, p.currency)}</td>
        <td>${money(p.high, p.currency)}</td>
      </tr>`
    )
    .join("");

  const finishLabel = card.finishHints?.stamped
    ? "Stamped reverse holo"
    : card.finishHints?.reverseHolo
      ? "Reverse holo"
      : null;

  const setBits = [
    card.set?.name,
    card.number && card.set?.printedTotal
      ? `${card.number}/${card.set.printedTotal}`
      : card.number
        ? `#${card.number}`
        : null,
    finishLabel || card.rarity,
  ]
    .filter(Boolean)
    .join(" · ");

  const usdVariants = (card.prices || []).filter(
    (p) => p.source === "TCGPlayer" && p.currency === "USD" && p.market != null
  );
  const variantButtons = usdVariants.length > 1
    ? `<div class="variant-row" role="group" aria-label="Card finish">
        ${usdVariants
          .map((p) => {
            const active =
              headline &&
              p.variant === headline.variant &&
              p.market === headline.amount;
            return `<button type="button" class="variant-btn${active ? " is-active" : ""}" data-variant="${escapeHtml(p.variant)}">${escapeHtml(variantLabel(p.variant))} · ${money(p.market, p.currency)}</button>`;
          })
          .join("")}
      </div>`
    : "";

  const links = [];
  if (card.links?.tcgplayer) {
    links.push(`<a href="${escapeHtml(card.links.tcgplayer)}" target="_blank" rel="noopener">TCGPlayer</a>`);
  }
  if (card.links?.cardmarket) {
    links.push(`<a href="${escapeHtml(card.links.cardmarket)}" target="_blank" rel="noopener">Cardmarket</a>`);
  }

  bestEl.innerHTML = `
    <img class="best-art" src="${escapeHtml(card.images?.large || card.images?.small || "")}" alt="${escapeHtml(card.name)} official card art" />
    <div class="best-meta">
      <h3>${escapeHtml(card.name)}</h3>
      <p class="setline">${escapeHtml(setBits)}</p>
      <div class="price-hero">
        <span class="amount" id="headline-amount">${headline ? money(headline.amount, headline.currency) : "n/a"}</span>
        <span class="label" id="headline-label">${headline ? `Market · ${escapeHtml(variantLabel(headline.variant))} · ${escapeHtml(headline.currency)}` : "No live market price found"}</span>
      </div>
      ${variantButtons}
      ${
        priceRows
          ? `<table class="price-table">
              <thead>
                <tr><th>Source</th><th>Market</th><th>Low</th><th>Mid</th><th>High</th></tr>
              </thead>
              <tbody>${priceRows}</tbody>
            </table>`
          : ""
      }
      ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
    </div>
  `;

  bestEl.querySelectorAll(".variant-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const variant = btn.dataset.variant;
      const row = usdVariants.find((p) => p.variant === variant);
      if (!row) return;
      const amountEl = bestEl.querySelector("#headline-amount");
      const labelEl = bestEl.querySelector("#headline-label");
      if (amountEl) amountEl.textContent = money(row.market, row.currency);
      if (labelEl) {
        labelEl.textContent = `Market · ${variantLabel(row.variant)} · ${row.currency}`;
      }
      bestEl.querySelectorAll(".variant-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });
}

function renderAlts(cards, onPick) {
  if (!cards?.length) {
    altsEl.hidden = true;
    altsEl.innerHTML = "";
    return;
  }
  altsEl.hidden = false;
  altsEl.innerHTML = `
    <h4>Not the right print? Tap the correct one</h4>
    <div class="alt-list">
      ${cards
        .map((c, i) => {
          const price = c.headline
            ? money(c.headline.amount, c.headline.currency)
            : "—";
          return `
            <button type="button" class="alt-item" data-idx="${i}">
              <img src="${escapeHtml(c.images?.small || "")}" alt="" />
              <div>
                <strong>${escapeHtml(c.name)}</strong>
                <span>${escapeHtml(c.set?.name || "")}${c.number ? ` · #${escapeHtml(c.number)}` : ""}${c.rarity ? ` · ${escapeHtml(c.rarity)}` : ""}</span>
              </div>
              <div class="alt-price">${price}</div>
            </button>`;
        })
        .join("")}
    </div>
  `;
  altsEl.querySelectorAll(".alt-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      onPick(cards[idx]);
    });
  });
}

/**
 * Normalize gallery photos (including iPhone HEIC) to JPEG before upload.
 */
async function toUploadableImage(file) {
  if (!file) throw new Error("No photo selected");

  const isHeic = /heic|heif/i.test(file.type) || /\.heic$|\.heif$/i.test(file.name);
  const needsConvert = isHeic || !/^image\/(jpeg|png|webp|gif)$/i.test(file.type);

  if (!needsConvert && file.size < 9 * 1024 * 1024) {
    return file;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(
          new Error(
            isHeic
              ? "Couldn't read that HEIC photo. In iPhone Settings → Camera, set Formats to Most Compatible, or share the photo as JPEG."
              : "Couldn't read that photo. Try a JPG or PNG."
          )
        );
      el.src = objectUrl;
    });

    const maxSide = 2000;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92)
    );
    if (!blob) throw new Error("Couldn't prepare that photo for upload.");
    return new File([blob], "card.jpg", { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function showDetection(detection, index, total) {
  activeDetectionIndex = index;
  if (detection?.previewDataUrl) {
    previewImg.src = detection.previewDataUrl;
  }
  previewEyebrow.textContent =
    total > 1 ? `Card ${index + 1} of ${total}` : "Your photo";

  detectionBar.querySelectorAll(".detection-chip").forEach((chip) => {
    chip.classList.toggle("is-active", Number(chip.dataset.index) === index);
  });

  if (detection?.error) {
    showError(detection.error);
    renderHints(null);
    return;
  }

  renderHints(detection?.hints);
  const cards = detection?.cards || [];
  let selected = detection?.best || cards[0] || null;
  renderBest(selected, detection?.hints);
  renderAlts(cards.slice(1, 7), (card) => {
    selected = card;
    renderBest(selected, detection?.hints);
  });
}

function renderDetectionBar(detections) {
  if (!detections?.length || detections.length < 2) {
    detectionBar.hidden = true;
    detectionBar.innerHTML = "";
    return;
  }

  detectionBar.hidden = false;
  detectionBar.innerHTML = detections
    .map((d, i) => {
      const title = d.best?.name || (d.error ? "Unmatched" : `Card ${i + 1}`);
      const price = d.best?.headline
        ? money(d.best.headline.amount, d.best.headline.currency)
        : d.error
          ? "—"
          : "…";
      return `
        <button type="button" class="detection-chip${i === 0 ? " is-active" : ""}" data-index="${i}">
          <img src="${escapeHtml(d.previewDataUrl || "")}" alt="" />
          <div>
            <strong>${escapeHtml(title)}</strong>
            <span>${price}</span>
          </div>
        </button>`;
    })
    .join("");

  detectionBar.querySelectorAll(".detection-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const idx = Number(chip.dataset.index);
      showDetection(latestDetections[idx], idx, latestDetections.length);
    });
  });
}

async function appraiseFile(file) {
  workspace.hidden = false;
  workspace.scrollIntoView({ behavior: "smooth", block: "start" });

  const previewUrl = URL.createObjectURL(file);
  previewImg.src = previewUrl;
  previewEyebrow.textContent = "Your photo";
  renderHints(null);
  detectionBar.hidden = true;
  detectionBar.innerHTML = "";
  latestDetections = [];
  setLoading("Preparing photo…");

  try {
    const uploadFile = await toUploadableImage(file);
    setLoading("Finding cards in the photo…");

    const body = new FormData();
    body.append("image", uploadFile, uploadFile.name || "card.jpg");

    const res = await fetch("/api/appraise", { method: "POST", body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Appraisal failed");

    latestDetections =
      data.detections?.length
        ? data.detections
        : [
            {
              index: 0,
              previewDataUrl: previewUrl,
              hints: data.hints,
              cards: data.cards || [],
              best: data.best,
              error: null,
            },
          ];

    const count = latestDetections.length;
    setLoading(
      count > 1
        ? `Found ${count} cards — pricing…`
        : "Reading the card…"
    );

    renderDetectionBar(latestDetections);
    showDetection(latestDetections[0], 0, count);
  } catch (err) {
    showError(err.message || "Something went wrong while appraising that photo.");
  }
}

function wireFileInput(input) {
  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) appraiseFile(file);
    input.value = "";
  });
}

wireFileInput(fileInput);
wireFileInput(libraryInput);

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(searchForm);
  const name = String(fd.get("name") || "").trim();
  const number = String(fd.get("number") || "").trim();
  if (!name) return;

  searchResults.hidden = false;
  searchResults.innerHTML = `<div class="status"><div class="spinner"></div><p>Searching…</p></div>`;

  const params = new URLSearchParams({ name });
  if (number) params.set("number", number);

  try {
    const res = await fetch(`/api/search?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");

    const cards = data.cards || [];
    if (!cards.length) {
      searchResults.innerHTML = `<p class="error">No cards matched that query.</p>`;
      return;
    }

    searchResults.innerHTML = cards
      .slice(0, 10)
      .map((c) => {
        const price = c.headline
          ? money(c.headline.amount, c.headline.currency)
          : "—";
        return `
          <button type="button" class="alt-item search-pick" data-id="${escapeHtml(c.id)}">
            <img src="${escapeHtml(c.images?.small || "")}" alt="" />
            <div>
              <strong>${escapeHtml(c.name)}</strong>
              <span>${escapeHtml(c.set?.name || "")}${c.number ? ` · #${escapeHtml(c.number)}` : ""}</span>
            </div>
            <div class="alt-price">${price}</div>
          </button>`;
      })
      .join("");

    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    searchResults.querySelectorAll(".search-pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        workspace.hidden = false;
        previewImg.src = byId[btn.dataset.id]?.images?.large || byId[btn.dataset.id]?.images?.small || "";
        hintChips.hidden = true;
        renderBest(byId[btn.dataset.id]);
        renderAlts(
          cards.filter((c) => c.id !== btn.dataset.id).slice(0, 6),
          (card) => renderBest(card)
        );
        workspace.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  } catch (err) {
    searchResults.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
});
