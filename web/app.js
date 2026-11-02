/* ==========================================================================
   Catch — client
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const nf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const PREF_KEY = "catch.prefs.v1";

const FALLBACK_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

const AUDIO_FORMATS = [
  { id: "mp3", name: "MP3", desc: "Plays everywhere", icon: "i-music", lossy: true },
  { id: "m4a", name: "M4A", desc: "Apple-native AAC", icon: "i-music", lossy: true },
  { id: "opus", name: "Opus", desc: "Tiny, superb quality", icon: "i-bolt", lossy: true },
  { id: "flac", name: "FLAC", desc: "Lossless audio", icon: "i-film", lossy: false },
  { id: "wav", name: "WAV", desc: "Uncompressed", icon: "i-film", lossy: false },
  { id: "best", name: "Original", desc: "No re-encode", icon: "i-download", lossy: false },
];

const state = {
  info: null,
  url: "",
  mode: "video",
  quality: "best",
  audioFormat: "mp3",
  audioQuality: "320",
  playlistAll: true,
  loading: false,
  submitting: false,
  jobs: [],
  known: new Map(),
  fetchController: null,
};

const prefs = loadPrefs();

/* ------------------------------- formatting ------------------------------ */

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
           : `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return "";
  return `${fmtBytes(bps)}/s`;
}

function fmtEta(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return "";
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

function fmtDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "";
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function qualityLabel(q, format) {
  if (q === "best" || !q) return "Best";
  const h = Number(q);
  if (h >= 4320) return "8K";
  if (h >= 2160) return "4K";
  if (h >= 1440) return "2K";
  return `${h}p`;
}

/* --------------------------------- prefs -------------------------------- */

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  const data = {
    mode: state.mode,
    audioFormat: state.audioFormat,
    audioQuality: state.audioQuality,
    container: $("#containerSel")?.value || "auto",
    codec: $("#codecSel")?.value || "any",
    thumb: $("#thumbToggle")?.checked ?? true,
    meta: $("#metaToggle")?.checked ?? true,
    chapters: $("#chapterToggle")?.checked ?? true,
    thumbFile: $("#thumbFileToggle")?.checked ?? false,
    archive: $("#archiveToggle")?.checked ?? false,
    sponsor: $("#sponsorSel")?.value || "none",
    template: $("#templateSel")?.value || "title",
    customTemplate: $("#customTemplate")?.value || "",
    playlistFolder: $("#playlistFolderToggle")?.checked ?? true,
  };
  try { localStorage.setItem(PREF_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

function applyPrefs() {
  if (prefs.mode === "audio" || prefs.mode === "video") state.mode = prefs.mode;
  if (prefs.audioFormat) state.audioFormat = prefs.audioFormat;
  if (prefs.audioQuality) state.audioQuality = String(prefs.audioQuality);
  if (prefs.container) $("#containerSel").value = prefs.container;
  if (prefs.codec) $("#codecSel").value = prefs.codec;
  if (typeof prefs.thumb === "boolean") $("#thumbToggle").checked = prefs.thumb;
  if (typeof prefs.meta === "boolean") $("#metaToggle").checked = prefs.meta;
  if (typeof prefs.chapters === "boolean") $("#chapterToggle").checked = prefs.chapters;
  if (typeof prefs.thumbFile === "boolean") $("#thumbFileToggle").checked = prefs.thumbFile;
  if (typeof prefs.archive === "boolean") $("#archiveToggle").checked = prefs.archive;
  if (prefs.sponsor) $("#sponsorSel").value = prefs.sponsor;
  if (prefs.template) $("#templateSel").value = prefs.template;
  if (prefs.customTemplate) $("#customTemplate").value = prefs.customTemplate;
  if (typeof prefs.playlistFolder === "boolean") $("#playlistFolderToggle").checked = prefs.playlistFolder;
  toggleCustomTemplate();
}

/* --------------------------------- icons -------------------------------- */

function icon(name, cls = "ic") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;
}

/* -------------------------------- toasts -------------------------------- */

function toast(message, { type = "info", title = "", timeout = 4000 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const iconName = type === "success" ? "i-check" : type === "error" ? "i-alert" : "i-sparkle";
  el.innerHTML = `<span class="t-ic">${icon(iconName)}</span><div>${title ? `<strong></strong>` : ""}<span></span></div>`;
  if (title) el.querySelector("strong").textContent = title;
  el.querySelector("span:last-child").textContent = message;
  $("#toasts").appendChild(el);
  const out = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 320);
  };
  const timer = setTimeout(out, timeout);
  el.addEventListener("click", () => { clearTimeout(timer); out(); });
}

function showError(message) {
  $("#errorText").textContent = message;
  $("#errorAlert").hidden = false;
}

function hideError() {
  $("#errorAlert").hidden = true;
}

/* --------------------------------- info --------------------------------- */

async function fetchInfo() {
  const raw = $("#urlInput").value.trim();
  if (!raw) {
    $("#urlInput").focus();
    toast("Paste a video or playlist link first.", { type: "info" });
    return;
  }
  if (state.loading) return;

  state.loading = true;
  hideError();
  $("#fetchBtn").classList.add("busy");
  $("#fetchBtn").disabled = true;
  $("#previewCard").hidden = true;
  $("#optionsCard").hidden = true;
  $("#startCard").hidden = true;
  $("#fetchSkeleton").hidden = false;
  state.fetchController?.abort();
  const controller = new AbortController();
  state.fetchController = controller;

  try {
    const res = await fetch(`/api/info?url=${encodeURIComponent(raw)}`, { signal: controller.signal });
    if (!res.ok) throw new Error(await readError(res));
    const info = await res.json();

    state.info = info;
    state.url = raw;
    state.quality = "best";
    state.playlistAll = info.kind === "playlist";

    renderPreview(info);
    renderQuality();
    renderAudioFormats();
    renderSubtitles(info);
    renderPlaylist(info);
    setMode(state.mode, { persist: false });
    syncSummary();

    $("#fetchSkeleton").hidden = true;
    $("#previewCard").hidden = false;
    $("#optionsCard").hidden = false;

    if (window.innerWidth <= 900) {
      setTimeout(() => $("#previewCard").scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    $("#fetchSkeleton").hidden = true;
    $("#startCard").hidden = false;
    showError(err.message || "Could not read that link.");
  } finally {
    if (state.fetchController === controller) {
      state.loading = false;
      $("#fetchBtn").classList.remove("busy");
      $("#fetchBtn").disabled = false;
      state.fetchController = null;
    }
  }
}

async function readError(res) {
  try {
    const data = await res.json();
    let detail = data.detail;
    if (Array.isArray(detail)) detail = detail.map((d) => d.msg).join(" · ");
    return detail || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/* -------------------------------- preview ------------------------------- */

function renderPreview(info) {
  const thumb = $("#previewThumb");
  const media = $(".preview-media");
  thumb.removeAttribute("src");
  media.classList.remove("portrait");
  media.classList.toggle("empty", !info.thumbnail);
  if (info.thumbnail) {
    thumb.src = info.thumbnail;
    thumb.alt = info.title;
    media.style.setProperty("--thumb", `url("${String(info.thumbnail).replace(/"/g, '\\"')}")`);
  } else {
    media.style.removeProperty("--thumb");
  }

  $("#previewTitle").textContent = info.title || "Untitled";
  $("#previewChannel").textContent = info.uploader || "Unknown channel";
  $("#channelAvatar").textContent = (info.uploader || "C").trim().charAt(0).toUpperCase();
  $("#previewDur").textContent = info.kind === "playlist"
    ? `${info.playlist_count || info.entries.length} videos`
    : fmtDuration(info.duration);
  $("#previewDur").hidden = !($("#previewDur").textContent);

  const kind = $("#previewKind");
  if (info.kind === "playlist") {
    kind.hidden = false;
    kind.textContent = "PLAYLIST";
  } else if (info.is_live) {
    kind.hidden = false;
    kind.textContent = "LIVE";
  } else if (info.formats?.video?.[0]?.height >= 2160) {
    kind.hidden = false;
    kind.textContent = "4K+";
  } else {
    kind.hidden = true;
  }

  const meta = [];
  if (info.view_count) meta.push(`${nf.format(info.view_count)} views`);
  if (info.upload_date) meta.push(fmtDate(info.upload_date));
  if (info.kind !== "playlist" && info.duration) meta.push(fmtDuration(info.duration));
  if (info.kind === "playlist" && info.entries.length) meta.push(`${info.entries.length} loaded`);
  $("#previewMeta").innerHTML = meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('<span class="sep"></span>');

  const desc = (info.description || "").replace(/\s+/g, " ").trim();
  $("#previewDesc").textContent = desc;
  $("#previewDesc").hidden = !desc;

  const href = info.webpage_url || state.url;
  $("#previewLink").href = href;
  $("#previewPlay").href = href;
}

/* ------------------------------- quality -------------------------------- */

function renderQuality() {
  const grid = $("#qualityGrid");
  const info = state.info;
  const formats = [...(info?.formats?.video || [])].sort((a, b) => b.height - a.height);

  let items;
  if (formats.length) {
    items = formats.map((f) => ({
      q: String(f.height),
      name: `${f.height}p`,
      tag: f.height >= 4320 ? "8K" : f.height >= 2160 ? "4K" : f.height >= 1440 ? "2K" : "",
      meta: [
        f.size_label ? `~${f.size_label}` : "",
        f.fps > 30 ? `${Math.round(f.fps)}fps` : "",
        f.ext && f.ext.toLowerCase() !== "mp4" ? f.ext.toUpperCase() : "",
      ].filter(Boolean).join(" · "),
      hdr: f.hdr,
    }));
  } else {
    items = FALLBACK_HEIGHTS.map((h) => ({
      q: String(h),
      name: `${h}p`,
      tag: h >= 2160 ? "4K" : h >= 1440 ? "2K" : "",
      meta: "Per video",
      hdr: false,
    }));
  }

  const bestMeta = formats.length
    ? `${formats[0].height}p max${formats[0].size_label ? ` · ~${formats[0].size_label}` : ""}`
    : info?.kind === "playlist" ? "Highest for each video" : "Highest available";

  grid.innerHTML = `
    <button type="button" class="quality" data-q="best">
      <span class="q-top"><span class="q-name">Best</span><span class="q-tag">MAX</span></span>
      <span class="q-meta">${escapeHtml(bestMeta)}</span>
      <span class="q-check">${icon("i-check")}</span>
    </button>
    ${items.map((f) => `
      <button type="button" class="quality" data-q="${f.q}">
        <span class="q-top">
          <span class="q-name">${escapeHtml(f.name)}</span>
          ${f.tag ? `<span class="q-tag">${f.tag}</span>` : ""}
          ${f.hdr ? `<span class="q-tag" style="background:rgba(34,211,238,.14);color:#67e8f9">HDR</span>` : ""}
        </span>
        <span class="q-meta">${escapeHtml(f.meta || "Standard")}</span>
        <span class="q-check">${icon("i-check")}</span>
      </button>`).join("")}
  `;
  markSelected("#qualityGrid", "q", state.quality);
  $("#qualityHint").textContent = info?.kind === "playlist"
    ? "applied to every video"
    : formats.length ? `${formats.length} qualities found` : "";
}

function renderAudioFormats() {
  $("#audioGrid").innerHTML = AUDIO_FORMATS.map((f) => `
    <button type="button" class="audio-opt" data-aformat="${f.id}">
      <span class="a-icon">${icon(f.icon)}</span>
      <span class="a-copy"><strong>${f.name}</strong><small>${f.desc}</small></span>
    </button>`).join("");
  markSelected("#audioGrid", "aformat", state.audioFormat);
  updateBitrateVisibility();
  markBitrate();
}

function updateBitrateVisibility() {
  const fmt = AUDIO_FORMATS.find((f) => f.id === state.audioFormat);
  const show = Boolean(fmt?.lossy);
  $("#bitrateRow").hidden = !show;
  $("#bitrateLabel").hidden = !show;
}

function markBitrate() {
  $$("#bitrateRow .pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.br === state.audioQuality);
  });
}

function markSelected(rootSel, attr, value) {
  $$(`${rootSel} [data-${attr}]`).forEach((el) => {
    el.classList.toggle("selected", el.dataset[attr] === String(value));
  });
}

/* -------------------------------- subtitles ------------------------------ */

function renderSubtitles(info) {
  const list = $("#subLangList");
  const entries = info.subtitles || [];
  list.innerHTML = entries.map((s) => `
    <option value="${escapeHtml(s.code)}">${escapeHtml(s.name)}${s.auto ? " (auto)" : ""}</option>
  `).join("");
  const hasEnglish = entries.some((s) => s.code === "en");
  $("#subLangs").value = hasEnglish ? "en" : (entries[0]?.code || "en");
}

/* -------------------------------- playlist ------------------------------- */

function renderPlaylist(info) {
  const block = $("#playlistBlock");
  const isPlaylist = info.kind === "playlist";
  block.hidden = !isPlaylist;
  $("#playlistAll").checked = state.playlistAll;
  $("#playlistItemsWrap").hidden = state.playlistAll;
  $("#playlistTitle").textContent = `Download all ${info.playlist_count || info.entries.length} videos`;

  if (!isPlaylist) {
    $("#plStrip").innerHTML = "";
    return;
  }

  const entries = (info.entries || []).slice(0, 12);
  $("#plStrip").innerHTML = entries.map((e) => `
    <div class="pl-item" title="${escapeHtml(e.title)}">
      ${e.thumbnail
        ? `<img src="${escapeHtml(e.thumbnail)}" alt="" loading="lazy" />`
        : `<div class="pl-ph">${icon("i-film")}</div>`}
      <span>${escapeHtml(e.title)}</span>
    </div>`).join("");
}

/* --------------------------------- mode --------------------------------- */

function setMode(mode, { persist = true } = {}) {
  state.mode = mode;
  const seg = $("#modeSeg");
  seg.classList.toggle("audio", mode === "audio");
  $$(".seg-btn", seg).forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  $("#videoPanel").hidden = mode !== "video";
  $("#audioPanel").hidden = mode === "video";
  const noTrim = mode === "audio" || state.info?.kind === "playlist";
  $("#trimStartField").hidden = noTrim;
  $("#trimEndField").hidden = noTrim;
  $("#sponsorField").hidden = mode === "audio";
  $("#downloadBtnLabel").textContent = "Download";
  syncSummary();
  if (persist) savePrefs();
}

/* -------------------------------- summary ------------------------------- */

function selectedFormat() {
  const formats = state.info?.formats?.video || [];
  if (!formats.length) return null;
  if (state.quality === "best") return [...formats].sort((a, b) => b.height - a.height)[0];
  return formats.find((f) => String(f.height) === String(state.quality)) || null;
}

function videoEstimate() {
  const f = selectedFormat();
  if (!f?.size) return "";
  return `~${fmtBytes(f.size)}`;
}

function audioEstimate() {
  const duration = Number(state.info?.duration) || 0;
  const fmt = AUDIO_FORMATS.find((f) => f.id === state.audioFormat);
  if (!fmt?.lossy || !duration) return "";
  return `~${fmtBytes((Number(state.audioQuality) * 1000 / 8) * duration)}`;
}

function syncSummary() {
  const info = state.info;
  if (!info) return;

  const isPlaylist = info.kind === "playlist";
  const count = info.playlist_count || info.entries.length || 0;
  const duration = isPlaylist ? "" : fmtDuration(info.duration);
  const extras = [];

  if ($("#subToggle").checked || $("#autoSubsToggle").checked) extras.push("subtitles");
  if ($("#sponsorSel").value !== "none" && state.mode === "video") extras.push("sponsorblock");

  let title;
  let sub;

  if (state.mode === "audio") {
    const fmt = AUDIO_FORMATS.find((f) => f.id === state.audioFormat) || AUDIO_FORMATS[0];
    const bitrate = fmt.id === "best" ? "source quality" : fmt.lossy ? `${state.audioQuality} kbps` : "lossless";
    const estimate = audioEstimate();
    title = `${fmt.name} · ${bitrate}`;
    sub = [estimate, isPlaylist ? `${count} videos` : duration, ...extras].filter(Boolean).join(" · ");
  } else {
    const q = qualityLabel(state.quality);
    const container = $("#containerSel").value;
    const estimate = videoEstimate();
    const tag = state.quality === "best" && selectedFormat()
      ? `${selectedFormat().height}p`
      : q;
    title = `${tag}${container !== "auto" ? ` · ${container.toUpperCase()}` : ""}`;
    sub = [
      estimate,
      isPlaylist ? (state.playlistAll ? `${count} videos` : `items ${$("#playlistItems").value.trim() || "1"}`) : duration,
      ...extras,
    ].filter(Boolean).join(" · ");
  }

  $("#summaryTitle").textContent = title || "Ready";
  $("#summarySub").textContent = sub || "Pick a quality above";
  $("#downloadBtnLabel").textContent = isPlaylist
    ? (state.playlistAll ? "Download all" : "Download items")
    : "Download";
}

/* -------------------------------- download ------------------------------ */

function currentOptions() {
  const info = state.info || {};
  const isPlaylist = info.kind === "playlist";
  const all = $("#playlistAll").checked;
  return {
    url: state.url,
    mode: state.mode,
    quality: state.quality,
    container: $("#containerSel").value,
    codec: $("#codecSel").value,
    audio_format: state.audioFormat,
    audio_quality: state.audioQuality,
    playlist: isPlaylist,
    playlist_items: isPlaylist && !all ? ($("#playlistItems").value.trim() || "1") : "",
    filename_template: $("#templateSel").value,
    custom_template: $("#customTemplate").value,
    subtitles: $("#subToggle").checked,
    sub_langs: $("#subLangs").value.trim() || "en",
    auto_subs: $("#autoSubsToggle").checked,
    embed_subs: $("#embedSubsToggle").checked,
    embed_thumbnail: $("#thumbToggle").checked,
    embed_metadata: $("#metaToggle").checked,
    embed_chapters: $("#chapterToggle").checked,
    sponsorblock: $("#sponsorSel").value,
    thumbnail_file: $("#thumbFileToggle").checked,
    trim_start: isPlaylist ? "" : $("#trimStart").value,
    trim_end: isPlaylist ? "" : $("#trimEnd").value,
    rate_limit: $("#rateLimit").value.trim(),
    proxy: $("#proxy").value.trim(),
    cookies_file: $("#cookiesFile").value.trim(),
    cookies_browser: $("#cookiesBrowser").value,
    concurrent_fragments: Number($("#frags").value) || 4,
    retries: Number($("#retries").value) || 0,
    archive: $("#archiveToggle").checked,
    playlist_folder: $("#playlistFolderToggle").checked,
    title: info.title || "",
    thumbnail: info.thumbnail || "",
    channel: info.uploader || "",
    duration: info.duration || 0,
    kind: info.kind || "video",
  };
}

async function startDownload() {
  if (!state.info || state.submitting) return;
  state.submitting = true;
  const btn = $("#downloadBtn");
  btn.classList.add("busy");
  btn.disabled = true;
  $("#downloadBtnLabel").textContent = "Adding…";

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentOptions()),
    });
    if (!res.ok) throw new Error(await readError(res));
    const job = await res.json();
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    syncQueue();
    toast(job.title || "Download added", {
      type: "success",
      title: "Added to the queue",
      timeout: 3200,
    });
    if (window.innerWidth <= 900) {
      setTimeout(() => $("#queueCard").scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
  } catch (err) {
    toast(err.message || "Could not start the download.", { type: "error", title: "Download failed" });
  } finally {
    state.submitting = false;
    btn.classList.remove("busy");
    btn.disabled = false;
    syncSummary();
  }
}

/* --------------------------------- queue -------------------------------- */

const STATUS_TEXT = {
  queued: "Queued",
  fetching: "Reading link",
  downloading: "Downloading",
  processing: "Finishing",
  completed: "Ready",
  error: "Failed",
  canceled: "Canceled",
};

const ACTIVE_STATUSES = new Set(["queued", "fetching", "downloading", "processing"]);

function jobActions(job) {
  const active = ACTIVE_STATUSES.has(job.status);
  if (active) {
    return `<button class="icon-btn" data-action="cancel" title="Cancel" aria-label="Cancel download">${icon("i-x")}</button>`;
  }
  if (job.status === "completed") {
    return `
      ${job.files?.length ? `<button class="icon-btn" data-action="files" title="Files" aria-label="Show files">${icon("i-download")}</button>` : ""}
      <button class="icon-btn" data-action="reveal" title="Show in Finder" aria-label="Show in Finder">${icon("i-folder")}</button>
      <button class="icon-btn danger" data-action="delete" title="Remove from queue" aria-label="Remove">${icon("i-trash")}</button>`;
  }
  return `<button class="icon-btn danger" data-action="delete" title="Remove from queue" aria-label="Remove">${icon("i-trash")}</button>`;
}

function createCard(job) {
  const el = document.createElement("article");
  el.className = "job";
  el.dataset.id = job.id;
  el.innerHTML = `
    <div class="job-thumb">
      <div class="ph">${icon("i-film")}</div>
      <span class="job-dur" hidden></span>
    </div>
    <div class="job-body">
      <div class="job-head">
        <h4 class="job-title"></h4>
        <div class="job-actions"></div>
      </div>
      <div class="job-meta">
        <span class="job-state"><i></i><span class="job-state-text">Queued</span></span>
        <span class="job-detail"></span>
      </div>
      <div class="job-bar"><i></i></div>
    </div>`;
  return el;
}

function updateCard(el, job) {
  el.dataset.status = job.status;

  const title = $(".job-title", el);
  if (title.textContent !== job.title) title.textContent = job.title || "Untitled";
  title.title = job.title || "";

  const thumb = $(".job-thumb", el);
  let img = $("img", thumb);
  if (job.thumbnail) {
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      thumb.prepend(img);
    }
    if (img.getAttribute("src") !== job.thumbnail) img.src = job.thumbnail;
    img.hidden = false;
    $(".ph", thumb).style.display = job.status === "error" ? "" : "none";
  } else {
    if (img) img.hidden = true;
    $(".ph", thumb).style.display = "";
  }

  const dur = $(".job-dur", el);
  const durText = fmtDuration(job.duration);
  dur.textContent = durText;
  dur.hidden = !durText;

  $(".job-state-text", el).textContent = STATUS_TEXT[job.status] || job.status;

  let detail = "";
  if (job.status === "downloading" || job.status === "processing") {
    const pct = Math.floor(job.progress || 0);
    const parts = [`${pct}%`];
    if (job.speed) parts.push(fmtSpeed(job.speed));
    if (job.eta) parts.push(fmtEta(job.eta));
    if (job.item_count > 1) parts.push(`${job.item_index || 1}/${job.item_count}`);
    detail = parts.join(" · ");
  } else if (job.status === "completed") {
    const total = (job.files || []).reduce((sum, f) => sum + (f.size || 0), 0);
    const parts = [];
    if (job.files?.length > 1) parts.push(`${job.files.length} files`);
    if (total) parts.push(fmtBytes(total));
    if (job.mode === "audio") parts.push("audio");
    detail = job.note || parts.join(" · ") || "Saved";
  } else if (job.status === "error") {
    detail = job.error || "Something went wrong";
  } else if (job.status === "canceled") {
    detail = "Stopped";
  } else {
    detail = "Waiting…";
  }

  const detailEl = $(".job-detail", el);
  if (detailEl.textContent !== detail) detailEl.textContent = detail;
  detailEl.title = detail;

  const bar = $(".job-bar i", el);
  const pct = Math.max(0, Math.min(100, job.progress || 0));
  bar.style.width = `${job.status === "completed" ? 100 : pct}%`;

  const actions = $(".job-actions", el);
  const signature = `${job.status}:${job.files?.length || 0}`;
  if (actions.dataset.sig !== signature) {
    actions.innerHTML = jobActions(job);
    actions.dataset.sig = signature;
  }
}

function syncQueue() {
  const jobs = state.jobs;
  const list = $("#queueList");
  const existing = new Map($$(".job", list).map((el) => [el.dataset.id, el]));
  const ids = new Set(jobs.map((j) => j.id));

  for (const [id, el] of existing) {
    if (!ids.has(id)) el.remove();
  }

  jobs.forEach((job, index) => {
    let el = existing.get(job.id);
    if (!el) {
      el = createCard(job);
      state.known.set(job.id, job.status);
    }
    updateCard(el, job);
    const target = list.children[index];
    if (target !== el) list.insertBefore(el, target || null);
  });

  $("#queueEmpty").hidden = jobs.length > 0;
  $("#queueCount").textContent = jobs.length;
  updateStats();

  // Completion / failure toasts
  jobs.forEach((job) => {
    const prev = state.known.get(job.id);
    if (prev && prev !== job.status) {
      if (job.status === "completed") {
        toast(job.note || job.title || "Saved to Downloads", {
          type: "success",
          title: job.note ? "Nothing new to download" : "Download complete",
        });
      } else if (job.status === "error") {
        toast(job.error || "The download failed.", { type: "error", title: "Download failed", timeout: 7000 });
      }
    }
    state.known.set(job.id, job.status);
  });
}

function updateStats(stats) {
  if (stats) {
    if (typeof stats.bytes_label === "string") $("#statBytes").textContent = stats.bytes_label;
    if (typeof stats.completed === "number") $("#statCount").textContent = stats.completed;
    return;
  }
  const done = state.jobs.filter((j) => j.status === "completed");
  const bytes = done.reduce((sum, j) => sum + (j.files || []).reduce((s, f) => s + (f.size || 0), 0), 0);
  $("#statBytes").textContent = bytes ? fmtBytes(bytes) : "0 B";
  $("#statCount").textContent = done.length;
}

function applySnapshot(data) {
  state.jobs = data.jobs || [];
  syncQueue();
  updateStats(data.stats);
}

async function jobAction(action, id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;
  try {
    if (action === "cancel") {
      await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
      toast("Stopping the download…", { type: "info" });
    } else if (action === "delete") {
      const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      state.jobs = state.jobs.filter((j) => j.id !== id);
      syncQueue();
    } else if (action === "reveal") {
      await fetch(`/api/jobs/${id}/reveal`, { method: "POST" });
      toast("Opened in Finder.", { type: "info" });
    } else if (action === "files") {
      openFilesModal(job);
    }
  } catch (err) {
    toast(err.message || "That action failed.", { type: "error" });
  }
}

/* -------------------------------- modal --------------------------------- */

let modalJob = null;

function openFilesModal(job) {
  modalJob = job;
  $("#filesTitle").textContent = job.title || "Download ready";
  $("#filesList").innerHTML = (job.files || []).map((file, index) => `
    <div class="file-row">
      <span class="file-ic">${icon(/\.(mp3|m4a|opus|flac|wav|ogg|aac)$/i.test(file.name) ? "i-music" : "i-film")}</span>
      <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="file-size">${fmtBytes(file.size)}</span>
      <a class="icon-btn" href="/api/jobs/${encodeURIComponent(job.id)}/file/${index}" download title="Save file" aria-label="Save file">${icon("i-download")}</a>
    </div>`).join("") || `<p class="hint" style="padding:12px">No files recorded.</p>`;
  $("#filesModal").hidden = false;
  $("#closeFiles").focus({ preventScroll: true });
}

function closeFilesModal() {
  $("#filesModal").hidden = true;
  modalJob = null;
}

/* --------------------------------- health ------------------------------- */

async function checkHealth() {
  const chip = $("#runtimeChip");
  const text = $("#runtimeText");
  try {
    const res = await fetch("/api/health");
    const health = await res.json();
    chip.classList.toggle("ok", Boolean(health.ffmpeg));
    chip.classList.toggle("err", !health.ffmpeg);
    text.textContent = health.ffmpeg
      ? `yt-dlp ${health.ytdlp} · ffmpeg ready`
      : `yt-dlp ${health.ytdlp} · ffmpeg missing`;
    const runtimes = health.js_runtimes || [];
    const ejs = health.ejs ? ` · ejs ${health.ejs}` : "";
    chip.title = health.ffmpeg
      ? `Ready · saving to ${health.download_dir}\nJS runtime: ${runtimes.join(", ") || "none"}${ejs}`
      : "ffmpeg is missing — merging video and audio will fail. Install it with: brew install ffmpeg";
    if (!health.ffmpeg) {
      toast("ffmpeg is not installed, so video+audio merging won’t work. Run: brew install ffmpeg", {
        type: "error",
        title: "Missing ffmpeg",
        timeout: 9000,
      });
    } else if (!runtimes.length) {
      toast("Some YouTube qualities stay locked without a JS runtime. Install Node (brew install node) and restart Catch.", {
        type: "info",
        title: "Limited YouTube formats",
        timeout: 9000,
      });
    }
  } catch {
    chip.classList.add("err");
    text.textContent = "Engine offline";
  }
}

/* --------------------------------- events ------------------------------- */

function bindEvents() {
  $("#urlForm").addEventListener("submit", (e) => {
    e.preventDefault();
    fetchInfo();
  });

  $("#pasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $("#urlInput").value = text.trim();
        fetchInfo();
      }
    } catch {
      $("#urlInput").focus();
      toast("Clipboard access was blocked — press ⌘V in the field.", { type: "info" });
    }
  });

  $("#urlInput").addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text")?.trim();
    if (text && /^https?:\/\//i.test(text)) {
      e.preventDefault();
      $("#urlInput").value = text;
      setTimeout(fetchInfo, 80);
    }
  });

  $("#dismissError").addEventListener("click", hideError);
  $("#previewThumb").addEventListener("load", (event) => {
    const img = event.currentTarget;
    const portrait = img.naturalHeight > img.naturalWidth * 1.06;
    $(".preview-media").classList.toggle("portrait", portrait);
  });
  $("#changeLink").addEventListener("click", () => {
    $("#urlInput").focus();
    $("#urlInput").select();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#modeSeg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (btn) setMode(btn.dataset.mode);
  });

  $("#qualityGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-q]");
    if (!btn) return;
    state.quality = btn.dataset.q;
    markSelected("#qualityGrid", "q", state.quality);
    syncSummary();
  });

  $("#audioGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-aformat]");
    if (!btn) return;
    state.audioFormat = btn.dataset.aformat;
    markSelected("#audioGrid", "aformat", state.audioFormat);
    updateBitrateVisibility();
    syncSummary();
    savePrefs();
  });

  $("#bitrateRow").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-br]");
    if (!btn) return;
    state.audioQuality = btn.dataset.br;
    markBitrate();
    syncSummary();
    savePrefs();
  });

  $("#playlistAll").addEventListener("change", (e) => {
    state.playlistAll = e.target.checked;
    $("#playlistItemsWrap").hidden = state.playlistAll;
    if (!state.playlistAll) setTimeout(() => $("#playlistItems").focus(), 40);
    syncSummary();
  });

  $("#playlistItems").addEventListener("input", syncSummary);

  $("#subToggle").addEventListener("change", (e) => {
    $("#subPanel").classList.toggle("open", e.target.checked);
    syncSummary();
  });

  $("#autoSubsToggle").addEventListener("change", syncSummary);
  $("#sponsorSel").addEventListener("change", syncSummary);
  $("#containerSel").addEventListener("change", () => {
    syncCodecOptions();
    syncSummary();
  });

  $("#templateSel").addEventListener("change", () => {
    toggleCustomTemplate();
    savePrefs();
  });

  $("#downloadBtn").addEventListener("click", startDownload);

  $("#queueList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const card = btn.closest(".job");
    if (card) jobAction(btn.dataset.action, card.dataset.id);
  });

  $("#clearQueue").addEventListener("click", async () => {
    try {
      const res = await fetch("/api/jobs", { method: "DELETE" });
      if (res.ok) {
        applySnapshot(await res.json());
        toast("Finished downloads cleared.", { type: "info" });
      }
    } catch {
      toast("Could not clear the queue.", { type: "error" });
    }
  });

  ["#openFolderTop", "#openFolderSide"].forEach((sel) => {
    $(sel)?.addEventListener("click", async () => {
      try {
        await fetch("/api/reveal-downloads", { method: "POST" });
      } catch {
        toast("Could not open the downloads folder.", { type: "error" });
      }
    });
  });

  $("#tipAdvanced")?.addEventListener("click", () => {
    const advanced = $("#advanced");
    advanced.open = true;
    advanced.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => $("#cookiesBrowser").focus({ preventScroll: true }), 450);
  });

  $("#closeFiles").addEventListener("click", closeFilesModal);
  $("#filesModal").addEventListener("click", (e) => {
    if (e.target.dataset.close || e.target.id === "filesModal") closeFilesModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (! $("#filesModal").hidden) { closeFilesModal(); return; }
      if (document.activeElement === $("#urlInput")) $("#urlInput").blur();
      hideError();
    }
    if (e.key === "/" && !/(INPUT|TEXTAREA|SELECT)/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $("#urlInput").focus();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") startDownload();
  });

  document.addEventListener("paste", (e) => {
    if (/(INPUT|TEXTAREA)/.test(document.activeElement.tagName)) return;
    const text = e.clipboardData?.getData("text")?.trim();
    if (text && /^https?:\/\//i.test(text)) {
      $("#urlInput").value = text;
      fetchInfo();
    }
  });

  // drag & drop
  let dragDepth = 0;
  const overlay = $("#dropOverlay");
  window.addEventListener("dragenter", (e) => {
    if (![...(e.dataTransfer?.types || [])].some((t) => t === "text/plain" || t === "text/uri-list")) return;
    dragDepth += 1;
    overlay.classList.add("show");
  });
  window.addEventListener("dragover", (e) => {
    if (overlay.classList.contains("show")) e.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.classList.remove("show");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove("show");
    const text = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "";
    const url = text.split(/\r?\n/).find((line) => /^https?:\/\//i.test(line.trim()));
    if (url) {
      $("#urlInput").value = url.trim();
      fetchInfo();
    } else {
      toast("Drop a link, not a file.", { type: "info" });
    }
  });

  document.addEventListener("change", () => savePrefs());

  // persist a few key controls on change
  ["#containerSel", "#codecSel", "#thumbToggle", "#metaToggle", "#chapterToggle",
   "#thumbFileToggle", "#archiveToggle", "#sponsorSel", "#templateSel", "#playlistFolderToggle"]
    .forEach((sel) => $(sel)?.addEventListener("change", savePrefs));
}

/* -------------------------------- helpers ------------------------------- */

function toggleCustomTemplate() {
  const custom = $("#templateSel").value === "custom";
  $("#customTemplateWrap").hidden = !custom;
}

function syncCodecOptions() {
  const webm = $("#containerSel").value === "webm";
  const h264 = $('#codecSel option[value="h264"]');
  if (h264) {
    h264.disabled = webm;
    h264.textContent = webm ? "H.264 · not supported in WEBM" : "H.264 · plays everywhere";
  }
  if (webm && $("#codecSel").value === "h264") $("#codecSel").value = "any";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* --------------------------------- boot --------------------------------- */

function connectStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (event) => {
    if (!event.data) return;
    try {
      applySnapshot(JSON.parse(event.data));
    } catch { /* ignore malformed frame */ }
  };
}

function boot() {
  applyPrefs();
  renderAudioFormats();
  setMode(state.mode, { persist: false });
  syncCodecOptions();
  bindEvents();
  checkHealth();
  connectStream();
  $("#urlInput").focus({ preventScroll: true });
}

boot();
