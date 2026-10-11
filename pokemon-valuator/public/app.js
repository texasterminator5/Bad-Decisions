const fileInput = document.getElementById("file-input");
const libraryInput = document.getElementById("library-input");
const workspace = document.getElementById("workspace");
const previewImg = document.getElementById("preview-img");
const statusEl = document.getElementById("status");
const bestEl = document.getElementById("best-result");
const altsEl = document.getElementById("alt-results");
const errorEl = document.getElementById("error-box");
const hintChips = document.getElementById("hint-chips");
const searchForm = document.getElementById("search-form");
const searchResults = document.getElementById("search-results");

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

function renderBest(card) {
  if (!card) {
    showError(
      "Couldn't match this photo to a catalogue card. Try a sharper shot of the name and collector number, or use manual search below."
    );
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

  const setBits = [
    card.set?.name,
    card.number && card.set?.printedTotal
      ? `${card.number}/${card.set.printedTotal}`
      : card.number
        ? `#${card.number}`
        : null,
    card.rarity,
  ]
    .filter(Boolean)
    .join(" · ");

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
        <span class="amount">${headline ? money(headline.amount, headline.currency) : "n/a"}</span>
        <span class="label">${headline ? `Market · ${escapeHtml(variantLabel(headline.variant))} · ${escapeHtml(headline.currency)}` : "No live market price found"}</span>
      </div>
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
}

function renderAlts(cards, onPick) {
  if (!cards?.length) {
    altsEl.hidden = true;
    altsEl.innerHTML = "";
    return;
  }
  altsEl.hidden = false;
  altsEl.innerHTML = `
    <h4>Other possible matches</h4>
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
                <span>${escapeHtml(c.set?.name || "")}${c.number ? ` · #${escapeHtml(c.number)}` : ""}</span>
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

async function appraiseFile(file) {
  workspace.hidden = false;
  workspace.scrollIntoView({ behavior: "smooth", block: "start" });

  const url = URL.createObjectURL(file);
  previewImg.src = url;
  renderHints(null);
  setLoading("Reading the card…");

  const body = new FormData();
  body.append("image", file);

  try {
    const res = await fetch("/api/appraise", { method: "POST", body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Appraisal failed");

    renderHints(data.hints);
    const cards = data.cards || [];
    let selected = data.best || cards[0] || null;
    renderBest(selected);
    renderAlts(cards.slice(1, 7), (card) => {
      selected = card;
      renderBest(selected);
    });
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
