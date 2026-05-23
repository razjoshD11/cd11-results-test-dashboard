// CD-11 public results map.
// Three map layers, one per toggle:
//   ./data/cd11_precincts.geojson  -> precinct polygons (Precinct view)
//   ./data/sup_districts.geojson   -> 11 supervisor-district polygons (Supervisor district view)
//   ./data/cd11_outline.geojson    -> single CD-11 outline (All CD-11 view)
// Toggling swaps the geometry layer, so precinct lines are replaced by the
// coarser boundaries rather than merely recolored.
// Plus:
//   ./data/<snapshot>.json         -> public-safe results slice
//   ./data/candidates.json         -> photos + bios + _display config

(() => {
  const REFRESH_MS = 60 * 1000;
  const GEOJSON_URLS = {
    precinct: "./data/cd11_precincts.geojson",
    sup: "./data/sup_districts.geojson",
    cd11: "./data/cd11_outline.geojson",
  };
  // TEST HARNESS: the snapshot file is selectable via the switcher bar.
  // Production uses a fixed "./data/latest.json"; the rest is unchanged.
  let DATA_URL = "./data/drop1.json";
  const CANDIDATES_URL = "./data/candidates.json";

  const PALETTE = ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB"];

  const els = {
    lastUpdate: document.getElementById("last-update"),
    ballotsCounted: document.getElementById("ballots-counted"),
    citywide: document.getElementById("citywide-strip"),
    map: document.getElementById("results-map"),
    statusBanner: document.getElementById("status-banner"),
    detail: document.getElementById("candidate-detail"),
    detailTitle: document.getElementById("detail-title"),
    detailBody: document.getElementById("detail-body"),
    closeDetail: document.getElementById("close-detail"),
    toggleButtons: document.querySelectorAll(".map-toggle button"),
  };

  let leafletMap = null;
  const geo = { precinct: null, sup: null, cd11: null };     // raw GeoJSON
  const layers = { precinct: null, sup: null, cd11: null };  // Leaflet layers
  let activeKey = null;
  let didFit = false;
  let analysisByPrecinct = new Map();
  let lastData = null;
  let candidates = null;
  let leaderColorMap = new Map();
  let granularity = "precinct";
  let legendControl = null;
  let displayConfig = { mode: "all" };
  let precinctToSD = new Map();  // precinct id -> supervisor_district (from precinct GeoJSON)
  let nbhdLabels = null;         // [{name, lat, lon}]
  let labelLayer = null;         // always-on neighborhood name labels

  function initMap() {
    leafletMap = L.map(els.map, { zoomControl: true, scrollWheelZoom: true }).setView([37.7649, -122.4394], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap, &copy; CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(leafletMap);
  }

  els.toggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.toggleButtons.forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      granularity = btn.dataset.granularity;
      showActiveLayer();
      renderLegend();
    });
  });
  els.closeDetail.addEventListener("click", () => els.detail.classList.add("hidden"));

  async function tick() {
    try {
      for (const key of Object.keys(GEOJSON_URLS)) {
        if (geo[key]) continue;
        const res = await fetch(GEOJSON_URLS[key], { cache: "no-store" });
        if (res.ok) geo[key] = await res.json();
      }
      if (geo.precinct && precinctToSD.size === 0) {
        precinctToSD = new Map(
          (geo.precinct.features || []).map((f) => [f.properties?.precinct, f.properties?.supervisor_district])
        );
      }
      if (!nbhdLabels) {
        const lRes = await fetch("./data/neighborhood_labels.json", { cache: "no-store" });
        if (lRes.ok) { nbhdLabels = await lRes.json(); buildLabels(); }
      }
      buildLayers();

      if (!candidates) {
        const cRes = await fetch(CANDIDATES_URL, { cache: "no-store" });
        if (cRes.ok) {
          const raw = await cRes.json();
          candidates = {};
          if (raw._display && typeof raw._display === "object") displayConfig = raw._display;
          for (const [key, value] of Object.entries(raw)) {
            if (key.startsWith("_")) continue;
            candidates[key.toUpperCase()] = value;
            const lastName = key.split(",")[0].trim().toUpperCase();
            if (lastName && !candidates[lastName]) candidates[lastName] = value;
          }
        }
      }
      const r = await fetch(DATA_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      render(await r.json());
    } catch (err) {
      console.warn("[public-map] tick failed:", err.message);
    }
  }

  function render(data) {
    lastData = data;
    analysisByPrecinct = new Map((data.precincts || []).map((p) => [p.precinct, p]));

    els.lastUpdate.textContent = `Last update: ${formatTimestamp(data.timestamp)}`;
    els.ballotsCounted.textContent = `Ballots counted: ${data.progress?.counted?.toLocaleString() || "—"}`;

    // Reflect certification both ways — never latch on "CERTIFIED FINAL".
    if (data.certified) {
      els.statusBanner.textContent = "CERTIFIED FINAL";
      els.statusBanner.classList.add("certified");
    } else {
      els.statusBanner.textContent = "PRELIMINARY — RESULTS WILL CHANGE AS BALLOTS ARE COUNTED";
      els.statusBanner.classList.remove("certified");
    }

    buildLeaderColorMap(data.candidates || []);
    renderCitywide(data.candidates || []);
    restyleActive();
    updateTooltips();
    renderLegend();
  }

  function buildLeaderColorMap(cands) {
    leaderColorMap = new Map();
    const sorted = [...cands].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    sorted.forEach((c, i) => leaderColorMap.set(c.name, PALETTE[i % PALETTE.length]));
  }

  function nameTokens(name) {
    return new Set(String(name).toUpperCase().split(/[\s,]+/).filter((t) => t.length > 2));
  }

  // Reduce a sorted [name, votes] list to the candidates the dashboard should show.
  function pickDisplay(sortedEntries) {
    const mode = displayConfig?.mode;
    if (mode === "topN") {
      return sortedEntries.slice(0, displayConfig.n || sortedEntries.length);
    }
    if (mode === "featured" && Array.isArray(displayConfig.featured)) {
      const byName = new Map(sortedEntries.map((e) => [e[0].toUpperCase(), e]));
      const out = [];
      for (const want of displayConfig.featured) {
        const upper = want.toUpperCase();
        if (byName.has(upper)) { out.push(byName.get(upper)); continue; }
        const wantTok = nameTokens(want);
        const hit = sortedEntries.find(([n]) => {
          const t = nameTokens(n);
          return [...wantTok].some((x) => t.has(x));
        });
        if (hit && !out.includes(hit)) out.push(hit);
      }
      return out.length ? out : sortedEntries;
    }
    return sortedEntries;
  }

  function renderCitywide(cands) {
    if (!cands.length) return;
    const total = cands.reduce((acc, c) => acc + (c.votes || 0), 0) || 1;
    const sorted = [...cands].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    const shown = pickDisplay(sorted.map((c) => [c.name, c.votes || 0]));
    const label = lastData?.certified ? "Citywide certified:" : "Citywide preliminary:";
    els.citywide.innerHTML = `<strong>${label}</strong> ` +
      shown.map(([name, votes]) => `<span class="citywide-row">
        <span class="swatch" style="background:${leaderColorMap.get(name)}"></span>
        ${escapeHtml(name)} ${((votes / total) * 100).toFixed(1)}%
      </span>`).join("");
  }

  // ---- layers ---------------------------------------------------------------

  function buildLayers() {
    if (!leafletMap) return;
    for (const key of Object.keys(GEOJSON_URLS)) {
      if (layers[key] || !geo[key]) continue;
      layers[key] = L.geoJSON(geo[key], {
        style: (feature) => styleFor(key, feature),
        onEachFeature: (feature, layer) => {
          layer.on("click", () => openPanel(key, feature.properties || {}));
          layer.bindTooltip(tooltipFor(key, feature.properties || {}), { sticky: true });
        },
      });
    }
    showActiveLayer();
  }

  // Always-on neighborhood name labels (independent of the toggle layer).
  function buildLabels() {
    if (!leafletMap || !nbhdLabels || labelLayer) return;
    labelLayer = L.layerGroup();
    for (const lab of nbhdLabels) {
      const icon = L.divIcon({
        className: "nbhd-label",
        html: escapeHtml(lab.name),
        iconSize: [0, 0],   // let the text size itself; anchor at the point
      });
      L.marker([lab.lat, lab.lon], { icon, interactive: false, keyboard: false }).addTo(labelLayer);
    }
    labelLayer.addTo(leafletMap);
  }

  function showActiveLayer() {
    if (!leafletMap) return;
    const key = granularity in layers ? granularity : "precinct";
    if (!layers[key]) return;
    if (activeKey && activeKey !== key && layers[activeKey]) leafletMap.removeLayer(layers[activeKey]);
    if (!leafletMap.hasLayer(layers[key])) layers[key].addTo(leafletMap);
    activeKey = key;
    restyleActive();
    updateTooltips();
    if (!didFit) {
      try { leafletMap.fitBounds(layers[key].getBounds(), { padding: [10, 10] }); didFit = true; } catch (e) { /* empty */ }
    }
  }

  function restyleActive() {
    if (activeKey && layers[activeKey]) layers[activeKey].setStyle((feature) => styleFor(activeKey, feature));
  }

  // Leader for a given layer feature.
  function leaderFor(key, props) {
    if (key === "precinct") return analysisByPrecinct.get(props.precinct)?.leader || null;
    if (key === "sup") return leaderInSupDistrict(props.supervisor_district);
    if (key === "cd11") {
      const sorted = [...(lastData?.candidates || [])].sort((a, b) => (b.votes || 0) - (a.votes || 0));
      return sorted[0]?.name || null;
    }
    return null;
  }

  function styleFor(key, feature) {
    const props = feature.properties || {};
    const leader = leaderFor(key, props);
    if (key === "precinct") {
      const base = { weight: 1.4, color: "#2a2a2a", fillOpacity: 0.4, fillColor: "#e0e0e0" };
      if (!analysisByPrecinct.get(props.precinct)) { base.fillOpacity = 0.08; base.weight = 1; return base; }
      base.fillColor = leaderColorMap.get(leader) || "#888";
      return base;
    }
    if (key === "sup") {
      return { weight: 3, color: "#1a1a1a", fillOpacity: leader ? 0.32 : 0.08, fillColor: leaderColorMap.get(leader) || "#bbb" };
    }
    // cd11 outline
    return { weight: 3.5, color: "#111", fillOpacity: leader ? 0.28 : 0.08, fillColor: leaderColorMap.get(leader) || "#bbb" };
  }

  function tooltipFor(key, props) {
    const leader = leaderFor(key, props);
    let title;
    if (key === "precinct") title = props.precinct_full_name || `PCT ${props.precinct}`;
    else if (key === "sup") title = `Supervisor District ${props.supervisor_district}`;
    else title = "All CD-11";
    if (!leader) return escapeHtml(title);
    const pct = leadingPct(key, props, leader);
    return `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(leader)} ${pct.toFixed(1)}%`;
  }

  // Leading candidate's share for a feature.
  function leadingPct(key, props, leader) {
    if (key === "precinct") {
      const d = analysisByPrecinct.get(props.precinct);
      return d && d.total_votes ? ((d.candidates?.[leader] || 0) / d.total_votes) * 100 : 0;
    }
    if (key === "sup") {
      const tally = tallySupDistrict(props.supervisor_district);
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      return total ? ((tally[leader] || 0) / total) * 100 : 0;
    }
    const cw = lastData?.candidates || [];
    const total = cw.reduce((a, c) => a + (c.votes || 0), 0);
    const me = cw.find((c) => c.name === leader);
    return total && me ? (me.votes / total) * 100 : 0;
  }

  function updateTooltips() {
    if (!activeKey || !layers[activeKey]) return;
    layers[activeKey].eachLayer((layer) => {
      const props = layer.feature?.properties || {};
      layer.setTooltipContent(tooltipFor(activeKey, props));
    });
  }

  // ---- supervisor-district aggregation (reads SD from the precinct GeoJSON) --

  function tallySupDistrict(sd) {
    const tally = {};
    if (sd == null || !lastData?.precincts) return tally;
    for (const p of lastData.precincts) {
      if (String(precinctToSD.get(p.precinct)) !== String(sd)) continue;
      for (const [cand, votes] of Object.entries(p.candidates || {})) {
        tally[cand] = (tally[cand] || 0) + votes;
      }
    }
    return tally;
  }

  function leaderInSupDistrict(sd) {
    const tally = tallySupDistrict(sd);
    let best = null, bestVotes = -1;
    for (const [c, v] of Object.entries(tally)) if (v > bestVotes) { best = c; bestVotes = v; }
    return best;
  }

  // ---- side panels ----------------------------------------------------------

  function candidateRows(candObj, total) {
    const sorted = Object.entries(candObj || {}).sort(([, a], [, b]) => b - a);
    return pickDisplay(sorted).map(([name, votes]) => {
      const pct = total ? (votes / total) * 100 : 0;
      const meta = lookupCandidate(name);
      const photo = meta.photo
        ? `<img class="photo" src="${meta.photo}" alt="">`
        : `<div class="photo">${escapeHtml(initials(name))}</div>`;
      const bio = meta.bio ? `<div class="bio">${escapeHtml(meta.bio)}</div>` : "";
      return `<div class="candidate-row">
        ${photo}
        <div class="info">
          <div class="name">${escapeHtml(name)}</div>
          ${bio}
        </div>
        <div class="num">
          <div class="pct">${pct.toFixed(1)}%</div>
          <div class="votes">${votes.toLocaleString()}</div>
        </div>
        <div class="bar-container"><div class="bar" style="width:${pct}%;background:${leaderColorMap.get(name) || "#888"}"></div></div>
      </div>`;
    }).join("");
  }

  function panelFooter() {
    const certified = lastData?.certified ? "Certified final." : "Preliminary until certified.";
    return `<p style="font-size:0.8rem;color:var(--color-muted);margin-top:1rem">Updated ${formatTimestamp(lastData?.timestamp)}. ${certified}</p>`;
  }

  function panelHeader(total) {
    return `<p style="font-size:0.85rem;color:var(--color-muted);margin:0.5rem 0">Total ballots counted: <strong>${total.toLocaleString()}</strong></p>`;
  }

  function openPanel(key, props) {
    if (key === "sup") return openSupPanel(props.supervisor_district);
    if (key === "cd11") return openCitywidePanel();
    return openPrecinctPanel(props);
  }

  function openPrecinctPanel(props) {
    const data = analysisByPrecinct.get(props.precinct);
    els.detailTitle.textContent = props.precinct_full_name || `PCT ${props.precinct}`;
    if (!data) {
      els.detailBody.innerHTML = `<p class="placeholder">No data yet for this precinct.</p>`;
      els.detail.classList.remove("hidden");
      return;
    }
    const total = data.total_votes || 1;
    const nb = props.neighborhood
      ? `<p style="font-size:0.8rem;color:var(--color-muted);margin:0 0 0.25rem">${escapeHtml(props.neighborhood)}</p>`
      : "";
    els.detailBody.innerHTML = `${nb}${panelHeader(total)}${candidateRows(data.candidates, total)}${panelFooter()}`;
    els.detail.classList.remove("hidden");
  }

  function openSupPanel(sd) {
    const tally = tallySupDistrict(sd);
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    els.detailTitle.textContent = sd != null ? `Supervisor District ${sd}` : "Supervisor district";
    if (!total) {
      els.detailBody.innerHTML = `<p class="placeholder">No data yet for this district.</p>`;
      els.detail.classList.remove("hidden");
      return;
    }
    els.detailBody.innerHTML = `${panelHeader(total)}${candidateRows(tally, total)}${panelFooter()}`;
    els.detail.classList.remove("hidden");
  }

  function openCitywidePanel() {
    const tally = {};
    for (const c of lastData?.candidates || []) tally[c.name] = c.votes || 0;
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    els.detailTitle.textContent = "All CD-11 — Citywide";
    if (!total) {
      els.detailBody.innerHTML = `<p class="placeholder">No results yet.</p>`;
      els.detail.classList.remove("hidden");
      return;
    }
    els.detailBody.innerHTML = `${panelHeader(total)}${candidateRows(tally, total)}${panelFooter()}`;
    els.detail.classList.remove("hidden");
  }

  // ---- legend ---------------------------------------------------------------

  function renderLegend() {
    if (!leafletMap || !leaderColorMap.size) return;
    if (legendControl) { legendControl.remove(); legendControl = null; }
    const sorted = [...(lastData?.candidates || [])].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    const shown = pickDisplay(sorted.map((c) => [c.name, c.votes || 0]));
    if (!shown.length) return;
    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
      const div = L.DomUtil.create("div", "legend");
      div.innerHTML = `<strong>Race leader</strong>` + shown.map(([n]) =>
        `<div class="legend-row"><span class="legend-swatch" style="background:${leaderColorMap.get(n)}"></span> ${escapeHtml(n)}</div>`
      ).join("");
      return div;
    };
    legendControl.addTo(leafletMap);
  }

  // ---- small helpers --------------------------------------------------------

  function initials(name) {
    return name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("");
  }

  function lookupCandidate(name) {
    if (!candidates || !name) return {};
    const upper = name.toUpperCase().trim();
    if (candidates[upper]) return candidates[upper];
    const tokens = upper.split(/[\s,]+/).filter(Boolean);
    for (const tok of tokens) if (candidates[tok]) return candidates[tok];
    return {};
  }

  function formatTimestamp(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // TEST HARNESS: snapshot switcher. Swaps the data file and re-renders.
  window.__loadSnapshot = (url) => {
    DATA_URL = url;
    tick();
  };

  initMap();
  tick();
  setInterval(tick, REFRESH_MS);
})();
