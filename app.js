"use strict";

const STORAGE_KEY = "cronosesion.session.v1";
const SCHEMA_VERSION = 6; // bump whenever the saved-state shape changes; old saves are discarded rather than migrated

const SOURCE_LABELS = {
  scrum: "Scrum",
  lineout: "Line Out",
  open: "Juego libre",
  kick: "Patada"
};

/* ---------- Clock helpers ----------
   Each clock stores an elapsed baseline (ms) plus the real timestamp it was
   last (re)started at. Live elapsed time is always derived by diffing the
   real clock, never by counting timer ticks, so it stays correct even if the
   tab is backgrounded/suspended. */

function createClock() {
  return { elapsedMs: 0, lastStartedAt: null, running: false };
}

function startClock(clock, atIso) {
  if (clock.running) return;
  clock.running = true;
  clock.lastStartedAt = atIso;
}

function stopClock(clock, atIso) {
  if (!clock.running) return;
  clock.elapsedMs = clockElapsedMs(clock, Date.parse(atIso));
  clock.running = false;
  clock.lastStartedAt = null;
}

function clockElapsedMs(clock, nowMs = Date.now()) {
  if (!clock.running || !clock.lastStartedAt) return clock.elapsedMs;
  const startedAtMs = Date.parse(clock.lastStartedAt);
  if (!Number.isFinite(startedAtMs)) return clock.elapsedMs;
  return clock.elapsedMs + Math.max(0, nowMs - startedAtMs);
}

/* ---------- Formatting ---------- */

function fmtHMS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtMS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtClockTime(iso) {
  if (!iso) return "--:--:--";
  return new Date(iso).toLocaleTimeString("es-AR", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ---------- Wake Lock ----------
   Keeps the screen on for the whole time a session is running, so the
   coach doesn't lose the live view (and the tab doesn't get backgrounded,
   which throttles timers) mid-drill. The lock is released automatically by
   the browser whenever the tab is hidden, so it has to be re-requested on
   visibilitychange rather than assumed to persist. */

let wakeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    wakeLock = null; // unsupported, denied, or tab not visible — non-fatal
  }
}

async function releaseWakeLockIfHeld() {
  if (!wakeLock) return;
  const held = wakeLock;
  wakeLock = null;
  try { await held.release(); } catch { /* already released */ }
}

function syncWakeLock() {
  if (state.status === "running") requestWakeLock();
  else releaseWakeLockIfHeld();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  syncWakeLock();
  tick(); // repaint immediately instead of waiting for the next 500ms beat
});

/* ---------- State ---------- */

let state = loadState() || freshSession();

function freshSession() {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid(),
    startedAt: null,
    endedAt: null,
    status: "idle", // idle | running | finished
    clock: createClock(),
    activities: [],
    runningActivityId: null
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable, non-fatal */
  }
}

function currentActivity() {
  return state.activities.find((a) => a.id === state.runningActivityId) || null;
}

/* ---------- Actions ---------- */

function startSession() {
  const t = nowIso();
  state.startedAt = t;
  state.status = "running";
  startClock(state.clock, t);
  saveState();
  render();
}

function finishSession() {
  const t = nowIso();
  const active = currentActivity();
  if (active) finishActivity(active.id, t, { skipRender: true });
  stopClock(state.clock, t);
  state.endedAt = t;
  state.status = "finished";
  saveState();
  render();
}

function startActivity(name) {
  if (state.runningActivityId) return;
  const t = nowIso();
  const activity = {
    id: uid(),
    name: name.trim() || "Actividad sin nombre",
    startedAt: t,
    endedAt: null,
    status: "running",
    phase: "BOP",
    // Each entry is a real timestamped interval, not just an accumulated
    // total, so the exact play/rest sequence can be drawn on a timeline and
    // later lined up against GPS or video timestamps. Whether this activity
    // "measures BIP" isn't a separate flag — it's simply whether a BIP
    // segment ever shows up here. Tag a restart source at any point to
    // start counting; never tag one and it just stays a plain timer.
    segments: [{ id: uid(), phase: "BOP", startedAt: t, endedAt: null }],
    // Point-in-time occurrences (no duration), e.g. rucks.
    events: []
  };
  state.activities.push(activity);
  state.runningActivityId = activity.id;
  saveState();
  render();
}

function closeOpenSegment(activity, atIso) {
  const openSegment = activity.segments[activity.segments.length - 1];
  if (openSegment && openSegment.endedAt === null) openSegment.endedAt = atIso;
}

function startBip(activityId, source) {
  const activity = state.activities.find((a) => a.id === activityId);
  if (!activity || activity.status !== "running" || activity.phase === "BIP") return;
  const t = nowIso();
  closeOpenSegment(activity, t);
  activity.segments.push({ id: uid(), phase: "BIP", source, startedAt: t, endedAt: null });
  activity.phase = "BIP";
  saveState();
  render();
}

function endBip(activityId) {
  const activity = state.activities.find((a) => a.id === activityId);
  if (!activity || activity.status !== "running" || activity.phase !== "BIP") return;
  const t = nowIso();
  closeOpenSegment(activity, t);
  activity.segments.push({ id: uid(), phase: "BOP", startedAt: t, endedAt: null });
  activity.phase = "BOP";
  saveState();
  render();
}

function logEvent(activityId, type) {
  const activity = state.activities.find((a) => a.id === activityId);
  if (!activity || activity.status !== "running") return;
  activity.events.push({ id: uid(), type, at: nowIso() });
  saveState();
  render();
}

/* Reopen the most recently finished activity so it can keep being timed —
   e.g. it was marked done, then the coach decided to run one more rep. Only
   valid for the last activity in the session while nothing else is running,
   since the single-slot runningActivityId model can't represent two
   activities in progress at once. */
function reopenLastActivity() {
  if (state.status !== "running" || state.runningActivityId) return;
  const activity = state.activities[state.activities.length - 1];
  if (!activity || activity.status !== "finished") return;
  activity.status = "running";
  activity.endedAt = null;
  const lastSegment = activity.segments[activity.segments.length - 1];
  lastSegment.endedAt = null;
  activity.phase = lastSegment.phase;
  state.runningActivityId = activity.id;
  saveState();
  render();
}

function finishActivity(activityId, atIso, opts = {}) {
  const activity = state.activities.find((a) => a.id === activityId);
  if (!activity || activity.status !== "running") return;
  const t = atIso || nowIso();
  closeOpenSegment(activity, t);
  activity.status = "finished";
  activity.endedAt = t;
  activity.phase = null;
  if (state.runningActivityId === activityId) state.runningActivityId = null;
  saveState();
  if (!opts.skipRender) render();
}

/* Removes a single Live Feed line and keeps the timeline consistent:
   - an event (ruck/kick) is just spliced out, nothing else depends on it.
   - a segment (a BIP/BOP phase change) is merged into the segment right
     before it, as if that particular toggle never happened — the previous
     segment's endedAt is extended to swallow the removed one, so a segment
     that follows (if any) still starts exactly where the merged one now
     ends, and no gap or overlap is introduced. The activity's very first
     segment (its opening BOP, created the instant the activity started)
     can't be merged into anything before it, so it's not deletable. */
function undoFeedItem(activity, refType, refId) {
  if (refType === "event") {
    const idx = activity.events.findIndex((e) => e.id === refId);
    if (idx === -1) return;
    activity.events.splice(idx, 1);
  } else if (refType === "segment") {
    const idx = activity.segments.findIndex((s) => s.id === refId);
    if (idx <= 0) return;
    const removed = activity.segments[idx];
    const prev = activity.segments[idx - 1];
    prev.endedAt = removed.endedAt;
    activity.segments.splice(idx, 1);
    if (activity.segments[activity.segments.length - 1] === prev) {
      activity.phase = prev.phase;
    }
  } else {
    return;
  }
  saveState();
  render();
}

function newSession() {
  if (state.status === "running" || (state.status === "finished" && state.activities.length)) {
    const ok = confirm("¿Descartar la sesión actual y empezar una nueva? Si no exportaste el CSV se perderán los datos.");
    if (!ok) return;
  }
  state = freshSession();
  saveState();
  render();
}

/* ---------- Derived stats ---------- */

function segmentDurationMs(segment, nowMs) {
  const startMs = Date.parse(segment.startedAt);
  const endMs = segment.endedAt ? Date.parse(segment.endedAt) : nowMs;
  return Math.max(0, endMs - startMs);
}

function activityStats(activity, nowMs = Date.now()) {
  let bipMs = 0;
  let bopMs = 0;
  for (const seg of activity.segments) {
    const d = segmentDurationMs(seg, nowMs);
    if (seg.phase === "BIP") bipMs += d;
    else bopMs += d;
  }
  const totalMs = bipMs + bopMs;
  const pct = totalMs > 0 ? (bipMs / totalMs) * 100 : 0;
  const ratio = bopMs > 0 ? bipMs / bopMs : (bipMs > 0 ? Infinity : 0);
  // "Tracked" isn't a stored flag — it's simply whether a BIP tag was ever
  // used. An activity that's all BOP was never actually measured, so it
  // reads as "sin medir" rather than a misleading 0%.
  const tracked = activity.segments.some((seg) => seg.phase === "BIP");
  return { bipMs, bopMs, totalMs, pct, ratio, tracked };
}

function formatRatio(ratio) {
  if (!Number.isFinite(ratio)) return bipOnlyLabel(ratio);
  if (ratio === 0) return "0:1";
  if (ratio >= 1) return `${ratio.toFixed(1)}:1`;
  return `1:${(1 / ratio).toFixed(1)}`;
}
function bipOnlyLabel(ratio) {
  return ratio > 0 ? "solo BIP" : "—";
}

function sessionAggregates() {
  const sourceCounts = { scrum: 0, lineout: 0, open: 0, kick: 0 };
  const eventCounts = { RUCK: 0, KICK: 0 };
  state.activities.forEach((activity) => {
    activity.segments.forEach((seg) => {
      if (seg.phase === "BIP" && seg.source in sourceCounts) sourceCounts[seg.source]++;
    });
    activity.events.forEach((ev) => {
      if (ev.type in eventCounts) eventCounts[ev.type]++;
    });
  });
  return { sourceCounts, eventCounts };
}

/* Session-wide "% Juego real": bipMs / (bipMs + bopMs), summed only across
   activities that actually tagged a BIP source at some point (activityStats'
   `tracked` flag). Activities that were only ever timed as a plain BOP block
   (nothing tagged) are left out of both sides of the ratio entirely — folding
   their time into the denominator would silently drag the session's % down
   for a reason that has nothing to do with how much the team actually
   played, just which activities the coach happened to tag. */
function sessionBipStats() {
  const finished = state.activities.filter((a) => a.status === "finished");
  let bipMs = 0;
  let bopMs = 0;
  let trackedCount = 0;
  finished.forEach((activity) => {
    const stats = activityStats(activity);
    if (!stats.tracked) return;
    bipMs += stats.bipMs;
    bopMs += stats.bopMs;
    trackedCount++;
  });
  const totalMs = bipMs + bopMs;
  const pct = totalMs > 0 ? (bipMs / totalMs) * 100 : 0;
  const ratio = bopMs > 0 ? bipMs / bopMs : (bipMs > 0 ? Infinity : 0);
  return { bipMs, bopMs, totalMs, pct, ratio, trackedCount, totalCount: finished.length };
}

const BIP_STREAK_BUCKETS = [
  { label: "0-20\"", min: 0, max: 20 },
  { label: "20-40\"", min: 20, max: 40 },
  { label: "40-60\"", min: 40, max: 60 },
  { label: "60-90\"", min: 60, max: 90 },
  { label: "90-120\"", min: 90, max: 120 },
  { label: "+120\"", min: 120, max: Infinity }
];

/* Worst Case Scenario: the single longest uninterrupted BIP streak in the
   session, plus a histogram of every BIP streak's length — how many short
   bursts vs sustained periods of real play the team actually produced. */
function bipStreakStats() {
  const streaks = [];
  state.activities.forEach((activity) => {
    activity.segments.forEach((seg) => {
      if (seg.phase !== "BIP" || !seg.endedAt) return;
      const durationS = (Date.parse(seg.endedAt) - Date.parse(seg.startedAt)) / 1000;
      streaks.push({ durationS, startedAt: seg.startedAt, endedAt: seg.endedAt, activityName: activity.name });
    });
  });

  const buckets = BIP_STREAK_BUCKETS.map((b) => ({ ...b, count: 0 }));
  let longest = null;
  streaks.forEach((s) => {
    const bucket = buckets.find((b) => s.durationS >= b.min && s.durationS < b.max) || buckets[buckets.length - 1];
    bucket.count++;
    if (!longest || s.durationS > longest.durationS) longest = s;
  });

  return { buckets, longest, total: streaks.length };
}

/* ---------- CSV export ---------- */

function buildCsv() {
  const headers = [
    "session_id", "session_start_time", "session_end_time", "session_duration_s",
    "activity_name", "activity_start_time", "activity_end_time", "activity_duration_s",
    "bip_duration_s", "bop_duration_s", "bip_percent", "work_rest_ratio",
    "ruck_count", "kick_event_count"
  ];
  const sessionDurationS = Math.round(clockElapsedMs(state.clock) / 1000);
  const rows = state.activities.map((activity) => {
    const stats = activityStats(activity);
    return [
      state.id,
      state.startedAt || "",
      state.endedAt || "",
      sessionDurationS,
      csvEscape(activity.name),
      activity.startedAt || "",
      activity.endedAt || "",
      Math.round(stats.totalMs / 1000),
      Math.round(stats.bipMs / 1000),
      Math.round(stats.bopMs / 1000),
      stats.tracked ? stats.pct.toFixed(1) : "",
      stats.tracked && Number.isFinite(stats.ratio) ? stats.ratio.toFixed(2) : "",
      activity.events.filter((e) => e.type === "RUCK").length,
      activity.events.filter((e) => e.type === "KICK").length
    ].join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvFileName() {
  const stamp = (state.startedAt || nowIso()).replace(/[:.]/g, "-");
  return `cronosesion_${stamp}.csv`;
}

function exportCsv() {
  const csv = buildCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = csvFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* Shares the CSV through the device's native share sheet (WhatsApp, Mail,
   AirDrop, etc.) instead of a hosted link — keeps everything local, no
   server involved. Falls back to a plain download if the browser/device
   doesn't support sharing files (e.g. desktop Safari, older browsers). */
async function shareCsv() {
  const csv = buildCsv();
  const file = new File([csv], csvFileName(), { type: "text/csv" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "Cronosesión",
        text: `Resumen de sesión — ${fmtClockTime(state.startedAt)} a ${fmtClockTime(state.endedAt)}`
      });
    } catch (err) {
      if (err.name !== "AbortError") exportCsv();
    }
  } else {
    exportCsv();
  }
}

/* ---------- Import from Angles XML ----------
   Angles exports a Sportscode-style timeline XML (UTF-16, one <instance> per
   coded event with <code>/<start>/<end> in seconds from the video's zero
   point). We only pull the "01 BIP" / "02 OUT" tracks — Angles ships a
   duplicate "BIP GPS" copy of the BIP track specifically for lining up with
   GPS providers, which confirms this maps directly onto our own phase model.
   The video's own clock has no relation to wall-clock time, so the user
   supplies one anchor point (the real time video-second 0 corresponds to)
   and every timestamp is derived from that. */

let pendingAnglesImport = null;

async function decodeXmlFile(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let encoding = "utf-8";
  let offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; offset = 2; }
  return new TextDecoder(encoding).decode(buf.slice(offset));
}

function parseAnglesXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML inválido o corrupto");

  const segments = [];
  for (const inst of doc.querySelectorAll("instance")) {
    const code = (inst.querySelector("code")?.textContent || "").trim().toUpperCase();
    const startS = parseFloat(inst.querySelector("start")?.textContent);
    const endS = parseFloat(inst.querySelector("end")?.textContent);
    if (!Number.isFinite(startS) || !Number.isFinite(endS)) continue;
    if (/\bBIP\b/.test(code) && !code.includes("GPS")) {
      segments.push({ phase: "BIP", startMs: startS * 1000, endMs: endS * 1000 });
    } else if (code.includes("OUT")) {
      segments.push({ phase: "BOP", startMs: startS * 1000, endMs: endS * 1000 });
    }
  }
  if (!segments.length) throw new Error("No se encontraron tramos BIP/OUT en este archivo");
  segments.sort((a, b) => a.startMs - b.startMs);
  return segments;
}

function buildSessionFromAngles(segments, anchorMs) {
  const toIso = (ms) => new Date(anchorMs + ms).toISOString();
  const minStartMs = segments[0].startMs;
  const maxEndMs = Math.max(...segments.map((s) => s.endMs));
  const startedAt = toIso(minStartMs);
  const endedAt = toIso(maxEndMs);
  const activity = {
    id: uid(),
    name: "Partido importado (Angles)",
    startedAt,
    endedAt,
    status: "finished",
    phase: null,
    segments: segments.map((s) => ({
      id: uid(),
      phase: s.phase,
      startedAt: toIso(s.startMs),
      endedAt: toIso(s.endMs)
    })),
    events: []
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid(),
    startedAt,
    endedAt,
    status: "finished",
    clock: { elapsedMs: maxEndMs - minStartMs, lastStartedAt: null, running: false },
    activities: [activity],
    runningActivityId: null
  };
}

/* ---------- Rendering ---------- */

const el = {
  recoveryBanner: document.getElementById("recovery-banner"),
  recoveryText: document.getElementById("recovery-text"),
  btnRecoveryContinue: document.getElementById("btn-recovery-continue"),
  btnRecoveryDiscard: document.getElementById("btn-recovery-discard"),
  btnNewSession: document.getElementById("btn-new-session"),
  viewIdle: document.getElementById("view-idle"),
  btnStartSession: document.getElementById("btn-start-session"),
  btnShowImport: document.getElementById("btn-show-import"),
  importForm: document.getElementById("import-form"),
  importFileInput: document.getElementById("import-file-input"),
  importStatus: document.getElementById("import-status"),
  importAnchorRow: document.getElementById("import-anchor-row"),
  importAnchorTime: document.getElementById("import-anchor-time"),
  btnConfirmImport: document.getElementById("btn-confirm-import"),
  viewSession: document.getElementById("view-session"),
  sessionStartTime: document.getElementById("session-start-time"),
  sessionElapsed: document.getElementById("session-elapsed"),
  sessionEndTime: document.getElementById("session-end-time"),
  btnFinishSession: document.getElementById("btn-finish-session"),
  newActivityForm: document.getElementById("new-activity-form"),
  inputActivityName: document.getElementById("input-activity-name"),
  btnStartActivity: document.getElementById("btn-start-activity"),
  activeActivity: document.getElementById("active-activity"),
  activeActivityName: document.getElementById("active-activity-name"),
  activeActivityStart: document.getElementById("active-activity-start"),
  activeActivityElapsed: document.getElementById("active-activity-elapsed"),
  phaseStatusBip: document.querySelector(".phase-status-item.bip"),
  phaseStatusBop: document.querySelector(".phase-status-item.bop"),
  liveBall: document.getElementById("live-ball"),
  liveBallWrap: document.getElementById("live-ball-wrap"),
  liveBallPhase: document.getElementById("live-ball-phase"),
  liveBallSub: document.getElementById("live-ball-sub"),
  bipSourceHint: document.getElementById("bip-source-hint"),
  bipSourcePicker: document.getElementById("bip-source-picker"),
  sourceButtons: Array.from(document.querySelectorAll(".source-btn")),
  bipActiveInfo: document.getElementById("bip-active-info"),
  bipSourceLabel: document.getElementById("bip-source-label"),
  btnEndBip: document.getElementById("btn-end-bip"),
  bipTime: document.getElementById("bip-time"),
  bopTime: document.getElementById("bop-time"),
  bipBarFill: document.getElementById("bip-bar-fill"),
  bipPercent: document.getElementById("bip-percent"),
  bipRatio: document.getElementById("bip-ratio"),
  btnLogRuck: document.getElementById("btn-log-ruck"),
  ruckCount: document.getElementById("ruck-count"),
  btnLogKick: document.getElementById("btn-log-kick"),
  kickCount: document.getElementById("kick-count"),
  liveFeedList: document.getElementById("live-feed-list"),
  btnUndoLast: document.getElementById("btn-undo-last"),
  btnFinishActivity: document.getElementById("btn-finish-activity"),
  activitiesListWrap: document.getElementById("activities-list-wrap"),
  activitiesList: document.getElementById("activities-list"),
  sessionSummary: document.getElementById("session-summary"),
  sumBipPercent: document.getElementById("sum-bip-percent"),
  sumBipRatio: document.getElementById("sum-bip-ratio"),
  bipPercentNote: document.getElementById("bip-percent-note"),
  sumScrum: document.getElementById("sum-scrum"),
  sumLineout: document.getElementById("sum-lineout"),
  sumOpen: document.getElementById("sum-open"),
  sumKickRestart: document.getElementById("sum-kick-restart"),
  sumRuck: document.getElementById("sum-ruck"),
  sumKickEvent: document.getElementById("sum-kick-event"),
  sumRuckPerMin: document.getElementById("sum-ruck-per-min"),
  sumRuckPerBipMin: document.getElementById("sum-ruck-per-bip-min"),
  sumKickPerMin: document.getElementById("sum-kick-per-min"),
  sumKickPerBipMin: document.getElementById("sum-kick-per-bip-min"),
  wcsStat: document.getElementById("wcs-stat"),
  bipDistribution: document.getElementById("bip-distribution"),
  btnExportCsv: document.getElementById("btn-export-csv"),
  btnExportPdf: document.getElementById("btn-export-pdf"),
  btnShare: document.getElementById("btn-share")
};

function render() {
  syncWakeLock();

  const hasSession = state.status !== "idle";
  el.viewIdle.hidden = hasSession;
  el.viewSession.hidden = !hasSession;
  el.btnNewSession.hidden = !hasSession;

  if (!hasSession) return;

  el.sessionStartTime.textContent = fmtClockTime(state.startedAt);
  el.sessionEndTime.textContent = state.endedAt ? fmtClockTime(state.endedAt) : "--:--:--";
  el.btnFinishSession.hidden = state.status !== "running";

  const active = currentActivity();
  el.newActivityForm.hidden = state.status !== "running" || !!active;
  el.activeActivity.hidden = !active;

  if (active) {
    el.activeActivityName.textContent = active.name;
    el.activeActivityStart.textContent = fmtClockTime(active.startedAt);
    el.phaseStatusBip.classList.toggle("active", active.phase === "BIP");
    el.phaseStatusBop.classList.toggle("active", active.phase === "BOP");
    el.liveBall.classList.toggle("phase-bip", active.phase === "BIP");
    el.liveBall.classList.toggle("phase-bop", active.phase === "BOP");
    el.liveBallWrap.classList.toggle("pulse-bip", active.phase === "BIP");
    el.liveBallWrap.classList.toggle("pulse-bop", active.phase === "BOP");

    const inPlay = active.phase === "BIP";
    el.bipSourceHint.hidden = inPlay;
    el.bipSourcePicker.hidden = inPlay;
    el.bipActiveInfo.hidden = !inPlay;
    el.btnEndBip.hidden = !inPlay;
    if (inPlay) {
      const openSegment = active.segments[active.segments.length - 1];
      const sourceLabel = SOURCE_LABELS[openSegment.source] || "—";
      el.bipSourceLabel.textContent = sourceLabel;
      el.liveBallPhase.textContent = "BIP";
      el.liveBallSub.textContent = sourceLabel;
    } else {
      el.liveBallPhase.textContent = "BOP";
      el.liveBallSub.textContent = "Fuera de juego";
    }

    el.ruckCount.textContent = active.events.filter((e) => e.type === "RUCK").length;
    el.kickCount.textContent = active.events.filter((e) => e.type === "KICK").length;
    renderLiveFeed(active);
  }

  renderFinishedActivities();
  renderTimeline();

  el.sessionSummary.hidden = state.status !== "finished";
  if (state.status === "finished") {
    const bipAgg = sessionBipStats();
    el.sumBipPercent.textContent = bipAgg.totalMs > 0 ? `${bipAgg.pct.toFixed(0)}%` : "—";
    el.sumBipRatio.textContent = bipAgg.totalMs > 0 ? formatRatio(bipAgg.ratio) : "—";
    el.bipPercentNote.textContent = bipAgg.totalCount > bipAgg.trackedCount
      ? `Calculado sobre ${bipAgg.trackedCount} de ${bipAgg.totalCount} actividades (las que midieron BIP). No incluye el tiempo de las actividades sin medir.`
      : `Calculado sobre las ${bipAgg.trackedCount} actividades de la sesión.`;

    const { sourceCounts, eventCounts } = sessionAggregates();
    el.sumScrum.textContent = sourceCounts.scrum;
    el.sumLineout.textContent = sourceCounts.lineout;
    el.sumOpen.textContent = sourceCounts.open;
    el.sumKickRestart.textContent = sourceCounts.kick;
    el.sumRuck.textContent = eventCounts.RUCK;
    el.sumKickEvent.textContent = eventCounts.KICK;

    const sessionMin = clockElapsedMs(state.clock) / 60000;
    const bipMin = bipAgg.bipMs / 60000;
    const perMin = (count, minutes) => (minutes > 0 ? (count / minutes).toFixed(1) : "—");
    el.sumRuckPerMin.textContent = perMin(eventCounts.RUCK, sessionMin);
    el.sumRuckPerBipMin.textContent = perMin(eventCounts.RUCK, bipMin);
    el.sumKickPerMin.textContent = perMin(eventCounts.KICK, sessionMin);
    el.sumKickPerBipMin.textContent = perMin(eventCounts.KICK, bipMin);

    const { buckets, longest } = bipStreakStats();
    el.wcsStat.innerHTML = longest
      ? `<span class="wcs-duration">${fmtHMS(longest.durationS * 1000)}</span> — ${fmtClockTime(longest.startedAt)} a ${fmtClockTime(longest.endedAt)} · ${escapeHtml(longest.activityName)}`
      : "Sin datos";
    const maxCount = Math.max(1, ...buckets.map((b) => b.count));
    el.bipDistribution.innerHTML = buckets.map((b) => `
      <div class="dist-row">
        <span class="dist-label">${b.label}</span>
        <div class="dist-bar"><div class="dist-bar-fill" style="width:${((b.count / maxCount) * 100).toFixed(1)}%"></div></div>
        <span class="dist-count">${b.count}</span>
      </div>`).join("");
  }

  tick(); // paint live numbers immediately
  saveState();
}

const FEED_MAX_ITEMS = 8;

/* A chronological feed of what just happened in the current activity —
   restart taps, BOP switches, ruck/kick counts — newest first. Built fresh
   from segments/events each render rather than stored separately, so it
   can never drift out of sync with the data that drives the stats. Each
   item carries enough (refType/refId) to be individually undone — except
   the activity's very first segment (its opening BOP), which can't be
   merged into anything earlier and so isn't deletable. */
function buildFeedItems(activity) {
  const items = [];
  activity.segments.forEach((seg, idx) => {
    const canUndo = idx > 0;
    if (seg.phase === "BIP") {
      items.push({ at: seg.startedAt, kind: "feed-bip", text: `BIP iniciado — ${SOURCE_LABELS[seg.source] || "origen desconocido"}`, refType: "segment", refId: seg.id, canUndo });
    } else {
      items.push({ at: seg.startedAt, kind: "feed-bop", text: "BOP — fuera de juego", refType: "segment", refId: seg.id, canUndo });
    }
  });
  activity.events.forEach((ev) => {
    items.push({ at: ev.at, kind: "feed-event", text: ev.type === "RUCK" ? "+1 Ruck" : "+1 Patada en juego", refType: "event", refId: ev.id, canUndo: true });
  });
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return items;
}

function renderLiveFeed(activity) {
  const items = buildFeedItems(activity);
  const latest = items.slice(0, FEED_MAX_ITEMS);

  el.btnUndoLast.disabled = !(items[0] && items[0].canUndo);

  el.liveFeedList.innerHTML = latest.length
    ? latest.map((item) => `
        <li class="${item.kind}">
          <time>${fmtClockTime(item.at)}</time>
          <span class="feed-text">${escapeHtml(item.text)}</span>
          ${item.canUndo ? `<button class="feed-delete-btn" type="button" data-ref-type="${item.refType}" data-ref-id="${item.refId}" aria-label="Borrar este evento">✕</button>` : ""}
        </li>`).join("")
    : `<li class="live-feed-empty" style="border:none;background:none;">Sin eventos todavía</li>`;
}

function renderFinishedActivities() {
  const finished = state.activities.filter((a) => a.status === "finished");
  el.activitiesListWrap.hidden = finished.length === 0;
  el.activitiesList.innerHTML = "";
  const canResume = state.status === "running" && !state.runningActivityId
    && state.activities.length > 0
    && state.activities[state.activities.length - 1].status === "finished";
  const lastActivityId = state.activities.length
    ? state.activities[state.activities.length - 1].id
    : null;

  finished.forEach((activity) => {
    const stats = activityStats(activity);
    const li = document.createElement("li");
    const bipMeta = stats.tracked ? `
        <span class="bip-tag">BIP ${fmtHMS(stats.bipMs)}</span>
        <span class="bop-tag">BOP ${fmtHMS(stats.bopMs)}</span>
        <span>${stats.pct.toFixed(0)}% juego real</span>
        <span>ratio ${formatRatio(stats.ratio)}</span>` : `
        <span class="bip-tag" style="color:var(--untracked)">sin medir BIP</span>`;
    li.innerHTML = `
      <div class="act-name">${escapeHtml(activity.name)}</div>
      <div class="act-meta">
        <span>${fmtClockTime(activity.startedAt)} → ${fmtClockTime(activity.endedAt)}</span>
        <span>${fmtHMS(stats.totalMs)} total</span>${bipMeta}
      </div>`;
    if (canResume && activity.id === lastActivityId) {
      const resumeRow = document.createElement("div");
      resumeRow.className = "act-resume-row";
      resumeRow.innerHTML = `<button class="resume-btn">Reanudar esta actividad</button>`;
      resumeRow.querySelector("button").addEventListener("click", reopenLastActivity);
      li.appendChild(resumeRow);
    }
    el.activitiesList.appendChild(li);
  });
}

/* ---------- Timeline (Gantt) ---------- */

function niceTickMinutes(totalMs) {
  const totalMin = totalMs / 60000;
  const candidates = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120];
  const target = totalMin / 5; // aim for ~5 ticks across the axis
  return candidates.find((c) => c >= target) || candidates[candidates.length - 1];
}

function renderTimeline() {
  const wrap = document.getElementById("timeline-wrap");
  const axisEl = document.getElementById("timeline-axis");
  const rowsEl = document.getElementById("timeline-rows");
  const tooltipEl = document.getElementById("timeline-tooltip");

  const finished = state.activities.filter((a) => a.status === "finished");
  const show = state.status === "finished" && finished.length > 0 && state.startedAt && state.endedAt;
  wrap.hidden = !show;
  if (!show) return;

  const fullStartMs = Date.parse(state.startedAt);
  const fullEndMs = Date.parse(state.endedAt);
  const fullSpan = Math.max(1, fullEndMs - fullStartMs);
  const pct = (ms) => (ms / fullSpan) * 100;

  function showTooltip(e, text) {
    e.stopPropagation();
    tooltipEl.textContent = text;
    tooltipEl.hidden = false;
  }

  function makeSeg(kind, leftPct, widthPct, tooltipText) {
    const seg = document.createElement("div");
    seg.className = `timeline-seg ${kind}`;
    seg.style.left = `${leftPct}%`;
    seg.style.width = `${Math.max(widthPct, 0.3)}%`;
    seg.addEventListener("click", (e) => showTooltip(e, tooltipText));
    return seg;
  }

  function makeRuckMarker(leftPct, tooltipText) {
    const dot = document.createElement("div");
    dot.className = "timeline-ruck";
    dot.style.left = `${leftPct}%`;
    dot.addEventListener("click", (e) => showTooltip(e, tooltipText));
    return dot;
  }

  axisEl.innerHTML = "";
  const stepMs = niceTickMinutes(fullSpan) * 60000;
  for (let t = 0; t <= fullSpan; t += stepMs) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.style.left = `${pct(t)}%`;
    tick.textContent = fmtClockTime(new Date(fullStartMs + t).toISOString()).slice(0, 5);
    axisEl.appendChild(tick);
  }

  rowsEl.innerHTML = "";
  const sorted = [...finished].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  sorted.forEach((activity) => {
    const stats = activityStats(activity);
    const actStartMs = Date.parse(activity.startedAt);
    const actEndMs = Date.parse(activity.endedAt);

    const row = document.createElement("div");
    row.className = "timeline-row";

    const label = document.createElement("div");
    label.className = "timeline-row-label";
    label.innerHTML = stats.tracked
      ? `<span>${escapeHtml(activity.name)}</span><span class="pct">${stats.pct.toFixed(0)}%</span>`
      : `<span>${escapeHtml(activity.name)}</span><span class="pct" style="color:var(--untracked)">sin medir</span>`;
    row.appendChild(label);

    const track = document.createElement("div");
    track.className = "timeline-track";
    const fill = document.createElement("div");
    fill.className = "timeline-fill";
    track.appendChild(fill);

    if (actStartMs > fullStartMs) {
      fill.appendChild(makeSeg("gap", 0, pct(actStartMs - fullStartMs), "Sin actividad registrada"));
    }

    if (stats.tracked) {
      activity.segments.forEach((seg) => {
        const segStartMs = Date.parse(seg.startedAt);
        const segEndMs = seg.endedAt ? Date.parse(seg.endedAt) : actEndMs;
        const left = pct(segStartMs - fullStartMs);
        const width = pct(Math.max(0, segEndMs - segStartMs));
        const phaseLabel = seg.phase === "BIP"
          ? `BIP · balón en juego (${SOURCE_LABELS[seg.source] || "origen desconocido"})`
          : "BOP · fuera de juego";
        const text = `${phaseLabel} — ${fmtClockTime(seg.startedAt)}–${fmtClockTime(seg.endedAt || activity.endedAt)} (${fmtHMS(segEndMs - segStartMs)})`;
        fill.appendChild(makeSeg(seg.phase.toLowerCase(), left, width, text));
      });
    } else {
      const left = pct(actStartMs - fullStartMs);
      const width = pct(actEndMs - actStartMs);
      const text = `Sin medir BIP — ${fmtClockTime(activity.startedAt)}–${fmtClockTime(activity.endedAt)} (${fmtHMS(actEndMs - actStartMs)})`;
      fill.appendChild(makeSeg("untracked", left, width, text));
    }

    if (actEndMs < fullEndMs) {
      fill.appendChild(makeSeg("gap", pct(actEndMs - fullStartMs), pct(fullEndMs - actEndMs), "Sin actividad registrada"));
    }

    activity.events.forEach((ev) => {
      const left = pct(Date.parse(ev.at) - fullStartMs);
      const label = ev.type === "RUCK" ? "Ruck" : "Patada en juego";
      track.appendChild(makeRuckMarker(left, `${label} — ${fmtClockTime(ev.at)}`));
    });

    row.appendChild(track);
    rowsEl.appendChild(row);
  });

  tooltipEl.hidden = true;
}

document.addEventListener("click", () => {
  const t = document.getElementById("timeline-tooltip");
  if (t) t.hidden = true;
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* Lightweight per-second refresh of live numbers only (no full re-render,
   so typing in the activity-name input or tapping buttons stays snappy). */
function tick() {
  if (state.status === "idle") return;
  const now = Date.now();

  el.sessionElapsed.textContent = fmtHMS(clockElapsedMs(state.clock, now));

  const active = currentActivity();
  if (active) {
    const stats = activityStats(active, now);
    el.activeActivityElapsed.textContent = fmtHMS(stats.totalMs);
    el.bipTime.textContent = fmtMS(stats.bipMs);
    el.bopTime.textContent = fmtMS(stats.bopMs);
    el.bipBarFill.style.width = `${stats.pct.toFixed(1)}%`;
    el.bipPercent.textContent = `${stats.pct.toFixed(0)}%`;
    el.bipRatio.textContent = formatRatio(stats.ratio);
  }
}

setInterval(tick, 500);

/* ---------- Wire up events ---------- */

el.btnStartSession.addEventListener("click", startSession);

el.btnShowImport.addEventListener("click", () => {
  el.importForm.hidden = !el.importForm.hidden;
});

el.importFileInput.addEventListener("change", async () => {
  const file = el.importFileInput.files[0];
  pendingAnglesImport = null;
  el.importAnchorRow.hidden = true;
  if (!file) return;
  el.importStatus.textContent = "Leyendo archivo...";
  try {
    const xmlText = await decodeXmlFile(file);
    const segments = parseAnglesXml(xmlText);
    pendingAnglesImport = segments;
    const totalMin = Math.round((segments[segments.length - 1].endMs - segments[0].startMs) / 60000);
    el.importStatus.textContent = `Encontrados ${segments.length} tramos BIP/OUT (~${totalMin} min). Indicá la hora real de inicio del video.`;
    const now = new Date();
    now.setSeconds(0, 0);
    el.importAnchorTime.value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    el.importAnchorRow.hidden = false;
  } catch (err) {
    el.importStatus.textContent = `Error: ${err.message}`;
  }
});

el.btnConfirmImport.addEventListener("click", () => {
  if (!pendingAnglesImport) return;
  const anchorValue = el.importAnchorTime.value;
  const anchorMs = new Date(anchorValue).getTime();
  if (!anchorValue || !Number.isFinite(anchorMs)) {
    el.importStatus.textContent = "Indicá una hora real válida.";
    return;
  }
  if (state.status !== "idle") {
    const ok = confirm("Esto reemplaza la sesión actual sin exportar. ¿Continuar?");
    if (!ok) return;
  }
  state = buildSessionFromAngles(pendingAnglesImport, anchorMs);
  pendingAnglesImport = null;
  el.importForm.hidden = true;
  el.importFileInput.value = "";
  saveState();
  render();
});
el.btnFinishSession.addEventListener("click", () => {
  if (confirm("¿Finalizar la sesión?")) finishSession();
});
el.btnStartActivity.addEventListener("click", () => {
  startActivity(el.inputActivityName.value);
  el.inputActivityName.value = "";
});
el.inputActivityName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.btnStartActivity.click();
});
el.sourceButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const active = currentActivity();
    if (active) startBip(active.id, btn.dataset.source);
  });
});
el.btnEndBip.addEventListener("click", () => {
  const active = currentActivity();
  if (active) endBip(active.id);
});
el.btnLogRuck.addEventListener("click", () => {
  const active = currentActivity();
  if (active) logEvent(active.id, "RUCK");
});
el.btnLogKick.addEventListener("click", () => {
  const active = currentActivity();
  if (active) logEvent(active.id, "KICK");
});
el.btnFinishActivity.addEventListener("click", () => {
  const active = currentActivity();
  if (active && confirm(`¿Finalizar la actividad "${active.name}"?`)) finishActivity(active.id);
});
el.liveFeedList.addEventListener("click", (e) => {
  const btn = e.target.closest(".feed-delete-btn");
  if (!btn) return;
  const active = currentActivity();
  if (!active) return;
  undoFeedItem(active, btn.dataset.refType, btn.dataset.refId);
});
el.btnUndoLast.addEventListener("click", () => {
  const active = currentActivity();
  if (!active) return;
  const items = buildFeedItems(active);
  if (items[0] && items[0].canUndo) undoFeedItem(active, items[0].refType, items[0].refId);
});
el.btnExportCsv.addEventListener("click", exportCsv);
el.btnExportPdf.addEventListener("click", () => window.print());
el.btnShare.addEventListener("click", shareCsv);
el.btnNewSession.addEventListener("click", newSession);

window.addEventListener("beforeunload", saveState);

/* On a fresh page load (tab was closed, crashed, or reopened later — not a
   re-render within the same load) a "running" session restored from
   localStorage might be minutes or days old. The session view renders
   normally either way (this is just a notice layered on top, not a gate —
   ignoring it and tapping straight into the live controls is equivalent to
   choosing "continue"), but a visible banner means the coach is never
   silently dropped back into old data without knowing it happened. A
   "finished" session doesn't need this — it's already complete and just
   waiting to be exported. */
function maybeOfferSessionRecovery() {
  if (state.status !== "running") return;
  const startedLabel = fmtClockTime(state.startedAt);
  const elapsedLabel = fmtHMS(clockElapsedMs(state.clock));
  const activityNote = currentActivity() ? ` (actividad "${escapeHtml(currentActivity().name)}" en curso)` : "";
  el.recoveryText.innerHTML = `Empezó a las <strong>${startedLabel}</strong> y lleva <strong>${elapsedLabel}</strong>${activityNote}. ¿Querés seguir con ella o descartarla y empezar de cero?`;
  el.recoveryBanner.hidden = false;
}

el.btnRecoveryContinue.addEventListener("click", () => {
  el.recoveryBanner.hidden = true;
});

el.btnRecoveryDiscard.addEventListener("click", () => {
  const ok = confirm("¿Descartar esta sesión sin exportar? No se puede deshacer.");
  if (!ok) return;
  state = freshSession();
  saveState();
  el.recoveryBanner.hidden = true;
  render();
});

render();
maybeOfferSessionRecovery();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
