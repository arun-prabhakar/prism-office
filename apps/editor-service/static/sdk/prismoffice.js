/* PrismOffice editor SDK — bundle of @prismoffice/sdk-shared. Registers window.PrismOfficeAPI. */
"use strict";
(() => {
  // ../../packages/sdk-shared/src/postmessage-protocol.ts
  var PROTOCOL_VERSION = 1;
  function isIframeMessage(m) {
    if (typeof m !== "object" || m === null) return false;
    const t = m.type;
    return t === "app-ready" || t === "event" || t === "method-response";
  }

  // ../../packages/sdk-shared/src/jwt.ts
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  function base64UrlEncode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlDecode(s) {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function hmacKey(secret) {
    return crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
  }
  async function signJwt(payload, secret) {
    const header = { alg: "HS256", typ: "JWT" };
    const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    const key = await hmacKey(secret);
    const sigBuf = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)));
    return `${signingInput}.${base64UrlEncode(sigBuf)}`;
  }
  function toArrayBuffer(u) {
    const copy = new ArrayBuffer(u.byteLength);
    new Uint8Array(copy).set(u);
    return copy;
  }
  async function verifyJwt(token, secret) {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;
    try {
      const key = await hmacKey(secret);
      const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        toArrayBuffer(base64UrlDecode(sigB64)),
        toArrayBuffer(enc.encode(signingInput))
      );
      if (!valid) return null;
      const header = JSON.parse(dec.decode(base64UrlDecode(headerB64)));
      if (header.alg !== "HS256" || header.typ !== "JWT") return null;
      return JSON.parse(dec.decode(base64UrlDecode(payloadB64)));
    } catch {
      return null;
    }
  }

  // ../../packages/sdk-shared/src/jwt-sign-browser.ts
  async function signConfig(config, secret) {
    const payload = {
      document: config.document,
      editorConfig: config.editorConfig,
      documentType: config.documentType,
      type: config.type
    };
    return signJwt(payload, secret);
  }
  async function verifyConfigToken(token, secret) {
    return verifyJwt(token, secret);
  }

  // ../../packages/sdk-shared/src/index.ts
  var DocEditor = class {
    /** Resolved editor-service origin (derived from the SDK <script> src). */
    editorOrigin;
    config;
    placeholderId;
    iframe;
    messageListener;
    iframeReady = false;
    destroyed = false;
    methodCounter = 0;
    pendingMethods = /* @__PURE__ */ new Map();
    constructor(placeholderId, config) {
      this.placeholderId = placeholderId;
      this.config = config;
      const errors = validateConfig(config);
      if (errors.length > 0) {
        const msg = `PrismOffice DocEditor: invalid config \u2014 ${errors.join("; ")}`;
        if (typeof window !== "undefined" && typeof window.alert === "function") {
          window.alert(msg);
        }
        throw new Error(msg);
      }
      this.editorOrigin = resolveEditorOrigin();
      const placeholder = document.getElementById(placeholderId);
      if (!placeholder) {
        throw new Error(`PrismOffice DocEditor: placeholder "#${placeholderId}" not found`);
      }
      this.iframe = createIframe(this.editorOrigin, config);
      placeholder.parentNode?.replaceChild(this.iframe, placeholder);
      this.messageListener = (e) => this.onMessage(e);
      window.addEventListener("message", this.messageListener);
    }
    // -----------------------------------------------------------------------
    // Public methods (paired with the request-events; mirror ONLYOFFICE).
    // -----------------------------------------------------------------------
    /** Tear down: remove iframe, remove listener, reject pending calls. */
    destroyEditor() {
      if (this.destroyed) return;
      this.destroyed = true;
      window.removeEventListener("message", this.messageListener);
      this.postMessage({ type: "destroy" });
      this.iframe.parentNode?.removeChild(this.iframe);
      for (const { reject } of this.pendingMethods.values()) {
        reject(new Error("editor destroyed"));
      }
      this.pendingMethods.clear();
    }
    /** Trigger a download of the current doc via `onDownloadAs`. */
    downloadAs() {
      return this.callMethod("downloadAs", []);
    }
    /** Respond to `onRequestInsertImage` with the chosen image. */
    insertImage(payload) {
      return this.callMethod("insertImage", [payload]);
    }
    /** Respond to `onRequestHistory` with the version list. */
    refreshHistory(history) {
      return this.callMethod("refreshHistory", [history]);
    }
    /** Respond to `onRequestHistoryData` with the version's bytes URL. */
    setHistoryData(data) {
      return this.callMethod("setHistoryData", [data]);
    }
    /** Respond to `onMakeActionLink` (v1.1). */
    setActionLink(_url) {
    }
    /** (v2 collab) set users for @-mentions. Harmless in v1. */
    setUsers(_users) {
    }
    /** Respond to `onRequestRefreshFile` / `onOutdatedVersion`. */
    refreshFile(file) {
      return this.callMethod("refreshFile", [file]);
    }
    /** Programmatically request the host re-init in edit mode (matches ONLYOFFICE). */
    requestEditRights() {
      this.config.events?.onRequestEditRights?.call(this);
    }
    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------
    async onMessage(e) {
      if (this.destroyed) return;
      if (e.source !== this.iframe.contentWindow) return;
      if (e.origin !== this.editorOrigin) return;
      const msg = e.data;
      if (!isIframeMessage(msg)) return;
      if (msg.type === "app-ready") {
        this.iframeReady = true;
        this.postMessage({
          type: "init",
          protocol: PROTOCOL_VERSION,
          config: sanitizeConfigForClone(this.config)
        });
        const onAppReady = this.config.events?.onAppReady;
        if (typeof onAppReady === "function") onAppReady.call(this);
        return;
      }
      if (msg.type === "event") {
        const handler = this.config.events?.[msg.name];
        if (typeof handler === "function") {
          handler.call(this, { target: this, data: msg.data });
        }
        return;
      }
      if (msg.type === "method-response") {
        const pending = this.pendingMethods.get(msg.id);
        if (!pending) return;
        this.pendingMethods.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      }
    }
    callMethod(method, args) {
      if (this.destroyed) return Promise.reject(new Error("editor destroyed"));
      const id = `m${++this.methodCounter}`;
      return new Promise((resolve, reject) => {
        this.pendingMethods.set(id, { resolve, reject });
        this.postMessage({ type: "method", id, method, args });
      });
    }
    postMessage(msg) {
      this.iframe.contentWindow?.postMessage(msg, this.editorOrigin);
    }
  };
  function validateConfig(c) {
    const errors = [];
    if (!c.document?.url) errors.push("document.url is required");
    if (!c.document?.key || typeof c.document.key !== "string") {
      errors.push("document.key is required (string)");
    }
    if (c.document?.key && !/^[0-9a-zA-Z\-_.=]{1,128}$/.test(c.document.key)) {
      errors.push("document.key must be 1-128 chars of [0-9a-zA-Z-_.=]");
    }
    if (!c.document?.fileType && !c.documentType) {
      errors.push("either document.fileType or documentType is required");
    }
    if (c.editorConfig?.mode === "edit" && !c.editorConfig?.callbackUrl) {
      errors.push("editorConfig.callbackUrl is required for edit mode");
    }
    return errors;
  }
  function sanitizeConfigForClone(config) {
    function strip(value) {
      if (typeof value === "function") return void 0;
      if (Array.isArray(value)) return value.map(strip);
      if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
          const stripped = strip(v);
          if (stripped !== void 0) out[k] = stripped;
        }
        return out;
      }
      return value;
    }
    return strip(config);
  }
  function createIframe(editorOrigin, config) {
    const iframe = document.createElement("iframe");
    const docType = config.documentType;
    iframe.src = `${editorOrigin}/editor/${docType}/`;
    iframe.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
    iframe.setAttribute("frameborder", "0");
    iframe.style.border = "0";
    iframe.style.width = config.width ?? "100%";
    iframe.style.height = config.height ?? "100%";
    return iframe;
  }
  function resolveEditorOrigin() {
    if (typeof document === "undefined") {
      throw new Error("PrismOffice DocEditor must be constructed in a browser context");
    }
    const scripts = document.querySelectorAll(
      'script[src*="/sdk/prismoffice"], script[data-prismoffice-sdk]'
    );
    for (let i = scripts.length - 1; i >= 0; i--) {
      const s = scripts[i];
      const explicit = s.getAttribute("data-editor-origin");
      if (explicit) return explicit.replace(/\/$/, "");
      const src = s.getAttribute("src");
      if (src) {
        try {
          const u = new URL(src, document.baseURI);
          return u.origin;
        } catch {
        }
      }
    }
    return window.location.origin;
  }
  if (typeof window !== "undefined") {
    window.PrismOfficeAPI = { DocEditor };
  }
})();
