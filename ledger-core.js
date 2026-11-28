/* Shared catalogue and progress logic for the existing Service Ledger. */
"use strict";

const TSWLedger = (() => {
  const index = (rows, key) => new Map(rows.map(row => [row[key], row]));
  const slot = (...parts) => JSON.stringify(parts);
  const clock = minutes => [
    Math.floor(minutes / 60), minutes % 60,
  ].map(n => String(n).padStart(2, "0")).join(":");

  function open(bundle) {
    const { legacy, catalogue, ownership, requirements, routeLinks, serviceLinks } = bundle;
    if ([catalogue, ownership, requirements, routeLinks].some(x => x.schemaVersion !== 1)) {
      throw new Error("Unsupported ledger data version");
    }
    if (requirements.platform !== "PS5" || requirements.game !== "TSW7") {
      throw new Error("The service rules must be for Train Sim World 7 on PS5");
    }
    const products = index(ownership.items, "id");
    const routeProducts = new Map(Object.entries(routeLinks.legacyOwnership));
    const routeForProduct = new Map([...routeProducts].map(([route, id]) => [id, route]));
    const sourceRoutes = index(catalogue.routes, "id");
    const byRoute = index(routeLinks.routes, "routeId");
    const overrides = index(routeLinks.timetableOverrides, "timetableId");
    const timetables = index(catalogue.timetables, "id");
    for (const link of routeLinks.legacyVariants) {
      const timetable = timetables.get(link.timetableId);
      if (link.displayName && timetable) timetables.set(timetable.id, {...timetable, name: link.displayName});
    }
    const engines = index(requirements.locomotives, "id");
    const stockNames = new Map();
    for (const engine of requirements.locomotives) {
      for (const alias of engine.legacyNames || []) stockNames.set(alias, engine.name);
    }
    const locoName = name => stockNames.get(name) || name || "";
    const reviewed = new Map();
    for (const rule of requirements.rules) {
      const key = slot(rule.timetableId, rule.formation);
      if (reviewed.has(key)) throw new Error("Duplicate timetable and formation rule");
      reviewed.set(key, { rule, codes: rule.codePattern ? new RegExp(rule.codePattern) : null });
    }

    const originalRoutes = Object.create(null);
    const currentRoutes = Object.create(null);
    for (const [key, route] of Object.entries(legacy.routes)) {
      const product = products.get(routeProducts.get(key));
      originalRoutes[key] = {
        ...route, owned: product?.owned ?? null, compatible: product?.tsw7 ?? null,
      };
      currentRoutes[key] = { ...originalRoutes[key], variants: [] };
    }
    const routeForTimetable = new Map();
    for (const timetable of timetables.values()) {
      const link = overrides.get(timetable.id) || byRoute.get(timetable.routeId);
      const routeKey = link?.legacyKey || "route:" + timetable.routeId;
      routeForTimetable.set(timetable.id, routeKey);
      if (!currentRoutes[routeKey]) {
        const product = products.get(link?.ownershipId);
        currentRoutes[routeKey] = {
          name: sourceRoutes.get(timetable.routeId)?.name || timetable.sourceRouteName,
          owned: product?.owned ?? null, compatible: product?.tsw7 ?? null,
          locos: [], region: "", variants: [],
        };
      }
      currentRoutes[routeKey].variants.push({ name: timetable.name, sourceUrl: timetable.sourceUrl, id: timetable.id });
    }

    const currentRows = [];
    const currentByKey = new Map();
    for (const service of catalogue.services) {
      const timetable = timetables.get(service.timetableId);
      const progressKey = serviceLinks[service.id] || service.id;
      const match = reviewed.get(slot(timetable.id, service.formation));
      const rule = match && !(service.sourceRowCount > 1) && (!match.codes || match.codes.test(service.code))
        ? match.rule : null;
      const row = [progressKey, routeForTimetable.get(timetable.id), timetable.name, service.code, clock(service.departureMinutes)];
      const [sheet, table, train] = service.sourcePosition;
      Object.assign(row, {
        id: service.id, timetableId: timetable.id, from: service.from, to: service.to,
        durationMinutes: service.durationMinutes, formation: service.formation,
        rule, locomotives: rule?.playable ? rule.locomotiveIds.map(id => engines.get(id).name) : [],
        sourceUrl: [timetable.sourceUrl, sheet, table, train].join('/'),
        sourceRowCount: service.sourceRowCount || 1,
      });
      if (currentByKey.has(progressKey)) throw new Error("Conflicting progress identities");
      currentByKey.set(progressKey, row);
      currentRows.push(row);
    }

    function applyObservation(row, observation) {
      if (!observation) return;
      for (const field of ["from", "to", "formation", "durationMinutes", "title"]) {
        if (observation[field] != null) row[field] = observation[field];
      }
      if (observation.locomotive) row.locomotives = [observation.locomotive];
      if (observation.listing) row[4] = observation.listing.start;
      row.observation = observation.note;
      row.observationUrl = observation.evidenceUrl;
    }

    const legacyByKey = new Map();
    const legacyRows = legacy.services.map(values => {
      const row = [...values];
      // Only a reviewed, unique cross-source match may supply additional details.
      const current = currentByKey.get(row[0]);
      Object.assign(row, {
        id: row[0], from: current?.from, to: current?.to, durationMinutes: current?.durationMinutes ?? null,
        formation: current?.formation, locomotives: current?.locomotives || [],
        rule: current?.rule, sourceUrl: current?.sourceUrl,
      });
      const hud = bundle.hudCrosscheck?.records[row[0]];
      if (hud) {
        row.hud = hud;
        row.sourceUrl = bundle.hudCrosscheck.sourceUrl;
      }
      const observation = bundle.observations?.[row[0]];
      applyObservation(row, observation);
      legacyByKey.set(row[0], row);
      return row;
    });
    const legacyVariants = index(routeLinks.legacyVariants, "timetableId");

    const variantNames = new Map(routeLinks.legacyVariants.map(link =>
      [slot(link.legacyKey, link.variant), timetables.get(link.timetableId)?.name]));
    const workbookPatterns = new Map();
    for (const table of routeLinks.workbookTimetables || []) {
      const key = slot(table.legacyKey, table.variant);
      variantNames.set(key, table.name);
      workbookPatterns.set(key, new RegExp(table.codePattern));
      currentRoutes[table.legacyKey].variants.push({name: table.name});
    }
    // The extended Southeastern route is the one covered by the publisher's full timetable.
    variantNames.set(slot("SEH", "Southeastern High Speed Extended"), timetables.get("southeastern-highspeed")?.name);
    const confirmedSlots = new Map();
    const serviceSlot = row => slot(row[1], row[3].trim().toUpperCase(), row[4]);
    const confirmedRows = legacyRows.filter(row => row.hud || row.observation);
    for (const [id, observation] of Object.entries(bundle.observations || {})) {
      if (!observation.listing || legacyByKey.has(id)) continue;
      const {timetableId, code, start} = observation.listing;
      const timetable = timetables.get(timetableId);
      const row = [id, routeForTimetable.get(timetableId), timetable.name, code, start];
      Object.assign(row, {id, timetableId, locomotives: []});
      applyObservation(row, observation);
      confirmedRows.push(row);
    }
    for (const service of bundle.hudServices || []) {
      const original = legacyByKey.get(service.key);
      const name = timetables.get(service.timetableId)?.name || service.section ||
        original?.[2] || "HUD timetable · variant unknown";
      const row = [service.key, service.route, name, service.code, service.start.slice(0, 5)];
      Object.assign(row, {
        id: service.key, timetableId: service.timetableId, title: service.title,
        durationMinutes: service.durationMinutes, locomotives: [], hudListing: true,
        points: service.points, sourceUrl: bundle.hudCrosscheck.sourceUrl, hud: service,
      });
      confirmedRows.push(row);
    }
    for (const original of confirmedRows) {
      if (currentByKey.has(original[0])) {
        applyObservation(currentByKey.get(original[0]), bundle.observations?.[original[0]]);
        continue;
      }
      const row = Object.assign([...original], original);
      row[2] = variantNames.get(slot(row[1], row[2])) || row[2];
      currentRows.push(row);
      currentByKey.set(row[0], row);
      const identity = serviceSlot(row);
      confirmedSlots.set(identity, confirmedSlots.has(identity) ? null : row);
      const variants = currentRoutes[row[1]].variants;
      if (!variants.some(v => v.name === row[2])) variants.push({name: row[2]});
    }

    // A photographed menu identifies the variant. Workbook timings keep their own evidence level.
    for (const original of legacyRows) {
      const [id, route, variant, code] = original;
      const key = slot(route, variant);
      if (!workbookPatterns.get(key)?.test(code) || currentByKey.has(id)) continue;
      const row = Object.assign([...original], original, {source: "workbook"});
      row[2] = variantNames.get(key);
      currentRows.push(row);
      currentByKey.set(id, row);
    }

    // Published additions share a workbook tick only where the reviewed source identifies that job.
    const occupied = new Set(currentRows.map(row => slot(row[1], row[2], row[3].toUpperCase(), row[4])));
    for (const service of bundle.additionalServices || []) {
      const {id, route, variant, code, start} = service;
      const name = timetables.get(service.timetableId)?.name || variant;
      const identity = slot(route, name, code.toUpperCase(), start);
      if (currentByKey.has(id) || occupied.has(identity)) continue;
      const row = Object.assign([id, route, name, code, start], service, {
        locomotives: service.locomotive ? [service.locomotive] : [],
        durationMinutes: service.durationMinutes ?? null,
      });
      currentRows.push(row);
      currentByKey.set(id, row);
      occupied.add(identity);
      const variants = currentRoutes[route].variants;
      if (!variants.some(v => v.name === name)) variants.push({name});
    }

    function reconcile(state) {
      // A manually logged headcode and departure can now have a unique corroborated workbook row.
      const manualLinks = new Map();
      const manualSlots = new Map();
      for (const manual of state.manual || []) {
        const key = serviceSlot(manual);
        manualSlots.set(key, manualSlots.has(key) ? null : manual);
      }
      for (const [key, manual] of manualSlots) {
        const row = confirmedSlots.get(key);
        if (manual && row && manual[0].startsWith("manual:") &&
            !state.done[row[0]] && !state.unavailable[row[0]]) manualLinks.set(manual[0], row[0]);
      }
      if (manualLinks.size) {
        state.manual = state.manual.filter(row => !manualLinks.has(row[0]));
      }
      // New evidence may link two records after the user has already logged either one.
      for (const table of [state.done, state.unavailable, state.records]) {
        if (!table) continue;
        for (const id of Object.keys(table)) {
          const target = manualLinks.get(id) || serviceLinks[id];
          if (!target || target === id) continue;
          if (!Object.hasOwn(table, target) || (table === state.done &&
              String(table[id]?.date || "") > String(table[target]?.date || ""))) {
            table[target] = table[id];
          }
          delete table[id];
        }
      }
      for (const [key, record] of Object.entries(state.records || {})) {
        if (currentByKey.has(key) || !(state.done[key] || state.unavailable[key])) continue;
        if (!currentRoutes[record.routeKey]) {
          currentRoutes[record.routeKey] = {name: record.routeName || record.routeKey, owned: null,
            compatible: null, locos: [], region: "", variants: []};
        }
      }
    }

    function remember(row, state) {
      if (!row || row.retired || !currentByKey.has(row[0])) return;
      const current = currentByKey.get(row[0]);
      state.records ||= {};
      state.records[row[0]] = {
        id: current.id, routeKey: current[1], routeName: currentRoutes[current[1]].name,
        variant: current[2], code: current[3], time: current[4], from: current.from,
        to: current.to, formation: current.formation, durationMinutes: current.durationMinutes,
      };
    }

    function services(source, state) {
      const manualRows = (state.manual || []).map(row => Object.assign([...row], {
        id: row[0], locomotives: [], manual: true, durationMinutes: null,
      }));
      if (source === "legacy") return legacyRows.concat(manualRows);
      const rows = currentRows.concat(manualRows);
      for (const [key, record] of Object.entries(state.records || {})) {
        if (currentByKey.has(key) || !(state.done[key] || state.unavailable[key])) continue;
        const row = [key, record.routeKey, record.variant, record.code, record.time];
        rows.push(Object.assign(row, { ...record, retired: true, locomotives: [] }));
      }
      return rows;
    }

    function productStatus(id, state) {
      const item = products.get(id);
      if (!item) return "unknown";
      const route = routeForProduct.get(id);
      const owned = (route && Object.hasOwn(state.owner || {}, route)) ? state.owner[route] : item.owned;
      if (owned === false || item.tsw7 === false) return "missing";
      if (owned === true && item.tsw7 === true) return "owned";
      return "unknown";
    }

    function availability(row, state) {
      const rule = row.rule;
      if (!rule?.playable || !row.locomotives.length || !rule.requiresAny?.length) return "unknown";
      let unknown = false;
      for (const alternative of rule.requiresAny) {
        if (!alternative.length) { unknown = true; continue; }
        const statuses = alternative.map(id => productStatus(id, state));
        if (statuses.every(s => s === "owned")) return "owned";
        if (!statuses.includes("missing")) unknown = true;
      }
      return unknown ? "unknown" : "missing";
    }

    function chooseShift(state, {minMinutes = null, maxMinutes = null} = {}, random = Math.random) {
      const invalid = n => n != null && (!Number.isInteger(n) || n < 0);
      if (invalid(minMinutes) || invalid(maxMinutes) ||
          (minMinutes != null && maxMinutes != null && minMinutes > maxMinutes)) return null;
      // A prior workbook tick with the same headcode but a different published time
      // can be the same drive. Withhold the suggestion without transferring its tick.
      const uncertain = new Set();
      for (const key of [...Object.keys(state.done), ...Object.keys(state.unavailable)]) {
        const old = legacyByKey.get(key);
        if (old && !currentByKey.has(key)) uncertain.add(slot(old[1], old[2], old[3]));
      }
      const manual = (state.manual || []).filter(row => state.done[row[0]] || state.unavailable[row[0]]);
      const eligible = currentRows.filter(row => {
        if (state.done[row[0]] || state.unavailable[row[0]] || availability(row, state) !== "owned") return false;
        const duration = row.durationMinutes;
        if ((minMinutes != null || maxMinutes != null) && duration == null) return false;
        if ((minMinutes != null && duration < minMinutes) || (maxMinutes != null && duration > maxMinutes)) return false;
        const old = legacyVariants.get(row.timetableId);
        if (old && uncertain.has(slot(old.legacyKey, old.variant, row[3]))) return false;
        return !manual.some(log => log[1] === row[1] && (!log[4] || log[4] === row[4]) &&
          log[3].trim().toLowerCase() === row[3].toLowerCase());
      });
      return eligible.length ? eligible[Math.floor(random() * eligible.length)] : null;
    }

    return {routes: source => source === "legacy" ? originalRoutes : currentRoutes,
      services, availability, remember, chooseShift, reconcile, locoName};
  }

  return {open};
})();
if (typeof module !== "undefined" && module.exports) module.exports = TSWLedger;
