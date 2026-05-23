// CD-11 public results map.
// Fetches:
//   ./data/cd11_precincts.geojson  (CD-11 precinct polygons, mirror of internal repo's reference)
//   ./data/latest.json             (public-safe analysis slice, populated by internal repo's publish workflow)
//   ./data/candidates.json         (candidate photos + 1-line bios)

(() => {
  const REFRESH_MS = 60 * 1000;
  const GEOJSON_URL = "./data/cd11_precincts.geojson";
  // TEST HARNESS: the snapshot file is selectable via the switcher bar.
  // Production uses a fixed "./data/latest.json"; the rest is unchanged.
  let DATA_URL = "./data/drop1.json";
  const CANDIDATES_URL = "./data/candidates.json";

  // Neutral colorblind-safe palette for race-leader coloring (public map shows NO Wiener-favorable colors).
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
  let geojsonLayer = null;
  let geojsonData = null;
  let analysisByPrecinct = new Map();
  let lastData = null;
  let candidates = null;
  let leaderColorMap = new Map();
  let granularity = "precinct";
  let legendControl = null;
  // Which candidates to surface in breakdowns. Set from candidates.json "_display":
  //   { "mode": "topN", "n": 3 }                       -> top 3 vote-getters
  //   { "mode": "featured", "featured": ["NAME", ...] } -> a fixed named slate
  // Defaults to showing everyone.
  let displayConfig = { mode: "all" };
  // precinct id -> supervisor_district, derived from the GeoJSON (the public data
  // slice intentionally strips supervisor_district, so aggregation reads it here).
  let precinctToSD = new Map();

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
      restyleMap();
      renderLegend();
    });
  });
  els.closeDetail.addEventListener("click", () => els.detail.classList.add("hidden"));

  async function tick() {
    try {
      if (!geojsonData) {
        const gjRes = await fetch(GEOJSON_URL, { cache: "no-store" });
        if (gjRes.ok) {
          geojsonData = await gjRes.json();
          precinctToSD = new Map(
            (geojsonData.features || []).map((f) => [f.properties?.precinct, f.properties?.supervisor_district])
          );
          renderMap();
        }
      }
      if (!candidates) {
        const cRes = await fetch(CANDIDATES_URL, { cache: "no-store" });
        if (cRes.ok) {
          const raw = await cRes.json();
          // Build a case-insensitive lookup with last-name fallback.
          // SF DoE has emitted "WIENER, SCOTT" in past elections, but if the
          // June 2 CVR shifts to "Wiener, Scott" or "Scott Wiener", the
          // exact-match lookup would silently fail and the side panel would
          // show fallback initials instead of real photos. This builds the
          // tolerance in.
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
    restyleMap();
    updateTooltips();
    renderLegend();
  }

  function buildLeaderColorMap(cands) {
    leaderColorMap = new Map();
    const sorted = [...cands].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    sorted.forEach((c, i) => leaderColorMap.set(c.name, PALETTE[i % PALETTE.length]));
  }

  // Tokens of length > 2 from a name, e.g. "WIENER, SCOTT" -> ["WIENER","SCOTT"].
  function nameTokens(name) {
    return new Set(String(name).toUpperCase().split(/[\s,]+/).filter((t) => t.length > 2));
  }

  // Reduce a sorted [name, votes] list to the candidates the dashboard should show,
  // per displayConfig. Order is preserved for topN/all; featured uses the slate order.
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
      return out.length ? out : sortedEntries; // graceful fallback if none matched
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

  function renderMap() {
    if (!leafletMap || !geojsonData) return;
    if (geojsonLayer) geojsonLayer.remove();
    geojsonLayer = L.geoJSON(geojsonData, {
      style: feature => styleForFeature(feature),
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        layer.bindTooltip(p.precinct_full_name || `PCT ${p.precinct}`, { sticky: true });
        layer.on("click", () => openSidePanel(p));
      },
    }).addTo(leafletMap);
    try { leafletMap.fitBounds(geojsonLayer.getBounds(), { padding: [10, 10] }); } catch (e) { /* empty */ }
  }

  function restyleMap() {
    if (!geojsonLayer) return;
    geojsonLayer.setStyle(feature => styleForFeature(feature));
  }

  function styleForFeature(feature) {
    const props = feature.properties || {};
    const data = analysisByPrecinct.get(props.precinct);
    const base = { weight: 0.7, color: "#888", fillOpacity: 0.7, fillColor: "#e0e0e0" };
    if (!data) {
      base.fillOpacity = 0.15;
      return base;
    }
    if (granularity === "precinct" && data.leader) {
      base.fillColor = leaderColorMap.get(data.leader) || "#888";
    } else if (granularity === "sup") {
      // Aggregate by supervisor_district
      const sd = props.supervisor_district;
      const leader = leaderInSupDistrict(sd);
      base.fillColor = leaderColorMap.get(leader) || "#888";
      base.weight = 0.3;
    } else if (granularity === "cd11") {
      const cwLeader = lastData?.candidates?.[0]?.name;
      base.fillColor = leaderColorMap.get(cwLeader) || "#888";
      base.weight = 0.3;
    }
    return base;
  }

  // Aggregate candidate votes across every precinct in a supervisor district.
  // Reads supervisor_district from the GeoJSON (precinctToSD), since the public
  // data slice strips it. Returns a {name: votes} tally.
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

  // Render display-limited candidate rows from a {name: votes} tally.
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
    const certified = lastData?.certified
      ? "Certified final."
      : "Preliminary until certified.";
    return `<p style="font-size:0.8rem;color:var(--color-muted);margin-top:1rem">Updated ${formatTimestamp(lastData?.timestamp)}. ${certified}</p>`;
  }

  function openSidePanel(props) {
    // In supervisor-district view, clicking shows the whole district's aggregate.
    if (granularity === "sup") {
      const sd = precinctToSD.get(props.precinct);
      const tally = tallySupDistrict(sd);
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      els.detailTitle.textContent = sd != null ? `Supervisor District ${sd}` : "Supervisor district";
      if (!total) {
        els.detailBody.innerHTML = `<p class="placeholder">No data yet for this district.</p>`;
        els.detail.classList.remove("hidden");
        return;
      }
      const header = `<p style="font-size:0.85rem;color:var(--color-muted);margin:0.5rem 0">Total ballots counted: <strong>${total.toLocaleString()}</strong></p>`;
      els.detailBody.innerHTML = `${header}${candidateRows(tally, total)}${panelFooter()}`;
      els.detail.classList.remove("hidden");
      return;
    }

    const data = analysisByPrecinct.get(props.precinct);
    els.detailTitle.textContent = props.precinct_full_name || `PCT ${props.precinct}`;
    if (!data) {
      els.detailBody.innerHTML = `<p class="placeholder">No data yet for this precinct.</p>`;
      els.detail.classList.remove("hidden");
      return;
    }
    const total = data.total_votes || 1;
    const header = `<p style="font-size:0.85rem;color:var(--color-muted);margin:0.5rem 0">Total ballots counted: <strong>${total.toLocaleString()}</strong></p>`;
    els.detailBody.innerHTML = `${header}${candidateRows(data.candidates, total)}${panelFooter()}`;
    els.detail.classList.remove("hidden");
  }

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

  // Refresh hover tooltips with the leader + leading share once data is loaded.
  function updateTooltips() {
    if (!geojsonLayer) return;
    geojsonLayer.eachLayer((layer) => {
      const p = layer.feature?.properties || {};
      const name = p.precinct_full_name || `PCT ${p.precinct}`;
      const data = analysisByPrecinct.get(p.precinct);
      if (data && data.leader && data.total_votes) {
        const pct = ((data.candidates?.[data.leader] || 0) / data.total_votes) * 100;
        layer.setTooltipContent(`<strong>${escapeHtml(name)}</strong><br>${escapeHtml(data.leader)} ${pct.toFixed(1)}%`);
      } else {
        layer.setTooltipContent(escapeHtml(name));
      }
    });
  }

  function initials(name) {
    return name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map(s => s[0]?.toUpperCase() || "").join("");
  }

  function lookupCandidate(name) {
    // Tolerant lookup: try exact-uppercase first, then last-name token.
    if (!candidates || !name) return {};
    const upper = name.toUpperCase().trim();
    if (candidates[upper]) return candidates[upper];
    // "Scott Wiener" or "WIENER, SCOTT" -> last name "WIENER"
    const tokens = upper.split(/[\s,]+/).filter(Boolean);
    for (const tok of tokens) {
      if (candidates[tok]) return candidates[tok];
    }
    return {};
  }

  function formatTimestamp(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // TEST HARNESS: snapshot switcher. Swaps the data file and re-renders without
  // touching geojson/candidates (already cached). Mirrors what the production
  // 60s tick does when latest.json changes between ballot drops.
  window.__loadSnapshot = (url) => {
    DATA_URL = url;
    tick();
  };

  initMap();
  tick();
  setInterval(tick, REFRESH_MS);
})();
