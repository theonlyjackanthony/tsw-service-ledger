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
    for (const timetable of catalogue.timetables) {
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
      const observation = bundle.observations?.[row[0]];
      if (observation) Object.assign(row, {
        from: observation.from, to: observation.to, formation: observation.formation,
        locomotives: [observation.locomotive], title: observation.title, observation: observation.note,
      });
      legacyByKey.set(row[0], row);
      return row;
    });
    const legacyVariants = index(routeLinks.legacyVariants, "timetableId");

    function reconcile(state) {
      // New evidence may link two records after the user has already logged either one.
      for (const table of [state.done, state.unavailable, state.records]) {
        if (!table) continue;
        for (const id of Object.keys(table)) {
          const target = serviceLinks[id];
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
