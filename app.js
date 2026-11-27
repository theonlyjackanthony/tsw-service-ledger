"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const storageKey = "tsw-ledger-v1";
  const pageSize = 50;
  const fmt = (value) => Number(value).toLocaleString("en-GB");
  const html = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const record = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const defaults = () => ({
    done: {},
    unavailable: {},
    manual: [],
    owner: {},
    owned: true,
    source: "current",
  });
  let state = defaults();
  let saveBlocked = false;
  let ledger;
  let routes = {};
  let rows = [];
  let byId = new Map();
  let view = "routes";
  let page = 0;
  let editing = null;
  let shift = null;
  let shiftAttempted = false;
  let selectedService = null;
  let searchIndex = null;
  let searchHits = [];
  let searchLimit = 15;

  function readState(raw) {
    const saved = JSON.parse(raw);
    const boolMap = (map) =>
      record(map) && Object.values(map).every((v) => typeof v === "boolean");
    const validSnapshot = (entry) =>
      record(entry) &&
      ["routeKey", "variant", "code", "time"].every(
        (key) => typeof entry[key] === "string",
      ) &&
      ["id", "routeName", "formation", "from", "to"].every(
        (key) => entry[key] == null || typeof entry[key] === "string",
      ) &&
      (entry.durationMinutes == null ||
        (Number.isInteger(entry.durationMinutes) &&
          entry.durationMinutes >= 0));
    if (
      !record(saved) ||
      !record(saved.done) ||
      !boolMap(saved.unavailable) ||
      !boolMap(saved.owner) ||
      (saved.owned !== undefined && typeof saved.owned !== "boolean") ||
      (saved.records !== undefined &&
        (!record(saved.records) ||
          !Object.values(saved.records).every(validSnapshot))) ||
      !Array.isArray(saved.manual) ||
      saved.manual.some(
        (s) =>
          !Array.isArray(s) ||
          s.length < 5 ||
          !s.slice(0, 5).every((x) => typeof x === "string"),
      ) ||
      Object.values(saved.done).some(
        (d) => !record(d) || (d.loco != null && typeof d.loco !== "string"),
      )
    ) {
      throw new Error(
        "This file does not contain a valid Service Ledger backup.",
      );
    }
    const loaded = { ...defaults(), ...saved };
    const hasOriginalProgress =
      Object.keys(saved.done).length ||
      Object.keys(saved.unavailable).length ||
      saved.manual.length;
    loaded.source =
      saved.source === "legacy" || (saved.source == null && hasOriginalProgress)
        ? "legacy"
        : "current";
    return loaded;
  }

  function notice(message) {
    $("storageNotice").textContent = message;
    $("storageNotice").classList.remove("hidden");
  }

  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) state = readState(raw);
  } catch {
    saveBlocked = true;
    notice(
      "The saved ledger could not be read. Export any new entries before closing or restore a valid backup to resume saving.",
    );
  }

  function save() {
    if (saveBlocked) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      notice(
        "This browser could not save your changes. Export progress before closing.",
      );
    }
  }

  function opts(select, items, selected) {
    select.replaceChildren(
      ...items.map(([value, title]) => new Option(title, value)),
    );
    if (items.some(([value]) => value === selected)) select.value = selected;
  }

  function routeName(key) {
    return (routes[key]?.name ?? key).replace(/\s+Route Add-On\s*$/i, "");
  }
  function owned(key) {
    return state.owner[key] ?? routes[key]?.owned;
  }
  function visible(key) {
    return (
      !!routes[key] && (!state.owned || (owned(key) && routes[key].compatible))
    );
  }
  function routeKeys() {
    return Object.keys(routes)
      .filter(visible)
      .sort((a, b) => routeName(a).localeCompare(routeName(b)));
  }
  function stock(key) {
    const names = new Set(routes[key]?.locos ?? []);
    for (const row of rows) {
      if (row[1] !== key) continue;
      for (const name of row.locomotives ?? []) names.add(name);
      if (state.done[row[0]]?.loco) names.add(state.done[row[0]].loco);
    }
    return [...new Set([...names].map(ledger.locoName).filter(Boolean))].sort();
  }
  function catalogue() {
    searchIndex = null;
    routes = ledger.routes(state.source);
    rows = ledger.services(state.source, state);
    byId = new Map(rows.map((row) => [row[0], row]));
  }
  function variants(reset = false) {
    const key = $("route").value;
    const names = new Set((routes[key]?.variants ?? []).map((v) => v.name));
    for (const row of rows) if (row[1] === key) names.add(row[2]);
    opts(
      $("variant"),
      [["", "All variants"], ...[...names].map((name) => [name, name])],
      reset ? "" : $("variant").value,
    );
    opts(
      $("driven"),
      [
        ["", "Use verified loco if known"],
        ...stock(key).map((name) => [name, name]),
      ],
      reset ? "" : $("driven").value,
    );
  }
  function routeOpts(preferred = $("route").value) {
    const keys = routeKeys();
    const active = keys.includes(preferred)
      ? preferred
      : keys.includes("LBN")
        ? "LBN"
        : keys[0];
    opts(
      $("route"),
      [["", "Choose a route"], ...keys.map((key) => [key, routeName(key)])],
      active,
    );
    variants();
  }

  function percent(done, total) {
    if (!total) return "—";
    return (
      ((100 * done) / total).toLocaleString("en-GB", {
        maximumFractionDigits: 1,
      }) + "%"
    );
  }
  function bar(done, total) {
    return (
      '<div class="bar" aria-hidden="true"><i style="width:' +
      (total ? (done / total) * 100 : 0) +
      '%"></i></div>'
    );
  }
  function tally() {
    return { done: 0, total: 0, excluded: 0, retired: 0 };
  }
  function count(result, row) {
    if (row.retired) result.retired++;
    else if (state.unavailable[row[0]]) result.excluded++;
    else {
      result.total++;
      if (state.done[row[0]]) result.done++;
    }
  }
  function group(rowsInScope) {
    const result = tally();
    for (const row of rowsInScope) count(result, row);
    return result;
  }
  function progress(t) {
    if (!t.total)
      return '<span class="progress-label">No counted services</span>';
    return (
      '<span class="progress-label">' +
      fmt(t.done) +
      " / " +
      fmt(t.total) +
      " · " +
      percent(t.done, t.total) +
      "</span>" +
      bar(t.done, t.total)
    );
  }

  function renderSummary(keys, perRoute) {
    const total = tally();
    const used = new Set();
    for (const row of rows) {
      if (!visible(row[1])) continue;
      count(total, row);
      count(perRoute.get(row[1]), row);
      const name = state.done[row[0]]?.loco;
      if (name && !state.unavailable[row[0]]) used.add(ledger.locoName(name));
    }
    const driven = [...perRoute.values()].filter((t) => t.done).length;
    $("metrics").innerHTML =
      '<div class="metric"><b>' +
      fmt(total.done) +
      " / " +
      fmt(total.total) +
      "</b><span>Listed services completed · " +
      percent(total.done, total.total) +
      "</span>" +
      bar(total.done, total.total) +
      "</div>" +
      '<div class="metric"><b>' +
      fmt(driven) +
      " / " +
      fmt(keys.length) +
      "</b><span>Routes driven</span></div>" +
      '<div class="metric"><b>' +
      fmt(used.size) +
      "</b><span>Locomotives driven</span></div>";
    $("scope").textContent =
      fmt(keys.length) +
      " routes · " +
      fmt(total.excluded) +
      " marked unavailable" +
      (total.retired ? " · " + fmt(total.retired) + " retired" : "");
  }
  function renderRoutes(keys, perRoute) {
    const query = $("routeSearch").value.trim().toLowerCase();
    const found = keys.filter((key) =>
      (routeName(key) + " " + routes[key].variants.map((v) => v.name).join(" "))
        .toLowerCase()
        .includes(query),
    );
    if ($("routeSort").value === "progress") {
      found.sort(
        (a, b) =>
          perRoute.get(b).done - perRoute.get(a).done ||
          routeName(a).localeCompare(routeName(b)),
      );
    }
    $("routeList").innerHTML =
      found
        .map((key) => {
          const route = routes[key],
            t = perRoute.get(key);
          const ownership =
            owned(key) === true
              ? "Owned"
              : owned(key) === false
                ? "Marked unowned"
                : "Ownership unknown";
          const meta = [
            route.region,
            route.variants.length +
              (route.variants.length === 1
                ? " timetable variant"
                : " timetable variants"),
            ownership,
          ].filter(Boolean);
          const shortName = routeName(key).split("\n")[0];
          return (
            '<div class="rline"><div class="route-info"><button class="route-title route-button" data-route="' +
            html(key) +
            '">' +
            html(shortName) +
            '</button><div class="muted">' +
            html(meta.join(" · ")) +
            '</div><button class="secondary" data-own="' +
            html(key) +
            '">' +
            (owned(key) ? "Mark not owned" : "Mark owned") +
            '</button></div><div class="route-progress">' +
            (t.total || t.excluded
              ? progress(t)
              : "<span>No imported listings</span>") +
            "</div></div>"
          );
        })
        .join("") || '<p class="muted">No matching routes.</p>';
  }
  function availabilityText(row) {
    if (row.retired) return "Retired from this catalogue";
    if (row[0].startsWith("manual:")) return "Manually logged";
    const status = ledger.availability(row, state);
    if (status === "owned") return "PS5 requirements verified · owned";
    if (status === "missing") return "Required DLC missing";
    return "DLC requirements unknown";
  }
  function serviceInfo(row) {
    const locos = row.locomotives ?? [];
    const endpoint = [row.from, row.to].filter(Boolean).map(html).join(" → ");
    const formation = row.formation
      ? " · Formation " + html(row.formation)
      : "";
    const duration = Number.isFinite(row.durationMinutes)
      ? " · " + fmt(row.durationMinutes) + " min"
      : "";
    return (
      (endpoint ? '<div class="route-endpoints">' + endpoint + "</div>" : "") +
      "<small>" +
      html(row[2]) +
      duration +
      "</small><small>" +
      (locos.length ? html(locos.join(" / ")) : "Locomotive unknown") +
      formation +
      '</small><small class="' +
      (ledger.availability(row, state) === "owned" && !row.retired
        ? "reviewed"
        : "") +
      '">' +
      html(availabilityText(row)) +
      "</small>" +
      evidenceDetails(row)
    );
  }
  function evidenceDetails(row) {
    if (row.hud || row.observation) {
      const evidence = row.hud ? "Original workbook · " + sourceLink(row.sourceUrl, "TSW HUD timetable database") +
        " · record " + html(row.hud.hudId) + " · start " + html(row.hud.start) : "";
      return '<details class="evidence"><summary>Service sources</summary>' +
        evidence + (row.observation ? "<div>" + html(row.observation) + "</div>" : "") + "</details>";
    }
    if (!row.sourceUrl) return "";
    const links = [sourceLink(row.sourceUrl, "Published service")];
    let products = "";
    if (row.rule) {
      const names = new Map(
        window.LEDGER_DATA.requirements.dlc.map((d) => [d.id, d.name]),
      );
      products =
        "<div>Required DLC · " +
        row.rule.requiresAny
          .map((group) =>
            group.map((id) => html(names.get(id) ?? id)).join(" + "),
          )
          .join(" or ") +
        "</div>";
      row.rule.sources.forEach((url, i) => {
        const host = new URL(url).hostname.replace(/^www\./, "");
        links.push(sourceLink(url, host + " (" + (i + 1) + ")"));
      });
    }
    const grouped =
      row.sourceRowCount > 1
        ? "<div>" +
          fmt(row.sourceRowCount) +
          " indistinguishable source listings share this progress record.</div>"
        : "";
    return (
      '<details class="evidence"><summary>Service sources</summary>' +
      products +
      grouped +
      links.join(" · ") +
      "</details>"
    );
  }
  function sourceLink(url, text) {
    try {
      const link = new URL(url);
      if (!["https:", "http:"].includes(link.protocol)) return "";
      return (
        '<a href="' +
        html(link.href) +
        '" target="_blank" rel="noopener noreferrer">' +
        html(text) +
        "</a>"
      );
    } catch {
      return "";
    }
  }
  function searchTerms(row) {
    return [row[3], row[4], row.title, row.from, row.to, row.formation,
      ...(row.locomotives ?? []), state.done[row[0]]?.loco].join(" ").toLowerCase();
  }

  function renderServices() {
    const key = $("route").value,
      variant = $("variant").value,
      status = $("status").value;
    const q = $("search").value.trim().toLowerCase();
    const scope = rows.filter(
      (row) => row[1] === key && (!variant || row[2] === variant),
    );
    const totals = group(scope);
    $("serviceTitle").textContent = key
      ? routeName(key).split("\n")[0]
      : "Service checklist";
    const sourceUrl = routes[key]?.variants.find(
      (v) => v.name === variant,
    )?.sourceUrl;
    $("variantSummary").innerHTML =
      '<div class="progress-inline">' +
      (scope.length
        ? progress(totals)
        : '<span class="progress-label">No imported listings</span>') +
      "</div>" +
      (sourceUrl ? sourceLink(sourceUrl, "View source timetable") : "");
    const matched = scope
      .filter((row) => {
        const [id] = row;
        if (selectedService && id !== selectedService) return false;
        if (
          status === "remaining" &&
          (state.done[id] || state.unavailable[id] || row.retired)
        )
          return false;
        if (
          status === "completed" &&
          (!state.done[id] || state.unavailable[id])
        )
          return false;
        if (status === "unavailable" && !state.unavailable[id]) return false;
        if (status === "retired" && !row.retired) return false;
        if (!q) return true;
        return searchTerms(row).includes(q);
      })
      .sort(
        (a, b) =>
          (a[4] || "99:99").localeCompare(b[4] || "99:99") ||
          a[3].localeCompare(b[3]),
      );
    const pages = Math.max(1, Math.ceil(matched.length / pageSize));
    page = Math.min(Math.max(0, page), pages - 1);
    $("selectedService").classList.toggle("hidden", !selectedService);
    $("selectedService").innerHTML = selectedService
      ? 'Selected service <button class="secondary" data-clear-selection="true">Show timetable</button>'
      : "";
    $("serviceList").innerHTML =
      matched
        .slice(page * pageSize, (page + 1) * pageSize)
        .map((row) => {
          const [id] = row,
            complete = state.done[id],
            unavailable = state.unavailable[id];
          return (
            '<div class="service ' +
            (complete ? "completed " : "") +
            (unavailable ? "unavailable" : "") +
            '"><input type="checkbox" aria-label="Complete ' +
            html(row[3] + " " + row[4]) +
            '" data-check="' +
            html(id) +
            '" ' +
            (complete ? "checked " : "") +
            (unavailable ? "disabled" : "") +
            '><div><div class="sname">' +
            html(row.title || row[3]) +
            "</div>" +
            serviceInfo(row) +
            (complete
              ? "<small>" +
                (complete.loco
                  ? "Driven with " + html(complete.loco)
                  : "Completed · loco unrecorded") +
                '</small><button class="secondary" data-loco="' +
                html(id) +
                '">Edit loco</button>'
              : "") +
            '</div><span class="time">' +
            html(row[4] || "—") +
            '</span><button class="secondary" data-unavailable="' +
            html(id) +
            '">' +
            (unavailable ? "Restore" : "Not playable") +
            "</button></div>"
          );
        })
        .join("") ||
      '<p class="muted">No matching services. Change the filters or log an unlisted service.</p>';
    const other = state.source === "current" ? "legacy" : "current";
    const otherRows = ledger.services(other, state).filter(row => row[1] === key &&
      !row.manual && !row.retired && (!q || searchTerms(row).includes(q)));
    if (otherRows.length && (!matched.length || !q)) {
      const name = other === "legacy" ? "original workbook" : "main checklist";
      $("variantSummary").innerHTML += ' <button class="secondary" data-other-source="' +
        other + '">Browse ' + fmt(otherRows.length) + (q ? ' matching' : '') +
        ' records in ' + name + '</button>';
    }
    $("pageLabel").textContent =
      fmt(matched.length) +
      " records · page " +
      (page + 1) +
      " of " +
      fmt(pages);
    $("prev").disabled = page === 0;
    $("next").disabled = page === pages - 1;
  }
  function renderLocos(keys) {
    const result = new Map();
    function locoEntry(name) {
      const canonical = ledger.locoName(name);
      if (!result.has(canonical))
        result.set(canonical, {
          done: 0,
          total: 0,
          drives: 0,
          base: new Set(),
        });
      return result.get(canonical);
    }
    for (const key of keys) {
      for (const name of routes[key].locos) locoEntry(name).base.add(key);
    }
    for (const row of rows) {
      if (!visible(row[1]) || state.unavailable[row[0]]) continue;
      const driven = state.done[row[0]]?.loco;
      const recordedName = driven ? ledger.locoName(driven) : "";
      if (recordedName) locoEntry(recordedName).drives++;
      if (row.retired) continue;
      for (const name of new Set(
        (row.locomotives ?? []).map((l) => ledger.locoName(l)),
      )) {
        const entry = locoEntry(name);
        entry.total++;
        if (recordedName === name) entry.done++;
      }
    }
    const q = $("locoSearch").value.trim().toLowerCase();
    const matches = [...result]
      .filter(([name]) => name.toLowerCase().includes(q))
      .sort(
        ([nameA, a], [nameB, b]) =>
          b.drives - a.drives ||
          b.total - a.total ||
          nameA.localeCompare(nameB),
      );
    $("locoList").innerHTML =
      matches
        .map(
          ([name, entry]) =>
            '<div class="rline"><div class="route-info"><span class="route-title loco">' +
            html(name) +
            '</span><div class="muted">' +
            fmt(entry.drives) +
            " recorded " +
            (entry.drives === 1 ? "drive" : "drives") +
            " · " +
            entry.base.size +
            " listed base routes</div></div>" +
            '<div class="route-progress">' +
            (entry.total ? progress(entry) : "Service coverage unknown") +
            "</div></div>",
        )
        .join("") || '<p class="muted">No matching locomotives.</p>';
  }

  function renderShift() {
    if (
      shift &&
      (state.done[shift[0]] ||
        state.unavailable[shift[0]] ||
        ledger.availability(shift, state) !== "owned")
    ) {
      shift = null;
      shiftAttempted = false;
    }
    const panel = $("shiftResult");
    if (!shift) {
      panel.textContent = shiftAttempted
        ? "No remaining verified shifts match these times and your owned DLC."
        : "";
      return;
    }
    const name = ledger.routes("current")[shift[1]]?.name ?? shift[1];
    panel.innerHTML =
      '<div class="shift-card"><h3>' +
      html(shift[3]) +
      " · " +
      html(shift[4]) +
      "</h3><div>" +
      html(name.replace(/\s+Route Add-On\s*$/i, "")) +
      "</div>" +
      serviceInfo(shift) +
      '<div class="rowflex"><button type="button" class="primary" data-open-shift="true">Open service</button>' +
      sourceLink(shift.sourceUrl, "View source timetable") +
      "</div></div>";
  }

  function render() {
    if ($("globalQuery").value) findAcrossLedger();
    const keys = routeKeys();
    const groups = new Map(keys.map((key) => [key, tally()]));
    renderSummary(keys, groups);
    if (view === "routes") renderRoutes(keys, groups);
    if (view === "services") renderServices();
    if (view === "locos") renderLocos(keys);
    if (view === "shift") renderShift();
    $("coverage").textContent =
      state.source === "legacy"
        ? "Original workbook · partial coverage. Counts cover listed services. Locomotive and DLC assignments require separate evidence."
        : "Main checklist · partial coverage. Includes published passenger services and workbook services confirmed in the HUD timetable database.";
  }

  function setView(next) {
    view = next;
    document.body.dataset.ledgerView = next;
    for (const control of [
      $("metrics"),
      $("coverage"),
      document.querySelector(".catalogue-controls"),
    ]) {
      control.classList.toggle("hidden", next === "shift");
    }
    document.querySelectorAll("[data-view]").forEach((button) => {
      const selected = button.dataset.view === next;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    for (const name of ["routes", "services", "locos", "shift"]) {
      $(name + "Pane").classList.toggle("hidden", name !== next);
    }
    render();
  }

  function persist() {
    searchIndex = null;
    shift = null;
    shiftAttempted = false;
    save();
    render();
  }

  function refreshState() {
    ledger.reconcile(state);
    catalogue();
    // Capture original v1 ticks once, while their catalogue information is available.
    for (const row of rows) {
      if (state.done[row[0]] || state.unavailable[row[0]])
        ledger.remember(row, state);
    }
    $("owned").checked = !!state.owned;
    $("source").value = state.source;
    selectedService = null;
    shift = null;
    shiftAttempted = false;
    page = 0;
    routeOpts();
  }

  function editLoco(id) {
    const row = byId.get(id);
    if (!row) return;
    editing = id;
    $("locoService").textContent = [row[3], row[4], routeName(row[1])]
      .filter(Boolean)
      .join(" · ");
    opts(
      $("locoChoice"),
      [["", "Not recorded"], ...stock(row[1]).map((l) => [l, l])],
      ledger.locoName(state.done[id]?.loco),
    );
    $("customLoco").value = "";
    $("locoDialog").showModal();
  }

  const normalizeSearch = value => String(value ?? "").normalize("NFKD")
    .replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  function makeSearchIndex() {
    const entries = [];
    const seen = new Set();
    function add(type, key, source, route, variant, id, title, detail, extra = "", time = "", specific = "") {
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({type, source, route, variant, id, title, detail, time,
        primary: normalizeSearch(title), specific: normalizeSearch(specific), terms: normalizeSearch([title, route, detail, extra].join(" "))});
    }
    for (const source of ["current", "legacy"]) {
      const collection = ledger.routes(source);
      for (const [route, item] of Object.entries(collection)) {
        const name = item.name.split("\n")[0].replace(/\s+Route Add-On\s*$/i, "");
        add("Route", "route:" + route, source, route, "", "", name, route);
        for (const {name: variant} of item.variants)
          add("Timetable", JSON.stringify([route, variant]), source, route, variant, "", variant, name);
        for (const alias of item.locos || []) {
          const loco = ledger.locoName(alias);
          add("Locomotive", "loco:" + loco, source, route, "", "", loco, "Locomotive progress", alias);
        }
      }
      for (const row of ledger.services(source, state)) {
        const [id, route, variant, code, time] = row;
        const name = collection[route]?.name.split("\n")[0].replace(/\s+Route Add-On\s*$/i, "") || route;
        const locos = [...(row.locomotives || []), state.done[id]?.loco].filter(Boolean);
        for (const alias of locos) {
          if (!state.unavailable[id]) {
            const loco = ledger.locoName(alias);
            add("Locomotive", "loco:" + loco, source, route, "", "", loco, "Locomotive progress", alias);
          }
        }
        const endpoints = [row.from, row.to].filter(Boolean).join(" → ");
        const detail = [name, variant, endpoints, ...new Set(locos)].filter(Boolean).join(" · ");
        add("Service", "service:" + id, source, route, variant, id, row.title || code, detail,
          [code, time, row.formation, ...locos.map(ledger.locoName)].join(" "), time, [code, time, endpoints, row.formation, ...locos].join(" "));
      }
    }
    return entries;
  }

  function findAcrossLedger() {
    const query = normalizeSearch($("globalQuery").value);
    $("globalResults").hidden = !query;
    if (!query) {
      searchHits = [];
      $("globalList").replaceChildren();
      return;
    }
    searchIndex ||= makeSearchIndex();
    const words = query.split(" ");
    const ranked = [];
    for (const item of searchIndex) {
      if (!words.every(word => item.terms.includes(word))) continue;
      const rank = item.primary === query ? 0 : item.primary.startsWith(query) ? 1 :
        item.primary.includes(query) ? 2 : words.every(word => item.specific.includes(word)) ? 3 :
        item.type === "Service" ? 5 : 4;
      ranked.push({item, rank});
    }
    ranked.sort((a, b) => a.rank - b.rank);
    searchHits = ranked.map(hit => hit.item);
    showSearchHits();
  }

  function showSearchHits() {
    $("globalCount").textContent = searchHits.length
      ? fmt(searchHits.length) + " matches · showing " + fmt(Math.min(searchLimit, searchHits.length))
      : "No matches. Try a shorter name, a headcode or another station.";
    $("moreResults").hidden = searchLimit >= searchHits.length;
    $("globalList").innerHTML = searchHits.slice(0, searchLimit).map((hit, i) =>
      '<button type="button" class="search-hit" data-search-hit="' + i + '"><strong>' +
      html(hit.title) + '</strong>' + (hit.time ? ' · ' + html(hit.time) : '') + '<small>' +
      html([hit.type, hit.source === "legacy" ? "Original workbook" : "", hit.detail].filter(Boolean).join(" · ")) +
      '</small></button>').join("");
  }

  function clearGlobalSearch() {
    $("globalQuery").value = "";
    findAcrossLedger();
  }

  function openSearchHit(hit) {
    clearGlobalSearch();
    if (hit.type === "Locomotive") {
      selectSourceRoute(hit.source, hit.route);
      $("locoSearch").value = hit.title;
      save();
      setView("locos");
      $("locoSearch").focus();
    } else {
      openChecklist(hit.source, hit.route, hit.variant, hit.id);
    }
  }

  $("globalQuery").oninput = () => {
    searchLimit = 15;
    findAcrossLedger();
  };
  $("closeResults").onclick = () => { clearGlobalSearch(); $("globalQuery").focus(); };
  $("moreResults").onclick = () => {
    const firstNew = searchLimit;
    searchLimit += 15;
    showSearchHits();
    $("globalList").children[firstNew]?.focus();
  };

  function selectSourceRoute(source, route) {
    state.source = source;
    $("source").value = source;
    catalogue();
    if (!visible(route)) {
      state.owned = false;
      $("owned").checked = false;
    }
    routeOpts(route);
  }

  function openChecklist(source, route, variant, id) {
    selectSourceRoute(source, route);
    $("variant").value = variant;
    $("status").value = "all";
    $("search").value = "";
    selectedService = id || null;
    page = 0;
    save();
    setView("services");
    (id ? $("serviceList").querySelector("input") : $("route"))?.focus();
  }

  function openShift() {
    if (shift) openChecklist("current", shift[1], shift[2], shift[0]);
  }

  $("backup").onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tsw-ledger-progress.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("restore").onclick = () => $("file").click();
  $("file").onchange = async () => {
    try {
      const file = $("file").files[0];
      if (!file) return;
      const restored = readState(await file.text());
      if (!confirm("Replace the progress on this device with this backup?"))
        return;
      if (ledger) ledger.reconcile(restored);
      state = restored;
      saveBlocked = false;
      $("storageNotice").classList.add("hidden");
      if (ledger) refreshState();
      save();
      if (ledger) render();
    } catch (error) {
      alert("Could not restore this file. " + error.message);
    } finally {
      $("file").value = "";
    }
  };

  try {
    ledger = TSWLedger.open(window.LEDGER_DATA);
    const before = JSON.stringify(state);
    refreshState();
    if (before !== JSON.stringify(state)) save();
  } catch (error) {
    $("coverage").textContent =
      "The timetable database could not be loaded. Keep this HTML, app.js, ledger-core.js, ledger.css and the data folder together.";
    $("manual").disabled = true;
    $("routesPane").classList.add("hidden");
    document
      .querySelectorAll(
        "#globalQuery, .tabs button, .catalogue-controls select, .catalogue-controls input",
      )
      .forEach((el) => {
        el.disabled = true;
      });
    console.error("Could not open Service Ledger", error);
    return;
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const action = button.dataset;
    if (action.searchHit !== undefined) openSearchHit(searchHits[Number(action.searchHit)]);
    else if (action.view) setView(action.view);
    else if (action.otherSource) {
      const route = $("route").value;
      state.source = action.otherSource;
      $("source").value = state.source;
      catalogue();
      routeOpts(route);
      variants(true);
      $("status").value = "all";
      selectedService = null;
      page = 0;
      persist();
    } else if (action.route) {
      selectedService = null;
      $("route").value = action.route;
      $("search").value = "";
      variants(true);
      page = 0;
      setView("services");
    } else if (action.own) {
      state.owner[action.own] = !owned(action.own);
      routeOpts();
      persist();
    } else if (action.unavailable) {
      const id = action.unavailable,
        row = byId.get(id);
      if (!row) return;
      if (state.unavailable[id]) delete state.unavailable[id];
      else {
        if (
          state.done[id] &&
          !confirm("Exclude this completed record from progress?")
        )
          return;
        state.unavailable[id] = true;
        ledger.remember(row, state);
      }
      catalogue();
      persist();
    } else if (action.loco) editLoco(action.loco);
    else if (action.openShift) openShift();
    else if (action.clearSelection) {
      selectedService = null;
      render();
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input.dataset.check) {
      const id = input.dataset.check,
        row = byId.get(id);
      if (!row) return;
      if (input.checked) {
        const inferred =
          row.locomotives?.length === 1 ? row.locomotives[0] : "";
        state.done[id] = {
          loco: $("driven").value || inferred,
          date: new Date().toISOString(),
        };
        ledger.remember(row, state);
      } else delete state.done[id];
      catalogue();
      persist();
    } else if (input.id === "source") {
      state.source = input.value;
      selectedService = null;
      $("search").value = "";
      page = 0;
      catalogue();
      routeOpts();
      variants(true);
      persist();
    } else if (input.id === "owned") {
      state.owned = input.checked;
      selectedService = null;
      routeOpts();
      page = 0;
      persist();
    } else if (["route", "variant", "status", "routeSort"].includes(input.id)) {
      selectedService = null;
      if (input.id === "route") variants(true);
      page = 0;
      render();
    }
  });
  for (const id of ["search", "routeSearch", "locoSearch"]) {
    $(id).oninput = () => {
      selectedService = null;
      page = 0;
      render();
    };
  }
  $("prev").onclick = () => {
    page--;
    renderServices();
  };
  $("next").onclick = () => {
    page++;
    renderServices();
  };
  $("locoForm").onsubmit = (event) => {
    event.preventDefault();
    if (editing && state.done[editing])
      state.done[editing].loco =
        $("customLoco").value.trim() || $("locoChoice").value;
    $("locoDialog").close();
    variants();
    persist();
  };
  $("cancelLoco").onclick = () => $("locoDialog").close();
  $("manual").onclick = () => {
    const keys = Object.keys(routes).sort((a, b) =>
      routeName(a).localeCompare(routeName(b)),
    );
    opts(
      $("mRoute"),
      keys.map((key) => [key, routeName(key)]),
      $("route").value,
    );
    $("mName").value = "";
    $("mTime").value = "";
    $("mLoco").value = "";
    $("manualDialog").showModal();
  };
  $("manualForm").onsubmit = (event) => {
    event.preventDefault();
    const key = $("mRoute").value,
      name = $("mName").value.trim();
    if (!name) {
      $("mName").setCustomValidity("Enter a service name or headcode.");
      $("mName").reportValidity();
      return;
    }
    const id =
      "manual:" + Date.now() + ":" + Math.random().toString(36).slice(2);
    state.manual.push([id, key, "Manually logged", name, $("mTime").value]);
    state.done[id] = {
      loco: $("mLoco").value.trim(),
      date: new Date().toISOString(),
    };
    $("manualDialog").close();
    ledger.reconcile(state);
    catalogue();
    routeOpts();
    persist();
  };
  $("mName").oninput = () => $("mName").setCustomValidity("");
  $("cancelManual").onclick = () => $("manualDialog").close();
  $("shiftForm").onsubmit = (event) => {
    event.preventDefault();
    const min = $("shiftMin").value,
      max = $("shiftMax").value;
    if (min !== "" && max !== "" && Number(min) > Number(max)) {
      $("shiftMax").setCustomValidity("Maximum must be at least the minimum.");
      $("shiftMax").reportValidity();
      return;
    }
    shift = ledger.chooseShift(state, {
      minMinutes: min === "" ? null : Number(min),
      maxMinutes: max === "" ? null : Number(max),
    });
    shiftAttempted = true;
    renderShift();
    const result = $("shiftResult");
    if (result.getBoundingClientRect().bottom > window.innerHeight)
      result.scrollIntoView({ block: "nearest" });
  };
  for (const id of ["shiftMin", "shiftMax"]) {
    $(id).oninput = () => {
      $("shiftMax").setCustomValidity("");
      shift = null;
      shiftAttempted = false;
      renderShift();
    };
  }

  // A second tab on the same browser can complete a service while this one is open.
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey || !event.newValue) return;
    try {
      state = readState(event.newValue);
      refreshState();
      render();
    } catch {
      notice(
        "Another tab saved data this ledger could not read. Export a backup before making changes.",
      );
    }
  });

  const checked = window.LEDGER_DATA.ownership?.source;
  $("sourceNote").innerHTML =
    "Timetables from " +
    sourceLink("https://trainsimtimetables.com/", "Train Sim Timetables") +
    " and the original workbook (23 September 2026). " +
    sourceLink(checked?.url, "DLC ownership tracker") +
    (checked?.asOf ? " checked " + html(checked.asOf) : "") +
    ". Progress saves in this browser. Use Export and Restore to transfer a backup between devices.";
  setView("routes");
})();
