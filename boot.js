"use strict";

(() => {
  const base = new URL("./", location.href);
  const keySlot = "tsw-ledger-unlock:" + base.pathname;
  const main = document.querySelector("main:not(#ledgerGate)");
  const gate = document.getElementById("ledgerGate") || document.createElement("main");
  gate.id = "ledgerGate";
  if (!gate.isConnected) document.body.prepend(gate);
  if (main) main.hidden = true;
  gate.hidden = false;

  const panel = document.createElement("div");
  panel.className = "panel";
  const title = document.createElement("h1");
  title.textContent = "Driver’s Companion";
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.htmlFor = "ledgerPrivateLink";
  label.textContent = "Private ledger link";
  const linkInput = document.createElement("input");
  linkInput.id = label.htmlFor;
  linkInput.type = "password";
  linkInput.autocomplete = "off";
  linkInput.spellcheck = false;
  linkInput.autocapitalize = "none";
  linkInput.placeholder = "Paste the full private link";
  linkInput.required = true;
  const actions = document.createElement("div");
  actions.className = "rowflex";
  const submit = document.createElement("button");
  submit.className = "primary";
  submit.type = "submit";
  submit.textContent = "Unlock ledger";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Try again";
  actions.append(submit, retry);
  form.append(label, linkInput, actions);
  panel.append(title, message, form);
  gate.replaceChildren(panel);

  let attempt = 0;
  let appStarted = false;
  let appKey = "";
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const cookieName = "tsw-ledger-device-" + encodeURIComponent(base.pathname);
  const homePattern = /^#home=([A-Za-z0-9_-]{54})$/;
  const keyPattern = /^#k=([A-Za-z0-9_-]{43})$/;
  const privateLinkHint = "Open the original private ledger link, or paste it below to unlock this device.";

  function status(text, canEnterLink, canRetry = false) {
    gate.hidden = false;
    message.textContent = text;
    form.hidden = !canEnterLink && !canRetry;
    label.hidden = linkInput.hidden = submit.hidden = !canEnterLink;
    linkInput.disabled = !canEnterLink;
    retry.hidden = !canRetry;
  }

  function savedKey() {
    try { return localStorage.getItem(keySlot) || ""; }
    catch { return ""; }
  }

  function encodeBytes(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeBytes(text, length) {
    if (text.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const padding = "=".repeat((4 - text.length % 4) % 4);
    const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
    if (bytes.length !== length || encodeBytes(bytes) !== text) throw new Error();
    return bytes;
  }

  function cookieValue() {
    const prefix = cookieName + "=";
    return document.cookie.split(";").map(pair => pair.trim()).find(pair => pair.startsWith(prefix))?.slice(prefix.length) || "";
  }

  async function deviceKey(create) {
    let value = cookieValue();
    if (!value && create) {
      value = encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
      document.cookie = cookieName + "=" + value + "; Path=" + base.pathname +
        "; Max-Age=34560000; Secure; SameSite=Strict";
      if (cookieValue() !== value) throw new Error("device-storage-unavailable");
    }
    return crypto.subtle.importKey("raw", decodeBytes(value, 32), "AES-KW", false, ["wrapKey", "unwrapKey"]);
  }

  async function readKey() {
    if (!location.hash) return savedKey();
    const privateKey = keyPattern.exec(location.hash)?.[1];
    if (privateKey) return privateKey;
    const home = homePattern.exec(location.hash)?.[1];
    if (!home || !isIOS) return "";
    try {
      const unwrapped = await crypto.subtle.unwrapKey("raw", decodeBytes(home, 40), await deviceKey(false),
        "AES-KW", "AES-GCM", true, ["decrypt"]);
      return encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", unwrapped)));
    } catch { return savedKey(); }
  }

  function hasCatalogue(data) {
    return data && data.catalogue?.schemaVersion === 1 && Array.isArray(data.catalogue.services) &&
      Array.isArray(data.legacy?.services) && Array.isArray(data.ownership?.items) &&
      Array.isArray(data.requirements?.rules) && data.routeLinks?.schemaVersion === 1 &&
      data.serviceLinks && typeof data.serviceLinks === "object";
  }

  async function installManifest(text) {
    if (!isIOS) return;
    const wrappingKey = await deviceKey(true);
    const ledgerKey = await crypto.subtle.importKey("raw", decodeBytes(text, 32), "AES-GCM", true, ["decrypt"]);
    const wrapped = await crypto.subtle.wrapKey("raw", ledgerKey, wrappingKey, "AES-KW");
    const startUrl = new URL(base);
    startUrl.hash = "home=" + encodeBytes(new Uint8Array(wrapped));
    // Installation metadata carries only a device-wrapped value. Safari copies the secure
    // wrapping cookie into the new isolated Home Screen app on supported iOS versions.
    // All URLs used inside the manifest must resolve independently of that blob URL.
    const icon = (size) => ({
      src: new URL("icons/ledger-" + size + ".png", base).href,
      sizes: size + "x" + size, type: "image/png"
    });
    const manifest = {
      id: base.href, name: "TSW Driver’s Companion", short_name: "TSW Companion", lang: "en-GB",
      start_url: startUrl.href, scope: base.href, display: "standalone",
      background_color: "#10191c", theme_color: "#10191c", icons: [icon(192), {...icon(512), purpose: "any maskable"}]
    };
    const blob = new Blob([JSON.stringify(manifest)], {type: "application/manifest+json"});
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "manifest";
      document.head.append(link);
    }
    link.href = URL.createObjectURL(blob);
  }

  async function decodeBundle(plain) {
    const bytes = new Uint8Array(plain);
    let buffer = bytes;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === "undefined") throw new Error("gzip-unavailable");
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      buffer = await new Response(stream).arrayBuffer();
    }
    const data = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(buffer));
    if (!hasCatalogue(data)) throw new Error("invalid-catalogue");
    return data;
  }

  async function unlock() {
    const current = ++attempt;
    const text = await readKey();
    if (current !== attempt) return;
    if (appStarted) {
      if (appKey !== text) location.reload();
      return;
    }
    if (!window.isSecureContext || !globalThis.crypto?.subtle) {
      status("Open this ledger over HTTPS in a current browser to unlock it.", false);
      return;
    }
    let raw;
    try { raw = decodeBytes(text, 32); }
    catch {
      status(location.hash.startsWith("#home=") || !location.hash ? privateLinkHint : "This link is incomplete. " + privateLinkHint, true);
      return;
    }
    status("Opening your private ledger…", false);
    let bytes;
    try {
      const response = await fetch(new URL("data/ledger.enc", base), {
        referrerPolicy: "no-referrer", credentials: "omit"
      });
      if (!response.ok) throw new Error();
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 29) throw new Error();
    } catch {
      if (current === attempt) status("The private timetable download is unavailable. Reconnect and try again.", false, true);
      return;
    }
    let plain;
    try {
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      plain = await crypto.subtle.decrypt({name: "AES-GCM", iv: bytes.subarray(0, 12), tagLength: 128}, key, bytes.subarray(12));
    } catch {
      if (current === attempt) status("That link could not unlock this timetable. " + privateLinkHint, true, true);
      return;
    }
    if (current !== attempt) return;
    let data;
    try { data = await decodeBundle(plain); }
    catch (error) {
      if (current === attempt) status(error.message === "gzip-unavailable"
        ? "This browser needs an update to open the compressed timetable."
        : "The timetable file could not be read. Reconnect and try again.", false, true);
      return;
    }
    if (current !== attempt) return;
    const start = new URL(base);
    start.hash = "k=" + text;
    // Keeping the fragment in the bookmark also works when device storage is unavailable.
    if (!location.hash) {
      try { history.replaceState(history.state, "", location.pathname + location.search + start.hash); }
      catch { /* The manifest and the original private link remain usable. */ }
    }
    try { localStorage.setItem(keySlot, text); }
    catch { /* A private tab can still use the original link. */ }
    try { await installManifest(text); }
    catch { /* A saved private link can still launch the page directly. */ }

    if (current !== attempt) return;
    appKey = text;
    appStarted = true;
    window.LEDGER_DATA = data;
    const script = document.createElement("script");
    script.src = new URL("app.js", base).href;
    script.referrerPolicy = "no-referrer";
    script.onload = () => {
      gate.hidden = true;
      if (main) main.hidden = false;
    };
    script.onerror = () => {
      appStarted = false;
      appKey = "";
      delete window.LEDGER_DATA;
      script.remove();
      status("The ledger app could not load. Reconnect and try again.", false, true);
    };
    document.head.append(script);
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = linkInput.value.trim();
    linkInput.value = "";
    let link;
    try { link = new URL(value); } catch { /* Show the same recovery message. */ }
    if (!link || link.origin !== location.origin || new URL("./", link).pathname !== base.pathname ||
        !keyPattern.test(link.hash)) {
      status("Paste the full private link for this ledger, including the part after #.", true);
      return;
    }
    if (location.hash === link.hash) unlock();
    else location.hash = link.hash;
  });
  retry.addEventListener("click", unlock);
  window.addEventListener("hashchange", unlock);
  if (window.isSecureContext && "serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL("sw.js", base).href).catch(() => {
      // The network version still works when the browser disallows offline storage.
    });
  }
  unlock();
})();
