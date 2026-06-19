/* ============================================================================
   VELLUM — a private journal that lives entirely in YOUR Google Drive.
   ----------------------------------------------------------------------------
   Plain JavaScript, no build step. The whole app is below, grouped into
   sections you can search for:
     [CONFIG]   constants & moods
     [STATE]    the app's memory while open
     [UTILS]    small helpers (dates, ids, escaping, blobs)
     [AUTH]     Google sign-in
     [DRIVE]    reading & writing files in your Drive
     [IMAGES]   HEIC conversion, orientation, thumbnails, loading
     [RENDER]   drawing the three screens
     [PRINT]    print / export to PDF with the original full-res photo
   ============================================================================ */

/* ----------------------------------- [CONFIG] ---------------------------- */
const CFG = window.VELLUM_CONFIG;
const SCOPE = "https://www.googleapis.com/auth/drive.file"; // app sees only files IT creates

// Moods (label, colour, soft tint) — taken straight from the design.
const MOODS = {
  calm:     { label: "Calm",     color: "#5E847E", tint: "rgba(94,132,126,0.15)" },
  grateful: { label: "Grateful", color: "#B5862F", tint: "rgba(181,134,47,0.16)" },
  hopeful:  { label: "Hopeful",  color: "#6E8553", tint: "rgba(110,133,83,0.16)" },
  tender:   { label: "Tender",   color: "#A86F79", tint: "rgba(168,111,121,0.16)" },
  heavy:    { label: "Heavy",    color: "#5F6E88", tint: "rgba(95,110,136,0.16)" },
  restless: { label: "Restless", color: "#B0563A", tint: "rgba(176,86,58,0.15)" }
};
const MOOD_ORDER = ["calm", "grateful", "hopeful", "tender", "heavy", "restless"];

const PROMPT_CATS = window.VELLUM_PROMPTS.categories;
const PROMPTS     = window.VELLUM_PROMPTS.prompts;

/* ----------------------------------- [STATE] ----------------------------- */
const state = {
  screen: "signin",        // signin | timeline | writing | entry
  ready: false,            // have we loaded entries from Drive yet?
  entries: [],             // [{ fileId, id, date, title, mood, blocks:[...] }]
  // timeline filters
  query: "", moodFilter: "", dateFilter: "",
  // writing
  draft: null,             // { date,title,mood,blocks,editId,fileId }
  promptOpen: false, promptCat: PROMPT_CATS[0].key, promptIndex: 0,
  // single entry view
  viewId: null,
  // status / errors
  busy: "", error: ""
};

// Folder ids, found/created once per session.
let JOURNAL_ID = null;
let ATTACH_ID = null;

// Object-URL cache so a photo is downloaded from Drive only once per session.
const blobCache = new Map();   // driveFileId -> objectURL

const $app = () => document.getElementById("app");

/* ----------------------------------- [UTILS] ----------------------------- */
const uid = (p) => p + Math.random().toString(36).slice(2, 9);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function parseISO(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
function todayISO() { const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }

function fmt(iso) {
  const dt = parseISO(iso);
  const wd  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dt.getDay()];
  const wdL = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dt.getDay()];
  const moL = ["January","February","March","April","May","June","July","August","September","October","November","December"][dt.getMonth()];
  return {
    dayNum: dt.getDate(), weekday: wd,
    monthLabel: moL + " " + dt.getFullYear(),
    full: wdL + ", " + moL + " " + dt.getDate() + ", " + dt.getFullYear()
  };
}

function firstText(e) { const b = e.blocks.find((x) => x.type === "text" && x.text.trim());
  return b ? b.text.replace(/\s+/g, " ").trim() : ""; }
function firstImageBlock(e) { return e.blocks.find((x) => x.type === "image") || null; }

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

// Run async jobs with a small concurrency limit (kind to Drive + the network).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function setError(msg) { state.error = msg || ""; if (msg) console.error("[Vellum]", msg); render(); }

/* ----------------------------------- [AUTH] ------------------------------ */
let tokenClient = null, accessToken = null, tokenExpiry = 0;

function initAuth() {
  if (!window.google || !google.accounts) return; // GIS script not ready yet
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPE, callback: () => {}
  });
}

// Returns a valid access token, asking the user to sign in only when needed.
function getToken(interactive) {
  return new Promise((resolve, reject) => {
    if (accessToken && Date.now() < tokenExpiry - 60000) return resolve(accessToken);
    if (!tokenClient) return reject(new Error("Google sign-in is still loading. Try again in a moment."));
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
      resolve(accessToken);
    };
    // '' = silent if already granted this session; 'consent' forces the popup.
    tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
  });
}

async function signIn() {
  try {
    state.error = ""; state.busy = "Signing in…"; render();
    await getToken(true);
    await ensureFolders();
    await loadEntries();
    state.ready = true; state.screen = "timeline"; state.busy = ""; render();
  } catch (e) {
    state.busy = ""; setError("Sign-in failed: " + e.message);
  }
}

function signOut() {
  if (accessToken && window.google) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null; tokenExpiry = 0;
  blobCache.forEach((url) => URL.revokeObjectURL(url)); blobCache.clear();
  Object.assign(state, { screen: "signin", ready: false, entries: [], draft: null, viewId: null });
  JOURNAL_ID = ATTACH_ID = null;
  render();
}

/* ----------------------------------- [DRIVE] ----------------------------- */
// Every Drive request goes through here so we can attach the token and retry
// once if it expired mid-session.
async function driveFetch(url, opts = {}) {
  const token = await getToken(false);
  opts.headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + token });
  let r = await fetch(url, opts);
  if (r.status === 401) { accessToken = null; const t2 = await getToken(false);
    opts.headers.Authorization = "Bearer " + t2; r = await fetch(url, opts); }
  if (!r.ok) throw new Error("Drive error " + r.status + ": " + (await r.text()).slice(0, 200));
  return r;
}

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

async function findOne(query) {
  const url = DRIVE + "/files?q=" + encodeURIComponent(query) +
    "&fields=files(id,name)&spaces=drive&pageSize=1";
  const data = await (await driveFetch(url)).json();
  return (data.files && data.files[0]) || null;
}

async function createFolder(name, parentId, marker) {
  const meta = { name, mimeType: "application/vnd.google-apps.folder",
    appProperties: { vellum: marker } };
  if (parentId) meta.parents = [parentId];
  const r = await driveFetch(DRIVE + "/files?fields=id,name",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) });
  return (await r.json()).id;
}

// Find the Journal folder + attachments subfolder, creating them on first run.
async function ensureFolders() {
  state.busy = "Opening your Journal folder…"; render();
  let root = await findOne("appProperties has { key='vellum' and value='root' } and mimeType='application/vnd.google-apps.folder' and trashed=false");
  if (!root) { const id = await createFolder(CFG.JOURNAL_FOLDER_NAME, null, "root"); JOURNAL_ID = id; }
  else JOURNAL_ID = root.id;

  let att = await findOne("appProperties has { key='vellum' and value='attachments' } and mimeType='application/vnd.google-apps.folder' and trashed=false");
  if (!att) ATTACH_ID = await createFolder(CFG.ATTACHMENTS_FOLDER_NAME, JOURNAL_ID, "attachments");
  else ATTACH_ID = att.id;
}

// multipart upload (metadata + bytes in one request). Returns the new file id.
async function uploadFile(metadata, blob, existingId) {
  const boundary = "vellum" + Math.random().toString(36).slice(2);
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, blob, tail], { type: "multipart/related; boundary=" + boundary });
  const url = UPLOAD + "/files" + (existingId ? "/" + existingId : "") +
    "?uploadType=multipart&fields=id,name";
  const r = await driveFetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
  return (await r.json()).id;
}

async function downloadBlob(fileId) {
  const r = await driveFetch(DRIVE + "/files/" + fileId + "?alt=media");
  return await r.blob();
}

async function deleteFileFromDrive(fileId) {
  try { await driveFetch(DRIVE + "/files/" + fileId, { method: "DELETE" }); }
  catch (e) { console.warn("Could not delete", fileId, e); }
}

// Load every entry's JSON from Drive into memory (attachments load on demand).
async function loadEntries() {
  state.busy = "Loading your entries…"; render();
  const q = "appProperties has { key='vellum' and value='entry' } and trashed=false";
  let files = [], pageToken = "";
  do {
    const url = DRIVE + "/files?q=" + encodeURIComponent(q) +
      "&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=100&orderBy=name desc" +
      (pageToken ? "&pageToken=" + pageToken : "");
    const data = await (await driveFetch(url)).json();
    files = files.concat(data.files || []); pageToken = data.nextPageToken || "";
  } while (pageToken);

  const entries = await mapLimit(files, 8, async (f) => {
    try {
      const text = await (await driveFetch(DRIVE + "/files/" + f.id + "?alt=media")).text();
      const obj = JSON.parse(text);
      obj.fileId = f.id;
      if (!obj.id) obj.id = f.id;
      if (!Array.isArray(obj.blocks)) obj.blocks = [];
      return obj;
    } catch (e) { console.warn("Skipping unreadable entry", f.name, e); return null; }
  });
  state.entries = entries.filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1));
}

// Save the current draft as one JSON file in the Journal folder.
async function saveDraftToDrive(draft) {
  // Strip transient fields from blocks before saving.
  const blocks = draft.blocks
    .filter((b) => b.type !== "text" || b.text.trim() !== "")
    .map((b) => {
      if (b.type === "image") return { type: "image", originalId: b.originalId,
        displayId: b.displayId, thumb: b.thumb, name: b.name, mime: b.mime, w: b.w, h: b.h };
      if (b.type === "file") return { type: "file", fileId: b.fileId, name: b.name,
        ext: b.ext, size: b.size };
      return { type: "text", text: b.text };
    });
  if (!blocks.length) blocks.push({ type: "text", text: "" });

  const entry = {
    id: draft.editId || uid("e"),
    date: draft.date,
    title: draft.title.trim() || "Untitled",
    mood: draft.mood || "",
    blocks,
    updatedAt: new Date().toISOString()
  };
  if (!draft.editId) entry.createdAt = entry.updatedAt;

  const safe = entry.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 50) || "entry";
  const metadata = {
    name: entry.date + "-" + safe + ".json",
    mimeType: "application/json",
    appProperties: { vellum: "entry", entryId: entry.id }
  };
  if (!draft.fileId) metadata.parents = [JOURNAL_ID];

  const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
  const fileId = await uploadFile(metadata, blob, draft.fileId || null);
  entry.fileId = fileId;
  return entry;
}

/* ----------------------------------- [IMAGES] ---------------------------- */
function isImageFile(file) {
  if (file.type && file.type.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif)$/i.test(file.name || "");
}
function isHeic(file) {
  return /heic|heif/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "");
}

// Decode any image (incl. HEIC) into a bitmap with EXIF orientation applied.
async function decodeBitmap(blob, heic) {
  let src = blob;
  if (heic) {
    const out = await heic2any({ blob, toType: "image/jpeg", quality: 0.95 });
    src = Array.isArray(out) ? out[0] : out;
  }
  try { return await createImageBitmap(src, { imageOrientation: "from-image" }); }
  catch (e) { return await createImageBitmap(src); } // older browsers: still upright for most photos
}

// Draw a bitmap scaled to fit maxDim and return a JPEG blob.
function bitmapToJpeg(bitmap, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

// Turn one picked file into a draft block, uploading it to Drive.
// Reports progress through onStatus so the UI can show a spinner.
async function processAttachment(file, onStatus) {
  if (isImageFile(file)) {
    const heic = isHeic(file);
    onStatus("Reading photo…");
    const bitmap = await decodeBitmap(file, heic);

    onStatus("Preparing…");
    const display = await bitmapToJpeg(bitmap, 2000, 0.9); // crisp on-screen version (orientation baked in)
    const thumbBlob = await bitmapToJpeg(bitmap, 420, 0.8);
    const thumb = await blobToDataURL(thumbBlob);

    // The ORIGINAL bytes go to Drive untouched (used later for high-res printing).
    const origName = file.name || ("photo-" + Date.now() + (heic ? ".heic" : ".jpg"));
    onStatus("Uploading original…");
    const originalId = await uploadFile(
      { name: origName, appProperties: { vellum: "attachment" }, parents: [ATTACH_ID] },
      file.type ? file : new Blob([file], { type: heic ? "image/heic" : "image/jpeg" }));

    onStatus("Uploading display copy…");
    const displayId = await uploadFile(
      { name: "display-" + origName.replace(/\.[^.]+$/, "") + ".jpg",
        appProperties: { vellum: "attachment" }, parents: [ATTACH_ID] }, display);

    // Cache the display blob so it shows instantly without re-downloading.
    blobCache.set(displayId, URL.createObjectURL(display));

    return { type: "image", originalId, displayId, thumb, name: origName,
      mime: heic ? "image/heic" : (file.type || "image/jpeg"), w: bitmap.width, h: bitmap.height };
  }

  // Non-image file (PDF, docx, …) — store as-is.
  onStatus("Uploading file…");
  const ext = (file.name.split(".").pop() || "FILE").slice(0, 4).toUpperCase();
  const fileId = await uploadFile(
    { name: file.name, appProperties: { vellum: "attachment" }, parents: [ATTACH_ID] }, file);
  return { type: "file", fileId, name: file.name, ext, size: file.size };
}

// Make sure an image block's display blob is available; download if needed.
async function ensureDisplay(block) {
  if (blobCache.has(block.displayId)) return blobCache.get(block.displayId);
  const blob = await downloadBlob(block.displayId);
  const url = URL.createObjectURL(blob);
  blobCache.set(block.displayId, url);
  return url;
}

/* ----------------------------------- [RENDER] ---------------------------- */
function render() {
  const root = $app();
  if (state.error) { root.innerHTML = errorBar(state.error) + screenHTML(); }
  else root.innerHTML = screenHTML();
  mount();
}

function errorBar(msg) {
  return `<div data-noprint style="position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;
    background:#3a1c16;color:#ffd9cc;font:13px/1.5 'Mulish',sans-serif;padding:12px 16px;border-radius:8px;
    box-shadow:0 6px 24px rgba(0,0,0,.25);">
    ${esc(msg)} <button onclick="window.__vel.dismissError()" style="float:right;background:none;border:none;color:#ffd9cc;cursor:pointer;font-size:16px;">×</button></div>`;
}

function screenHTML() {
  switch (state.screen) {
    case "signin":   return signinHTML();
    case "timeline": return timelineHTML();
    case "writing":  return writingHTML();
    case "entry":    return entryHTML();
    default:         return "";
  }
}

/* ---- sign-in ---- */
function signinHTML() {
  const configured = CFG.GOOGLE_CLIENT_ID && !CFG.GOOGLE_CLIENT_ID.startsWith("PASTE_");
  return `
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div style="text-align:center;max-width:420px;animation:velFade .5s ease both;">
      <div style="font-family:'Mulish',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.32em;
        text-transform:uppercase;color:var(--accent);margin-bottom:10px;">A private journal</div>
      <h1 style="font-family:'Spectral',serif;font-weight:500;font-size:clamp(46px,12vw,68px);margin:0;
        line-height:0.98;letter-spacing:-0.01em;">Vellum</h1>
      <div style="font-family:'Newsreader',serif;font-style:italic;font-size:18px;color:var(--ink2);margin:10px 0 30px;">
        A quiet place to keep your days.</div>
      <p style="font-size:15px;line-height:1.6;color:var(--ink2);margin:0 0 28px;">
        Everything you write is stored in a <b>Journal</b> folder in your own Google Drive —
        nowhere else. Sign in to begin.</p>
      ${configured ? `
        <button onclick="window.__vel.signIn()" ${state.busy ? "disabled" : ""}
          style="font-family:'Mulish',sans-serif;font-weight:700;font-size:13px;letter-spacing:0.08em;
          text-transform:uppercase;color:var(--paper);background:var(--accent);border:none;padding:15px 28px;
          border-radius:4px;cursor:pointer;box-shadow:0 1px 0 var(--accent2),0 6px 16px rgba(151,68,41,0.22);">
          ${state.busy ? esc(state.busy) : "Sign in with Google"}</button>`
        : `<div style="background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 20px;
            font-size:14px;line-height:1.6;color:var(--ink2);text-align:left;">
            <b style="color:var(--ink);">Almost there.</b> Open <code>config.js</code> and paste your
            Google Client ID, then reload. See <b>SETUP.md</b> for step-by-step help.</div>`}
    </div>
  </div>`;
}

/* ---- timeline ---- */
function filteredEntries() {
  const q = state.query.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (state.moodFilter && e.mood !== state.moodFilter) return false;
    if (state.dateFilter && e.date !== state.dateFilter) return false;
    if (q) {
      const hay = (e.title + " " + e.blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function moodChip(m, active, onclick, big) {
  const dot = `<span style="width:8px;height:8px;border-radius:50%;background:${m.color};display:inline-block;"></span>`;
  return `<button data-act="${onclick}" style="display:inline-flex;align-items:center;gap:7px;
    font-family:'Mulish',sans-serif;font-weight:600;font-size:${big ? "12px" : "11.5px"};
    ${big ? "" : "letter-spacing:0.06em;text-transform:uppercase;"} padding:6px ${big ? "13px" : "12px"};
    border-radius:100px;cursor:pointer;border:1px solid ${active ? m.color : "var(--line)"};
    background:${active ? m.tint : (big ? "var(--card)" : "transparent")};
    color:${active ? m.color : "var(--ink2)"};transition:all .14s ease;">${dot}${esc(m.label)}</button>`;
}

function timelineHTML() {
  const today = fmt(todayISO());
  const anyFilter = !!(state.query || state.moodFilter || state.dateFilter);

  const allActive = state.moodFilter === "";
  let chips = `<button data-act="mood:" style="font-family:'Mulish',sans-serif;font-weight:600;font-size:11.5px;
    letter-spacing:0.06em;text-transform:uppercase;padding:6px 12px;border-radius:100px;cursor:pointer;
    border:1px solid ${allActive ? "var(--accent)" : "var(--line)"};
    background:${allActive ? "rgba(176,86,58,0.1)" : "transparent"};
    color:${allActive ? "var(--accent)" : "var(--ink2)"};">All</button>`;
  chips += MOOD_ORDER.map((k) => moodChip(MOODS[k], state.moodFilter === k, "mood:" + k, false)).join("");
  if (anyFilter) chips += `<button data-act="clearFilters" style="font-family:'Mulish',sans-serif;font-weight:600;
    font-size:11.5px;letter-spacing:0.06em;text-transform:uppercase;color:var(--accent);background:none;border:none;
    cursor:pointer;padding:6px 4px;text-decoration:underline;text-underline-offset:3px;">Clear</button>`;

  return `
  <div style="max-width:780px;margin:0 auto;padding:clamp(28px,5vw,64px) clamp(20px,5vw,40px) 120px;">
    <header style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;
      padding-bottom:22px;border-bottom:1px solid var(--line);flex-wrap:wrap;">
      <div>
        <div style="font-family:'Mulish',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.32em;
          text-transform:uppercase;color:var(--accent);margin-bottom:6px;">${esc(today.full)}</div>
        <h1 style="font-family:'Spectral',serif;font-weight:500;font-size:clamp(34px,6vw,52px);margin:0;
          line-height:0.98;letter-spacing:-0.01em;">Vellum</h1>
        <div style="font-family:'Newsreader',serif;font-style:italic;font-size:16px;color:var(--ink2);margin-top:6px;">
          A quiet place to keep your days.</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <button data-act="signOut" title="Sign out" style="font-family:'Mulish',sans-serif;font-weight:600;
          font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink2);background:var(--card);
          border:1px solid var(--line);padding:13px 16px;border-radius:3px;cursor:pointer;">Sign out</button>
        <button data-act="startNew" style="font-family:'Mulish',sans-serif;font-weight:700;font-size:12px;
          letter-spacing:0.12em;text-transform:uppercase;color:var(--paper);background:var(--accent);border:none;
          padding:14px 22px;border-radius:3px;cursor:pointer;box-shadow:0 1px 0 var(--accent2),0 6px 16px rgba(151,68,41,0.22);">
          ＋ New entry</button>
      </div>
    </header>

    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin:24px 0 8px;">
      <div style="position:relative;flex:1;min-width:200px;">
        <span style="position:absolute;left:2px;top:50%;transform:translateY(-50%);color:var(--ink3);font-size:15px;">⌕</span>
        <input id="search" value="${esc(state.query)}" placeholder="Search your entries…"
          style="width:100%;border:none;border-bottom:1px solid var(--line);background:transparent;
          padding:9px 4px 9px 22px;font-family:'Newsreader',serif;font-size:17px;color:var(--ink);outline:none;">
      </div>
      <input id="datefilter" type="date" value="${esc(state.dateFilter)}"
        style="border:1px solid var(--line);background:var(--card);border-radius:3px;padding:8px 10px;
        font-family:'Mulish',sans-serif;font-size:12px;color:var(--ink2);outline:none;">
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:30px;">${chips}</div>

    <div id="entries">${entriesListHTML()}</div>
  </div>`;
}

function entriesListHTML() {
  const list = filteredEntries();
  if (!list.length) {
    return `<div style="text-align:center;padding:70px 20px;color:var(--ink3);">
      <div style="font-size:34px;margin-bottom:10px;opacity:0.5;">❧</div>
      <div style="font-family:'Spectral',serif;font-style:italic;font-size:20px;color:var(--ink2);">
        ${state.entries.length ? "Nothing here yet." : "Your journal is empty."}</div>
      <div style="font-size:15px;margin-top:6px;">${state.entries.length
        ? "Try a different word, date, or mood." : "Tap “New entry” to write your first page."}</div>
    </div>`;
  }
  let lastMonth = "", html = "";
  for (const e of list) {
    const f = fmt(e.date), m = MOODS[e.mood] || { label: "", color: "#999", tint: "transparent" };
    if (f.monthLabel !== lastMonth) {
      lastMonth = f.monthLabel;
      html += `<div style="font-family:'Mulish',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.28em;
        text-transform:uppercase;color:var(--ink3);margin:26px 0 10px;">${esc(f.monthLabel)}</div>`;
    }
    const prev = firstText(e); const preview = prev.length > 150 ? prev.slice(0, 150) + "…" : prev;
    const img = firstImageBlock(e);
    html += `
    <div data-act="open:${e.id}" style="display:flex;gap:clamp(14px,3vw,26px);align-items:stretch;
      padding:18px 14px;margin:0 -14px;border-radius:6px;cursor:pointer;transition:background .16s ease;"
      onmouseover="this.style.background='var(--card)'" onmouseout="this.style.background='transparent'">
      <div style="flex:0 0 auto;width:48px;text-align:right;padding-top:2px;border-right:1px solid var(--line);
        padding-right:clamp(12px,2.5vw,20px);">
        <div style="font-family:'Spectral',serif;font-weight:500;font-size:27px;line-height:1;color:var(--ink);">${f.dayNum}</div>
        <div style="font-family:'Mulish',sans-serif;font-weight:600;font-size:10px;letter-spacing:0.12em;
          text-transform:uppercase;color:var(--ink3);margin-top:5px;">${esc(f.weekday)}</div>
      </div>
      <div style="flex:1 1 auto;min-width:0;">
        <h3 style="font-family:'Spectral',serif;font-weight:600;font-size:clamp(18px,2.4vw,21px);margin:0 0 4px;
          line-height:1.18;letter-spacing:-0.005em;">${esc(e.title)}</h3>
        <p style="margin:0 0 10px;font-size:15.5px;line-height:1.5;color:var(--ink2);display:-webkit-box;
          -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(preview)}</p>
        ${m.label ? `<span style="display:inline-flex;align-items:center;gap:6px;font-family:'Mulish',sans-serif;
          font-weight:600;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;padding:4px 10px;
          border-radius:100px;background:${m.tint};color:${m.color};">
          <span style="width:6px;height:6px;border-radius:50%;background:${m.color};"></span>${esc(m.label)}</span>` : ""}
      </div>
      ${img ? `<div style="flex:0 0 auto;align-self:center;">
        <img src="${img.thumb}" alt="" style="width:clamp(56px,12vw,76px);height:clamp(56px,12vw,76px);
          object-fit:cover;border-radius:4px;box-shadow:0 0 0 1px var(--line) inset,0 2px 8px rgba(42,37,33,0.12);"></div>` : ""}
    </div>
    <div style="height:1px;background:var(--line2);margin:0 -14px;"></div>`;
  }
  return html;
}

/* ---- writing ---- */
function writingHTML() {
  const d = state.draft;
  const draftDate = fmt(d.date).full;

  const moodRow = MOOD_ORDER.map((k) => moodChip(MOODS[k], d.mood === k, "setmood:" + k, true)).join("");

  let firstTextSeen = false;
  const blocks = d.blocks.map((b, i) => {
    if (b.type === "text") {
      const ph = !firstTextSeen ? "Start writing…" : "";
      firstTextSeen = true;
      return `<textarea data-text="${i}" rows="1" placeholder="${esc(ph)}"
        style="width:100%;border:none;background:transparent;outline:none;resize:none;font-family:'Newsreader',serif;
        font-size:clamp(18px,2.4vw,20px);line-height:1.74;color:var(--ink);letter-spacing:0.002em;display:block;
        min-height:1.74em;padding:2px 0;">${esc(b.text)}</textarea>`;
    }
    const ctrls = `<div data-noprint style="position:absolute;top:10px;right:10px;display:flex;gap:6px;">
      <button data-act="bup:${i}" title="Move up" style="width:32px;height:32px;border-radius:4px;border:none;
        background:rgba(28,22,18,0.6);color:#fff;cursor:pointer;font-size:14px;backdrop-filter:blur(4px);">↑</button>
      <button data-act="bdown:${i}" title="Move down" style="width:32px;height:32px;border-radius:4px;border:none;
        background:rgba(28,22,18,0.6);color:#fff;cursor:pointer;font-size:14px;backdrop-filter:blur(4px);">↓</button>
      <button data-act="brm:${i}" title="Remove" style="width:32px;height:32px;border-radius:4px;border:none;
        background:rgba(28,22,18,0.6);color:#fff;cursor:pointer;font-size:15px;backdrop-filter:blur(4px);">×</button></div>`;

    if (b.type === "image") {
      if (b.uploading) {
        return `<figure style="margin:18px 0;"><div class="vel-imgloading">
          ${b.thumb ? `<img src="${b.thumb}" alt="" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0;opacity:.5;">` : ""}
          <div class="vel-overlay"><div class="vel-spin"></div><div>${esc(b.status || "Uploading…")}</div></div></div></figure>`;
      }
      const src = blobCache.get(b.displayId) || b.thumb;
      return `<figure style="margin:18px 0;position:relative;">
        <img src="${src}" alt="" style="width:100%;border-radius:5px;display:block;
          box-shadow:0 0 0 1px var(--line) inset,0 8px 26px rgba(42,37,33,0.16);">${ctrls}</figure>`;
    }
    // file
    return `<div style="position:relative;display:flex;align-items:center;gap:14px;margin:16px 0;padding:14px 16px;
      background:var(--card);border:1px solid var(--line);border-radius:6px;">
      <div style="flex:0 0 auto;width:40px;height:48px;border-radius:3px;background:var(--paper);border:1px solid var(--line);
        display:flex;align-items:center;justify-content:center;font-family:'Mulish',sans-serif;font-weight:700;font-size:10px;
        letter-spacing:0.04em;color:var(--accent);">${esc(b.ext)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-family:'Mulish',sans-serif;font-weight:600;font-size:14px;color:var(--ink);white-space:nowrap;
          overflow:hidden;text-overflow:ellipsis;">${esc(b.name)}</div>
        <div style="font-family:'Mulish',sans-serif;font-size:11.5px;letter-spacing:0.04em;text-transform:uppercase;
          color:var(--ink3);margin-top:3px;">${b.uploading ? esc(b.status || "Uploading…") : esc(b.ext + " · " + humanSize(b.size))}</div>
      </div>
      ${b.uploading ? `<div class="vel-spin" style="width:20px;height:20px;border-width:2px;"></div>` : `
      <div data-noprint style="display:flex;gap:6px;">
        <button data-act="bup:${i}" style="width:30px;height:30px;border-radius:4px;border:1px solid var(--line);background:var(--paper);color:var(--ink2);cursor:pointer;font-size:13px;">↑</button>
        <button data-act="bdown:${i}" style="width:30px;height:30px;border-radius:4px;border:1px solid var(--line);background:var(--paper);color:var(--ink2);cursor:pointer;font-size:13px;">↓</button>
        <button data-act="brm:${i}" style="width:30px;height:30px;border-radius:4px;border:1px solid var(--line);background:var(--paper);color:var(--ink2);cursor:pointer;font-size:15px;">×</button>
      </div>`}
    </div>`;
  }).join("");

  const anyUploading = d.blocks.some((b) => b.uploading);

  return `
  <div style="min-height:100vh;display:flex;flex-direction:column;">
    <div data-noprint style="position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;
      gap:16px;padding:14px clamp(18px,5vw,40px);background:rgba(244,237,224,0.86);backdrop-filter:blur(10px);
      border-bottom:1px solid var(--line);">
      <button data-act="discard" style="font-family:'Mulish',sans-serif;font-weight:600;font-size:12px;letter-spacing:0.06em;
        text-transform:uppercase;color:var(--ink2);background:none;border:none;cursor:pointer;padding:6px;">← Discard</button>
      <div style="font-family:'Mulish',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.18em;
        text-transform:uppercase;color:var(--ink3);">${esc(draftDate)}</div>
      <button data-act="save" ${anyUploading ? "disabled" : ""} style="font-family:'Mulish',sans-serif;font-weight:700;
        font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:var(--paper);
        background:${anyUploading ? "var(--ink3)" : "var(--accent)"};border:none;padding:11px 20px;border-radius:3px;
        cursor:${anyUploading ? "default" : "pointer"};box-shadow:0 1px 0 var(--accent2);">
        ${state.busy ? esc(state.busy) : (anyUploading ? "Uploading…" : "Save entry")}</button>
    </div>

    <div style="flex:1;width:100%;max-width:680px;margin:0 auto;padding:clamp(24px,5vw,52px) clamp(20px,5vw,32px) 160px;">
      <input id="title" value="${esc(d.title)}" placeholder="Title"
        style="width:100%;border:none;background:transparent;outline:none;font-family:'Spectral',serif;font-weight:500;
        font-size:clamp(28px,5vw,40px);color:var(--ink);letter-spacing:-0.015em;line-height:1.1;margin-bottom:16px;">

      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">
        <span style="font-family:'Mulish',sans-serif;font-weight:700;font-size:10.5px;letter-spacing:0.16em;
          text-transform:uppercase;color:var(--ink3);margin-right:4px;">How it felt</span>${moodRow}</div>
      <div style="height:1px;background:var(--line);margin:22px 0 26px;"></div>

      <div id="blocks">${blocks}</div>
      ${state.draft.editId ? `<button data-act="delete" data-noprint style="margin-top:30px;font-family:'Mulish',sans-serif;
        font-weight:600;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink3);background:none;
        border:none;cursor:pointer;text-decoration:underline;text-underline-offset:3px;">Delete this entry</button>` : ""}
    </div>

    <div data-noprint style="position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:25;display:flex;gap:10px;
      padding:8px;background:var(--card);border:1px solid var(--line);border-radius:100px;box-shadow:0 8px 30px rgba(42,37,33,0.18);">
      <button data-act="openPrompt" style="display:inline-flex;align-items:center;gap:8px;font-family:'Mulish',sans-serif;
        font-weight:600;font-size:13px;color:var(--ink);background:var(--paper);border:1px solid var(--line);padding:11px 18px;
        border-radius:100px;cursor:pointer;">✦ Need a prompt?</button>
      <button data-act="attach" style="display:inline-flex;align-items:center;gap:8px;font-family:'Mulish',sans-serif;
        font-weight:600;font-size:13px;color:var(--ink);background:var(--paper);border:1px solid var(--line);padding:11px 18px;
        border-radius:100px;cursor:pointer;">＋ Attach</button>
    </div>
    <input id="filepick" type="file" multiple accept="image/*,.heic,.heif,.pdf,.doc,.docx,.txt,.rtf,.pages,.key,.numbers,.ppt,.pptx,.xls,.xlsx" style="display:none;">

    ${state.promptOpen ? promptPanelHTML() : ""}
  </div>`;
}

function promptPanelHTML() {
  const cats = PROMPT_CATS.map((c) => {
    const on = state.promptCat === c.key;
    return `<button data-act="pcat:${c.key}" style="font-family:'Mulish',sans-serif;font-weight:600;font-size:12px;
      padding:6px 13px;border-radius:100px;cursor:pointer;border:1px solid ${on ? "var(--accent)" : "var(--line)"};
      background:${on ? "rgba(176,86,58,0.1)" : "transparent"};color:${on ? "var(--accent)" : "var(--ink2)"};
      transition:all .14s ease;">${esc(c.label)}</button>`;
  }).join("");
  const list = PROMPTS[state.promptCat] || [""];
  const current = list[state.promptIndex % list.length];
  return `
  <div data-act="closePrompt" data-noprint style="position:fixed;inset:0;z-index:40;background:rgba(28,22,18,0.32);
    backdrop-filter:blur(2px);display:flex;align-items:flex-end;justify-content:center;">
    <div data-act="stop" style="width:100%;max-width:560px;background:var(--paper);border:1px solid var(--line);
      border-bottom:none;border-radius:14px 14px 0 0;padding:26px clamp(22px,5vw,34px) 34px;
      box-shadow:0 -16px 50px rgba(42,37,33,0.25);animation:velPanel .3s ease both;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
        <div style="font-family:'Mulish',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.22em;
          text-transform:uppercase;color:var(--accent);">A prompt for you</div>
        <button data-act="closePrompt" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--ink3);line-height:1;">×</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:22px;">${cats}</div>
      <p style="font-family:'Spectral',serif;font-weight:400;font-size:clamp(22px,4vw,28px);line-height:1.32;
        color:var(--ink);margin:0 0 28px;letter-spacing:-0.005em;">“${esc(current)}”</p>
      <div style="display:flex;gap:12px;">
        <button data-act="acceptPrompt" style="flex:1;font-family:'Mulish',sans-serif;font-weight:700;font-size:13px;
          letter-spacing:0.08em;text-transform:uppercase;color:var(--paper);background:var(--accent);border:none;padding:14px;
          border-radius:4px;cursor:pointer;box-shadow:0 1px 0 var(--accent2);">Use this prompt</button>
        <button data-act="shufflePrompt" style="flex:0 0 auto;font-family:'Mulish',sans-serif;font-weight:600;font-size:13px;
          color:var(--ink);background:var(--card);border:1px solid var(--line);padding:14px 18px;border-radius:4px;cursor:pointer;">↻ Shuffle</button>
      </div>
    </div>
  </div>`;
}

/* ---- single entry ---- */
function entryHTML() {
  const e = state.entries.find((x) => x.id === state.viewId);
  if (!e) { state.screen = "timeline"; return timelineHTML(); }
  const f = fmt(e.date); const m = MOODS[e.mood];

  const blocks = e.blocks.map((b, i) => {
    if (b.type === "text") {
      return `<p style="font-family:'Newsreader',serif;font-size:clamp(18px,2.5vw,21px);line-height:1.78;color:var(--ink);
        margin:0 0 26px;white-space:pre-wrap;letter-spacing:0.002em;">${esc(b.text)}</p>`;
    }
    if (b.type === "image") {
      const cached = blobCache.get(b.displayId);
      return `<figure style="margin:34px 0;" data-img="${i}">
        ${cached
          ? `<img src="${cached}" alt="" style="width:100%;border-radius:6px;display:block;box-shadow:0 0 0 1px var(--line) inset,0 10px 30px rgba(42,37,33,0.18);">`
          : `<div class="vel-imgloading">${b.thumb ? `<img src="${b.thumb}" alt="" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0;opacity:.45;filter:blur(1px);">` : ""}
             <div class="vel-overlay"><div class="vel-spin"></div><div>Loading photo…</div></div></div>`}
      </figure>`;
    }
    // file card
    return `<a data-act="openfile:${i}" style="display:flex;align-items:center;gap:14px;margin:26px 0;padding:15px 17px;
      background:var(--card);border:1px solid var(--line);border-radius:6px;text-decoration:none;cursor:pointer;">
      <div style="flex:0 0 auto;width:42px;height:50px;border-radius:3px;background:var(--paper);border:1px solid var(--line);
        display:flex;align-items:center;justify-content:center;font-family:'Mulish',sans-serif;font-weight:700;font-size:10px;color:var(--accent);">${esc(b.ext)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-family:'Mulish',sans-serif;font-weight:600;font-size:14.5px;color:var(--ink);">${esc(b.name)}</div>
        <div style="font-family:'Mulish',sans-serif;font-size:11.5px;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink3);margin-top:3px;">Open file →</div>
      </div></a>`;
  }).join("");

  return `
  <div style="min-height:100vh;">
    <div data-noprint style="position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;
      gap:16px;padding:14px clamp(18px,5vw,40px);background:rgba(244,237,224,0.86);backdrop-filter:blur(10px);
      border-bottom:1px solid var(--line);">
      <button data-act="goTimeline" style="font-family:'Mulish',sans-serif;font-weight:600;font-size:12px;letter-spacing:0.06em;
        text-transform:uppercase;color:var(--ink2);background:none;border:none;cursor:pointer;padding:6px;">← All entries</button>
      <div style="display:flex;gap:10px;">
        <button data-act="edit" style="font-family:'Mulish',sans-serif;font-weight:600;font-size:12px;letter-spacing:0.06em;
          text-transform:uppercase;color:var(--ink2);background:var(--card);border:1px solid var(--line);padding:10px 16px;
          border-radius:3px;cursor:pointer;">Edit</button>
        <button data-act="print" style="font-family:'Mulish',sans-serif;font-weight:700;font-size:12px;letter-spacing:0.08em;
          text-transform:uppercase;color:var(--paper);background:var(--accent);border:none;padding:10px 18px;border-radius:3px;
          cursor:pointer;box-shadow:0 1px 0 var(--accent2);">${state.busy === "print" ? "Preparing…" : "Print / Export"}</button>
      </div>
    </div>

    <article style="max-width:660px;margin:0 auto;padding:clamp(34px,6vw,72px) clamp(20px,5vw,32px) 120px;">
      <div style="font-family:'Mulish',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;
        color:var(--accent);margin-bottom:14px;">${esc(f.full)}</div>
      <h1 style="font-family:'Spectral',serif;font-weight:500;font-size:clamp(32px,6vw,48px);line-height:1.06;
        letter-spacing:-0.015em;margin:0 0 16px;">${esc(e.title)}</h1>
      ${m ? `<span style="display:inline-flex;align-items:center;gap:7px;font-family:'Mulish',sans-serif;font-weight:600;
        font-size:11.5px;letter-spacing:0.05em;text-transform:uppercase;padding:5px 12px;border-radius:100px;
        background:${m.tint};color:${m.color};"><span style="width:7px;height:7px;border-radius:50%;background:${m.color};"></span>${esc(m.label)}</span>` : ""}
      <div style="height:1px;background:var(--line);margin:30px 0;"></div>
      ${blocks}
      <div style="margin-top:40px;padding-top:24px;border-top:1px solid var(--line);font-family:'Spectral',serif;
        font-style:italic;font-size:16px;color:var(--ink3);text-align:center;">— end of entry —</div>
    </article>
  </div>`;
}

/* ----------------------------------- mount (wire up events) -------------- */
function mount() {
  // Generic click handling via data-act attributes.
  $app().querySelectorAll("[data-act]").forEach((el) => {
    el.addEventListener("click", (ev) => handleAct(el.getAttribute("data-act"), ev));
  });

  if (state.screen === "timeline") {
    const s = document.getElementById("search");
    if (s) s.addEventListener("input", (e) => { state.query = e.target.value;
      document.getElementById("entries").innerHTML = entriesListHTML(); wireEntries(); });
    const df = document.getElementById("datefilter");
    if (df) df.addEventListener("input", (e) => { state.dateFilter = e.target.value;
      document.getElementById("entries").innerHTML = entriesListHTML(); wireEntries(); });
  }

  if (state.screen === "writing") {
    const title = document.getElementById("title");
    if (title) title.addEventListener("input", (e) => { state.draft.title = e.target.value; });
    document.querySelectorAll("textarea[data-text]").forEach((ta) => {
      autoGrow(ta);
      ta.addEventListener("input", (e) => {
        const i = +ta.getAttribute("data-text");
        state.draft.blocks[i].text = e.target.value; autoGrow(ta);
      });
    });
    const fp = document.getElementById("filepick");
    if (fp) fp.addEventListener("change", onFilesPicked);
    // Load any image displays not yet cached (e.g. when editing an existing entry).
    lazyLoadImages();
  }

  if (state.screen === "entry") lazyLoadImages();
}

function wireEntries() {
  document.querySelectorAll("#entries [data-act]").forEach((el) => {
    el.addEventListener("click", (ev) => handleAct(el.getAttribute("data-act"), ev));
  });
}

function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }

// Download + show full display images that aren't cached yet.
async function lazyLoadImages() {
  const blocks = state.screen === "entry"
    ? (state.entries.find((x) => x.id === state.viewId) || {}).blocks || []
    : state.draft.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "image" && !b.uploading && b.displayId && !blobCache.has(b.displayId)) {
      try { await ensureDisplay(b); if (state.screen === "entry" || state.screen === "writing") render(); }
      catch (e) { console.warn("Could not load image", e); }
    }
  }
}

/* ----------------------------------- actions ----------------------------- */
function handleAct(act, ev) {
  if (ev) ev.stopPropagation();
  const [cmd, arg] = act.split(":");

  switch (cmd) {
    case "signIn": return signIn();
    case "signOut": return signOut();
    case "startNew": return startNew();
    case "goTimeline": case "discard":
      state.screen = "timeline"; state.draft = null; state.promptOpen = false; return render();
    case "clearFilters":
      state.query = ""; state.moodFilter = ""; state.dateFilter = ""; return render();
    case "mood": state.moodFilter = (state.moodFilter === arg ? "" : arg);
      document.getElementById("entries").innerHTML = entriesListHTML(); return render();
    case "open": state.viewId = arg; state.screen = "entry"; return render();
    case "openfile": return openFileBlock(+arg);

    // writing
    case "setmood": state.draft.mood = (state.draft.mood === arg ? "" : arg); return render();
    case "attach": { const fp = document.getElementById("filepick"); if (fp) fp.click(); return; }
    case "bup": return moveBlock(+arg, -1);
    case "bdown": return moveBlock(+arg, 1);
    case "brm": return removeBlock(+arg);
    case "save": return saveEntry();
    case "edit": return editEntry();
    case "delete": return deleteEntry();
    case "print": return printEntry();

    // prompts
    case "openPrompt": state.promptOpen = true; return render();
    case "closePrompt": state.promptOpen = false; return render();
    case "stop": return; // swallow clicks inside the panel
    case "pcat": state.promptCat = arg; state.promptIndex = 0; return render();
    case "shufflePrompt": {
      const n = (PROMPTS[state.promptCat] || [""]).length; let i = state.promptIndex;
      if (n > 1) while (i === state.promptIndex) i = Math.floor(Math.random() * n);
      state.promptIndex = i; return render();
    }
    case "acceptPrompt": return acceptPrompt();
  }
}

function startNew() {
  state.draft = { date: todayISO(), title: "", mood: "", blocks: [{ type: "text", text: "" }] };
  state.screen = "writing"; state.promptOpen = false; render();
}

function editEntry() {
  const e = state.entries.find((x) => x.id === state.viewId); if (!e) return;
  state.draft = { date: e.date, title: e.title, mood: e.mood,
    blocks: e.blocks.map((b) => ({ ...b })), editId: e.id, fileId: e.fileId };
  state.screen = "writing"; render();
}

function moveBlock(i, dir) {
  const b = state.draft.blocks, j = i + dir;
  if (j < 0 || j >= b.length) return;
  [b[i], b[j]] = [b[j], b[i]]; render();
}
function removeBlock(i) {
  const b = state.draft.blocks; b.splice(i, 1);
  if (!b.some((x) => x.type === "text")) b.push({ type: "text", text: "" });
  render();
}

async function onFilesPicked(ev) {
  const files = Array.from(ev.target.files || []); ev.target.value = "";
  if (!files.length) return;

  // Insert a placeholder block for each file right away (with spinner).
  const placeholders = files.map((f) => isImageFile(f)
    ? { type: "image", uploading: true, status: "Reading…", thumb: "" }
    : { type: "file", uploading: true, status: "Uploading…", name: f.name,
        ext: (f.name.split(".").pop() || "FILE").slice(0, 4).toUpperCase(), size: f.size });
  const startIndex = state.draft.blocks.length;
  state.draft.blocks.push(...placeholders);
  // keep a trailing empty text block to write under the attachments
  state.draft.blocks.push({ type: "text", text: "" });
  render();

  for (let k = 0; k < files.length; k++) {
    const idx = startIndex + k;
    try {
      const done = await processAttachment(files[k], (msg) => {
        state.draft.blocks[idx].status = msg; render();
      });
      state.draft.blocks[idx] = done; render();
    } catch (e) {
      state.draft.blocks[idx] = { type: "text", text: "" };
      setError("Couldn't add “" + (files[k].name || "file") + "”: " + e.message);
    }
  }
}

async function saveEntry() {
  if (state.draft.blocks.some((b) => b.uploading)) return;
  try {
    state.busy = "Saving…"; render();
    const saved = await saveDraftToDrive(state.draft);
    const i = state.entries.findIndex((e) => e.id === saved.id);
    if (i >= 0) state.entries[i] = saved; else state.entries.unshift(saved);
    state.entries.sort((a, b) => (a.date < b.date ? 1 : -1));
    state.busy = ""; state.draft = null; state.screen = "timeline"; render();
  } catch (e) { state.busy = ""; setError("Couldn't save: " + e.message); }
}

async function deleteEntry() {
  if (!state.draft || !state.draft.editId) return;
  if (!confirm("Delete this entry permanently? This removes it from your Drive.")) return;
  try {
    state.busy = "Deleting…"; render();
    const e = state.entries.find((x) => x.id === state.draft.editId);
    if (e && e.fileId) await deleteFileFromDrive(e.fileId);
    // also remove its attachments
    if (e) for (const b of e.blocks) {
      if (b.type === "image") { await deleteFileFromDrive(b.originalId); await deleteFileFromDrive(b.displayId); }
      if (b.type === "file") await deleteFileFromDrive(b.fileId);
    }
    state.entries = state.entries.filter((x) => x.id !== state.draft.editId);
    state.busy = ""; state.draft = null; state.viewId = null; state.screen = "timeline"; render();
  } catch (e) { state.busy = ""; setError("Couldn't delete: " + e.message); }
}

function acceptPrompt() {
  const list = PROMPTS[state.promptCat] || [""];
  const text = list[state.promptIndex % list.length];
  const blocks = state.draft.blocks;
  let idx = -1;
  for (let k = blocks.length - 1; k >= 0; k--) if (blocks[k].type === "text") { idx = k; break; }
  if (idx >= 0 && blocks[idx].text.trim() === "") blocks[idx].text = text + "\n\n";
  else blocks.push({ type: "text", text: text + "\n\n" });
  state.promptOpen = false; render();
}

// Open a non-image attachment in a new tab.
async function openFileBlock(i) {
  const e = state.entries.find((x) => x.id === state.viewId); if (!e) return;
  const b = e.blocks[i]; if (!b || b.type !== "file") return;
  try {
    if (!blobCache.has(b.fileId)) {
      state.busy = "Opening…"; render();
      const blob = await downloadBlob(b.fileId);
      blobCache.set(b.fileId, URL.createObjectURL(blob));
      state.busy = ""; render();
    }
    window.open(blobCache.get(b.fileId), "_blank");
  } catch (e2) { state.busy = ""; setError("Couldn't open file: " + e2.message); }
}

/* ----------------------------------- [PRINT] ----------------------------- */
// Build a clean, print-ready page that embeds the ORIGINAL full-resolution
// photos from Drive, then open the browser's print/save-as-PDF dialog.
async function printEntry() {
  const e = state.entries.find((x) => x.id === state.viewId); if (!e) return;
  try {
    state.busy = "print"; render();

    // Fetch + prepare each image at full resolution (data URLs so print waits for nothing).
    const imgData = {};
    for (const b of e.blocks) {
      if (b.type !== "image") continue;
      const blob = await downloadBlob(b.originalId);
      imgData[b.originalId] = isHeic({ type: blob.type, name: b.name })
        ? await heicBlobToFullJpegDataURL(blob)   // browsers can't print HEIC; convert at full res
        : await blobToDataURL(blob);               // keep the true original bytes
    }

    const f = fmt(e.date); const m = MOODS[e.mood];
    const body = e.blocks.map((b) => {
      if (b.type === "text") return `<p>${esc(b.text)}</p>`;
      if (b.type === "image") return `<figure><img src="${imgData[b.originalId]}" alt=""></figure>`;
      return `<div class="file">${esc(b.name)} <span>(${esc(b.ext)})</span></div>`;
    }).join("");

    const doc = `<!doctype html><html><head><meta charset="utf-8">
      <title>${esc(e.title)}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link href="https://fonts.googleapis.com/css2?family=Mulish:wght@600;700&family=Newsreader:wght@400;500&family=Spectral:wght@400;500;600&display=swap" rel="stylesheet">
      <style>
        @page { margin: 18mm; }
        * { box-sizing: border-box; }
        body { font-family:'Newsreader',Georgia,serif; color:#2A2521; margin:0; }
        .date { font-family:'Mulish',sans-serif; font-weight:700; font-size:10px; letter-spacing:0.22em;
          text-transform:uppercase; color:#B0563A; margin-bottom:8px; }
        h1 { font-family:'Spectral',serif; font-weight:500; font-size:30pt; line-height:1.08;
          letter-spacing:-0.01em; margin:0 0 8px; }
        .mood { font-family:'Mulish',sans-serif; font-weight:600; font-size:9pt; letter-spacing:0.05em;
          text-transform:uppercase; color:${m ? m.color : "#999"}; }
        hr { border:none; border-top:1px solid rgba(42,37,33,0.2); margin:18px 0 22px; }
        p { font-size:12pt; line-height:1.7; margin:0 0 14px; white-space:pre-wrap; }
        figure { margin:16px 0; text-align:center; break-inside:avoid; page-break-inside:avoid; }
        img { max-width:100%; height:auto; image-orientation:from-image; border-radius:3px; }
        .file { font-family:'Mulish',sans-serif; font-size:11pt; padding:10px 12px; border:1px solid #ccc;
          border-radius:4px; margin:14px 0; break-inside:avoid; }
        .file span { color:#999; }
      </style></head>
      <body>
        <div class="date">${esc(f.full)}</div>
        <h1>${esc(e.title)}</h1>
        ${m ? `<div class="mood">${esc(m.label)}</div>` : ""}
        <hr>
        ${body}
      </body></html>`;

    // Render into a hidden iframe, wait for fonts + images, then print.
    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-noprint", "");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const idoc = iframe.contentWindow.document;
    idoc.open(); idoc.write(doc); idoc.close();

    await waitForIframe(iframe);
    state.busy = ""; render();
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    // Remove the iframe a little later (after the print dialog is handled).
    setTimeout(() => iframe.remove(), 60000);
  } catch (e2) { state.busy = ""; setError("Couldn't prepare print: " + e2.message); }
}

function waitForIframe(iframe) {
  return new Promise((resolve) => {
    const win = iframe.contentWindow, doc = win.document;
    const imgs = Array.from(doc.images);
    const imgsReady = Promise.all(imgs.map((img) => img.complete ? Promise.resolve()
      : new Promise((r) => { img.onload = img.onerror = r; })));
    const fontsReady = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
    Promise.all([imgsReady, fontsReady]).then(() => setTimeout(resolve, 150));
  });
}

// Convert a full-resolution HEIC blob to a full-resolution JPEG data URL (orientation applied).
async function heicBlobToFullJpegDataURL(blob) {
  const bitmap = await decodeBitmap(blob, true);
  const c = document.createElement("canvas"); c.width = bitmap.width; c.height = bitmap.height;
  c.getContext("2d").drawImage(bitmap, 0, 0);
  const jpeg = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
  return await blobToDataURL(jpeg);
}

/* ----------------------------------- boot -------------------------------- */
window.__vel = {
  signIn, signOut,
  dismissError: () => { state.error = ""; render(); }
};

function boot() {
  // Wait until the Google sign-in library is present.
  if (window.google && google.accounts) { initAuth(); render(); }
  else { let tries = 0; const t = setInterval(() => {
      if (window.google && google.accounts) { clearInterval(t); initAuth(); render(); }
      else if (++tries > 60) { clearInterval(t); render(); } // ~9s; show UI anyway
    }, 150); render(); }
}

document.addEventListener("DOMContentLoaded", boot);
