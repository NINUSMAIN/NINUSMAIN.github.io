// Studium · Handy. Liest den verschlüsselten Stand der Mac-App, entschlüsselt ihn nur auf diesem Gerät und zeigt,
// was ansteht, wann und wo. Eintragen lässt sich, was unterwegs anfällt: eigene Termine, Anwesenheit, Antworten auf
// Rückfragen. Das geht verschlüsselt an den Mac zurück (siehe „Eintragen am Handy“). Keine Dateien.
"use strict";

const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WDL = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MON = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};
const at = (d, t = "00:00") => { const [y, m, dd] = d.split("-").map(Number); const [h, mi] = t.split(":").map(Number); return new Date(y, m - 1, dd, h, mi); };
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monday = (d) => addDays(d, -((d.getDay() + 6) % 7));
const dm = (d) => `${WD[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
const mins = (ms) => Math.round(ms / 6e4);
// Bis zu einem Zeitpunkt aufgerundet: nie „in 0 Min.“, solange es noch nicht so weit ist
const minsUp = (ms) => Math.max(1, Math.ceil(ms / 6e4));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dur = (m) => (m < 60 ? `${m} Min.` : m < 600 ? `${Math.floor(m / 60)} Std.${m % 60 ? ` ${m % 60} Min.` : ""}` : `${Math.round(m / 60)} Std.`);
// In der Android-App: die Brücke zum Handy (Wecker, Tippgefühl, Leistenfarbe)
const N = window.StudiumNative || null;
// Abstände der Systemleisten gleich beim Start, damit nichts springt
try {
  const v = N?.insets?.().split(",").map(Number);
  if (v && v.length === 4) ["--sat", "--sar", "--sab", "--sal"].forEach((k, i) => document.documentElement.style.setProperty(k, `${v[i]}px`));
} catch { /* egal */ }
const vib = () => { try { N ? N.haptic() : navigator.vibrate?.(6); } catch { /* egal */ } };

// ---------- Schlüssel und Daten ----------
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => b64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
// Ein Link mit einem anderen Schlüssel als dem vorhandenen ersetzt die Verbindung nicht still: erst fragen (Sprechblase)
let keyOffer = null;
(function takeKey() {
  const m = location.hash.match(/k=([A-Za-z0-9_-]{40,})/);
  if (!m) return;
  history.replaceState(null, "", location.pathname);
  const old = store.get("k");
  if (!old || old === m[1]) store.set("k", m[1]);
  else keyOffer = m[1];
})();

async function decrypt(enc) {
  const k = store.get("k");
  if (!k) throw new Error("kein Schlüssel");
  const ck = await crypto.subtle.importKey("raw", b64url(k), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, ck, b64(enc.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

// Jeder Abruf hat ein Zeitlimit: bei WLAN ohne Durchsatz hinge sonst alles Weitere an einem Abruf, der nie endet
const net = (url, opt = {}) => fetch(url, { ...opt, signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
/** Netzfehler in Worten, die etwas sagen */
const netErr = (e, what) => navigator.onLine === false ? `Ohne Netz, ${what}` : e?.name === "TimeoutError" || e?.name === "AbortError" || e?.name === "TypeError" ? `Keine Verbindung, ${what}` : e?.name === "SyntaxError" ? `Antwort unlesbar (WLAN-Anmeldung offen?), ${what}` : String(e?.message || e);
let D0 = null; // Stand vom Mac
let D = null; // derselbe Stand, dazu was hier eingetragen und vom Mac noch nicht bestätigt ist
let fetchedAt = Number(store.get("fetchedAt") || 0);
let loadErr = "";
// Mehrere Anlässe (Rückkehr in die App, Takt, Ziehen, Auge) teilen sich einen Ladevorgang
let loading = null;
function load(show) {
  if (!loading) loading = loadOnce().finally(() => (loading = null));
  return loading.then(() => show && render(true));
}
async function loadOnce() {
  if (!store.get("k")) return;
  busy++; eyeAuto();
  try {
    const r = await net(`data.enc?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "Noch keine Daten hochgeladen" : `Laden fehlgeschlagen (${r.status})`);
    const txt = await r.text();
    D0 = await decrypt(JSON.parse(txt));
    store.set("enc", txt);
    settle();
    D = merged();
    try { N?.setKey(store.get("k")); } catch { /* egal */ }
    tellNative(txt);
    flush();
    fetchedAt = Date.now();
    store.set("fetchedAt", String(fetchedAt));
    loadErr = "";
  } catch (e) {
    loadErr = e.message === "kein Schlüssel" ? "" : String(e.message || e).includes("decrypt") || e.name === "OperationError" ? "Schlüssel passt nicht, bitte neu verbinden" : netErr(e, "letzter Stand");
  } finally {
    busy--; eyeAuto();
  }
}
async function fromCache() {
  const enc = store.get("enc");
  if (!enc) return;
  try { D0 = await decrypt(JSON.parse(enc)); D = merged(); } catch { /* bleibt leer */ }
}

// ---------- Eintragen am Handy ----------
// Was hier eingetragen wird, gilt sofort (auch ohne Netz) und geht verschlüsselt an den Mac: derselbe Schlüssel wie beim
// Lesen, abgelegt in einem öffentlichen Zwischenspeicher, dessen Fach sich aus dem Schlüssel ergibt. Der Mac prüft jeden
// Eintrag und bestätigt ihn im nächsten Stand ("ack"). Bis dahin liegt er im Postausgang und wird über den Stand gelegt.
const RELAY = "https://ntfy.sh";
let out = (() => { try { return JSON.parse(store.get("out") || "[]"); } catch { return []; } })();
let rejected = (() => { try { return JSON.parse(store.get("rej") || "[]"); } catch { return []; } })(); // vom Mac abgelehnt: das Auge sagt es, bis man es wegtippt
const saveRej = () => store.set("rej", JSON.stringify(rejected.slice(-10)));
let sendErr = "";
let syncedAt = 0; // wann der Mac zuletzt etwas von hier bestätigt hat
const saveOut = () => store.set("out", JSON.stringify(out));
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const toB64 = (u8) => { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
async function seal(obj) {
  const ck = await crypto.subtle.importKey("raw", b64url(store.get("k")), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, new TextEncoder().encode(JSON.stringify(obj))));
  return JSON.stringify({ v: 1, iv: toB64(iv), ct: toB64(ct) });
}
async function topic() {
  const k = b64url(store.get("k")), pre = new TextEncoder().encode("studium/inbox/v1|");
  const buf = new Uint8Array(pre.length + k.length);
  buf.set(pre); buf.set(k, pre.length);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return "stu-" + Array.from(h.slice(0, 20), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Kurz in Worten, was ein Eintrag im Postausgang ist (beim Eintragen bestimmt, solange es den Eintrag noch gibt) */
function describe(o) {
  if (o.what) return o.what;
  const op = o.ops[0] || {};
  const ev = (id) => (D || D0)?.evs?.find((e) => e.id === id);
  const tk = (id) => (D || D0)?.tasks?.find((t) => t.id === id)?.t;
  if (op.op === "event") return `Termin „${op.event.kind}“`;
  if (op.op === "eventRemove") return ev(op.id) ? `Termin löschen: ${ev(op.id).k}` : "Termin löschen";
  if (op.op === "attendance" || op.op === "cancel") { const e = ev(op.id); return e ? `Anwesenheit ${evName(e)} ${dm(at(e.d))}` : "Anwesenheit"; }
  if (op.op === "task") return `Aufgabe „${op.task.title}“`;
  if (op.op === "taskDone") return tk(op.id) ? `Erledigt: ${tk(op.id)}` : "Aufgabe abhaken";
  if (op.op === "step" || op.op === "stepAdd") return tk(op.id) ? `Schritt bei ${tk(op.id)}` : "Schritt";
  if (op.op === "taskRemove") return tk(op.id) ? `Aufgabe löschen: ${tk(op.id)}` : "Aufgabe löschen";
  if (op.op === "changesSeen") return "Hinweise gesehen";
  return "Antwort auf eine Rückfrage";
}
/** Bestätigtes aus dem Postausgang nehmen; Abgelehntes merken, damit das Auge es sagen kann */
function settle() {
  if (!D0 || !out.length) return;
  const ack = new Set(D0.ack || []), nak = new Map((D0.nak || []).map((n) => [n.id, n.why]));
  const n = out.length;
  for (const o of out) if (nak.has(o.id)) rejected.push({ id: o.id, why: nak.get(o.id), what: describe(o), ops: o.ops });
  const arrived = out.some((o) => ack.has(o.id));
  out = out.filter((o) => !ack.has(o.id) && !nak.has(o.id));
  if (out.length !== n) { saveOut(); saveRej(); }
  if (arrived) syncedAt = Date.now();
}
/** Stand vom Mac, darüber der Postausgang */
function merged() {
  if (!D0) return null;
  if (!out.length) return D0;
  const d = { ...D0, evs: D0.evs.map((e) => ({ ...e })), qs: (D0.qs || []).map((q) => ({ ...q })), tasks: D0.tasks.map((x) => ({ ...x, sp: x.sp ? x.sp.map((s) => [...s]) : x.sp })) };
  const task = (id) => d.tasks.find((y) => y.id === id);
  const recount = (x) => { x.st = [x.sp.filter((s) => s[1]).length, x.sp.length]; };
  for (const o of out) for (const op of o.ops) {
    if (op.op === "event") {
      const x = op.event, old = d.evs.findIndex((y) => y.id === x.id);
      const e = { id: x.id, m: x.m, k: x.kind, d: x.date, s: x.start, e: x.end, r: x.room || "", n: x.note || null, t: null, x: false, o: false, u: false, p: false, ex: false, a: null, w: true, pend: true };
      if (old >= 0) d.evs[old] = e; else d.evs.push(e);
    } else if (op.op === "eventRemove") d.evs = d.evs.filter((y) => y.id !== op.id);
    else if (op.op === "attendance") {
      const e = d.evs.find((y) => y.id === op.id); if (e) e.a = op.value;
      // Die Nachholen-Aufgabe zum Termin zieht mit (wie im Kern): nachgeholt oder da heißt erledigt, verpasst offen
      const done = op.value === "nachgeholt" || op.value === "da" ? true : op.value === "weg" ? false : null;
      if (done !== null) for (const x of d.tasks) if (x.k === "nachholen" && x.ev === op.id) x.done = done;
    }
    else if (op.op === "cancel") { const e = d.evs.find((y) => y.id === op.id); if (e) { e.x = op.cancelled !== false; e.a = null; } }
    else if (op.op === "question") { const q = d.qs.find((y) => y.id === op.question.id); if (q) Object.assign(q, op.question); else d.qs.push({ ...op.question }); }
    else if (op.op === "taskDone") { const x = task(op.id); if (x) x.done = op.done !== false; }
    else if (op.op === "step") { const x = task(op.id), s = x?.sp?.[op.i]?.[0] === op.text ? x.sp[op.i] : x?.sp?.find((y) => y[0] === op.text); if (s) { s[1] = op.done !== false; recount(x); if (s[1]) x.sta = true; } }
    else if (op.op === "stepAdd") { const x = task(op.id); if (x) { x.sp = [...(x.sp || []), [op.text, false]]; recount(x); } }
    else if (op.op === "task") {
      const x = op.task, old = d.tasks.findIndex((y) => y.id === x.id);
      const n = { id: x.id, m: x.m, k: x.date ? "frist" : "offen", t: x.title, d: x.date || null, ti: x.date && x.time ? x.time : null, ex: false, done: false, ev: null, st: null, det: x.detail || "", up: false, ra: null, sta: false, sp: null, w: true, pend: true };
      // Ändern behält, was schon ist: erledigt, Schritte, Fortschritt, Verknüpfung
      if (old >= 0) { const o = d.tasks[old]; d.tasks[old] = { ...o, ...n, done: o.done, sp: o.sp, st: o.st, ev: o.ev, sta: o.sta, det: x.detail ?? o.det }; } else d.tasks.push(n);
    } else if (op.op === "taskRemove") d.tasks = d.tasks.filter((y) => y.id !== op.id);
  }
  return d;
}
/** Etwas eintragen: gilt sofort, geht dann an den Mac */
function post(ops) {
  const o = { id: `h-${uid()}`, at: new Date().toISOString(), ops, sent: 0 };
  o.what = describe(o);
  out.push(o);
  saveOut();
  D = merged();
  tellNative();
  flush();
}
let flushing = false;
async function flush() {
  if (flushing || !out.length || !store.get("k")) return;
  flushing = true; busy++; eyeAuto();
  try {
    const t = await topic();
    for (const o of out) {
      // Noch nie geschickt, oder vor mehr als drei Stunden (der Zwischenspeicher hält rund zwölf; doppelt Ankommendes
      // erkennt der Mac an der Kennung). "at" ist der Zeitpunkt des Sendens: der Mac nimmt nur frische Sendungen an.
      // "made" ist, wann Julius es eingetragen hat: so überschreibt eine spät ankommende ältere Änderung nichts Neueres.
      if (o.sent && Date.now() - o.sent < 3 * 36e5) continue;
      const r = await net(`${RELAY}/${t}`, { method: "POST", body: await seal({ id: o.id, at: new Date().toISOString(), made: o.at, ops: o.ops }), headers: { Firebase: "no" } });
      if (!r.ok) throw new Error(`Senden fehlgeschlagen (${r.status})`);
      o.sent = Date.now();
      saveOut();
    }
    sendErr = "";
  } catch (e) {
    sendErr = netErr(e, "geht raus, sobald es wieder klappt");
  } finally {
    flushing = false; busy--; eyeAuto();
    paintEye();
  }
}
window.addEventListener("online", () => flush());
/** Android (Widget, Wecker): der Stand vom Mac und dazu, was hier noch wartet */
async function tellNative(txt) {
  if (!N) return;
  try {
    if (N.pending) {
      if (txt) N.dataUpdated(txt);
      N.pending(out.length ? await seal({ out: out.map((o) => ({ id: o.id, ops: o.ops })) }) : "");
    } else {
      // Ältere App ohne eigenen Postausgang: ihr den gemischten Stand geben
      const enc = txt || store.get("enc");
      if (enc) N.dataUpdated(out.length && D ? await seal(D) : enc);
    }
  } catch { /* egal */ }
}

// ---------- Ableitungen ----------
const mod = (id) => D.mods.find((m) => m.id === id);
const mName = (id) => (id === "EX" ? "Prüfung" : mod(id)?.short || mod(id)?.name || id);
const mTag = (id) => { const m = mod(id); return m?.short && m.short.length <= 10 ? m.short : id; };
// Unbekanntes Fach (neues Semester): der Neutralton wie am Mac und im Widget, nicht die Farbe der Karte daneben
const KNOWN_MODS = new Set(["st", "bi", "db", "gpm", "sm", "tm", "ex"]);
const cls = (id) => (KNOWN_MODS.has(String(id).toLowerCase()) ? `m-${String(id).toLowerCase()}` : "m-");
const evs = () => D.evs.map((e) => ({ ...e, S: at(e.d, e.s), E: at(e.d, e.e) })).sort((a, b) => a.S - b.S);
// Wie eventTasks am Mac: keine Prüfungsaufgaben, und eine Frist hängt sich nur an eine Lehrveranstaltung, nicht an einen eigenen Termin
const evTasks = (e) => D.tasks.filter((t) => t.k !== "nachholen" && !t.ex && (t.ev === e.id || (!e.w && t.k === "frist" && t.m === e.m && t.d === e.d && t.ti === e.s)));
const going = (e) => !e.x && e.a !== "weg";
// Termine, zu denen man Anwesenheit einträgt (keine Prüfungen, nichts Vermutetes oder Ausgefallenes, keine eigenen)
const attendable = (e) => e.m !== "EX" && !e.ex && !e.u && !e.x && !e.w;
const evName = (e) => (e.m === "EX" ? e.t || e.k : e.m ? `${mName(e.m)} ${e.k}` : e.k);
// Große Zeile eines Termins: das Fach. Ein eigener Termin ohne Fach heißt, wie er heißt, und hat keine zweite Angabe.
const evTitle = (e, long) => (e.m === "EX" ? e.t || e.k : !e.m ? e.k : (long && mod(e.m)?.name) || mName(e.m));
const evKind = (e) => (e.m === "EX" ? "Prüfung" : e.m ? e.k : "");

// ---------- Was das Auge weiß: Rückfragen, Hinweise, Schnellantworten (dieselben Regeln wie am Mac) ----------
const closed = (q) => q && (q.status === "beantwortet" || q.status === "unwichtig");
function questions(now) {
  const qs = D.qs || [], stored = new Map(qs.map((q) => [q.id, q]));
  // Wie am Mac: eine Frage zu einer erledigten Aufgabe hat sich erledigt (Termine reichen im Stand nicht weit genug zurück, um es dort zu prüfen)
  const fromMac = qs.filter((q) => q.q && !String(q.id).startsWith("anw-") && !closed(q) && !(q.task && !D.tasks.some((t) => t.id === q.task && !t.done)));
  const att = evs().filter((e) => attendable(e) && !e.o && !e.a && e.E < now && now - e.E < 21 * 864e5).map((e) => {
    const s = stored.get(`anw-${e.id}`);
    return { id: `anw-${e.id}`, q: `Warst du in ${evName(e)}, ${dm(e.S)} um ${e.s}?`, opts: ["War da", "Nicht da", "Fiel aus"], m: e.m, ev: e.id, local: true, status: s?.status, snooze: s?.snooze };
  }).filter((q) => !closed(q));
  return [...fromMac, ...att];
}
const askable = (q, now) => !q.snooze || new Date(q.snooze) <= now;
// Später: in vier Stunden wieder, frühestens um 8 Uhr
const later = (now) => { const t = new Date(now.getTime() + 4 * 36e5); if (t.getHours() < 8) t.setHours(8, 0, 0, 0); return t.toISOString(); };
function answer(q, a) {
  if (q.local && q.ev) {
    if (a === "War da") return post([{ op: "attendance", id: q.ev, value: "da" }]);
    if (a === "Nicht da") return post([{ op: "attendance", id: q.ev, value: "weg" }]);
    if (a === "Fiel aus") return post([{ op: "cancel", id: q.ev, cancelled: true }]);
  }
  post([{ op: "question", question: { id: q.id, status: "beantwortet", answer: a } }]);
}
/** Zeitpunkt eines Hinweises des Abgleichs (ältere ohne eigenen: der Abgleich selbst) */
const chAt = (c) => new Date(c.at || D.run || 0).getTime();
/**
 * Hinweise des Abgleichs, die noch nicht gesehen sind: dieselbe Regel wie am Mac (freshChanges in derive.ts). „Gesehen“
 * gilt geteilt (cs vom Mac, hier sofort gemerkt und an den Mac geschickt), vorbei ist vorbei, ein Ausfall nur, solange er gilt.
 */
function freshCh(now) {
  const seen = Math.max(D.cs ? new Date(D.cs).getTime() : 0, Number(store.get("seenCh") || 0));
  return (D.ch || []).filter((c) => {
    if (chAt(c) <= seen) return false;
    const e = c.ev ? D.evs.find((y) => y.id === c.ev) : null;
    if (c.until ? new Date(c.until) <= now : e ? at(e.d, e.e) <= now : false) return false;
    return !(c.kind === "ausfall" && e && !e.x);
  });
}
/** Als gesehen merken, hier sofort und am Mac (für dessen Karte „Hinweise“) */
function markSeen(ts) {
  if (Number(store.get("seenCh") || 0) >= Number(ts)) return;
  store.set("seenCh", String(ts));
  post([{ op: "changesSeen", at: new Date(Number(ts)).toISOString() }]);
}
/** Was das Auge von selbst meldet: Abgelehntes, Änderungen aus Moodle, Erinnerungen, nicht Angefangenes, gleich beginnende Termine */
function nudges(now) {
  const list = [], H = 36e5;
  for (const n of rejected) {
    // Ein abgelehnter Termin lässt sich gleich korrigieren und neu eintragen
    const redo = n.ops?.[0]?.op === "event";
    list.push({ key: `nak@${n.id}`, short: `Der Mac hat ${n.what} nicht übernommen`, full: `${n.why}. ${redo ? "Antippen öffnet ihn zum Ändern." : "Antippen blendet den Hinweis aus."}`, tone: "alert", ...(redo ? { redo: n.id } : { drop: n.id }) });
  }
  // Wartet etwas seit Stunden auf den Mac, einmal deutlich sagen (sonst steht es nur still im Auge)
  const oldest = out.reduce((a, o) => (!a || o.at < a ? o.at : a), "");
  if (oldest && Date.now() - new Date(oldest).getTime() > 6 * H)
    list.push({ key: `wait@${oldest}`, short: `${plural(out.length, "Eintrag wartet", "Einträge warten")} seit ${since(new Date(oldest))} auf den Mac`, full: "Studium am Mac öffnen, dann kommt alles an.", tone: "alert", seen: null });
  const ch = freshCh(now);
  if (ch.length) {
    const last = ch.reduce((a, c) => Math.max(a, chAt(c)), 0);
    list.push({ key: `ch@${last}`, short: ch.length === 1 ? ch[0].text : `${ch.length} Änderungen aus Moodle`, full: ch.length === 1 ? "" : ch.map((c) => c.text).join("\n"), tone: "alert", open: ch.length === 1 && ch[0].ev ? `ev:${ch[0].ev}` : ch.length === 1 && ch[0].task ? `task:${ch[0].task}` : null, seen: String(last) });
  }
  for (const t of D.tasks.filter((x) => !x.done)) {
    if (t.ra) {
      const r = new Date(t.ra.length === 16 ? t.ra + ":00" : t.ra), late = now - r;
      if (late >= 0 && late < 12 * H) list.push({ key: `remind@${t.id}@${t.ra}`, short: t.t.replace(/^Erinnerung:\s*/, ""), full: `Erinnerung, ${hhmm(r)} · ${mName(t.m)}`, tone: "alert", open: `task:${t.id}` });
    }
    if (t.k !== "frist" || !t.d || t.ex || t.m === "EX") continue;
    const due = at(t.d, t.ti || "23:59"), left = due - now;
    if (left > 0 && left <= 36 * H && !t.sta && !/^(erinnerung|pflichttermin)/i.test(t.t) && !/anmeld/i.test(t.t))
      list.push({ key: `start@${t.id}@${t.d}T${t.ti || ""}`, short: `Noch nicht angefangen: ${t.t}`, full: `${mName(t.m)} · Frist ${dm(due)} ${t.ti && t.ti !== "23:59" ? t.ti : ""}. Ausarbeiten geht am Mac.`, tone: "alert", open: `task:${t.id}` });
  }
  for (const e of evs()) {
    const until = e.S - now;
    if (!going(e) || (e.o && e.a !== "da") || until < 0 || until > 30 * 6e4) continue;
    const ts = e.m === "EX" ? [] : evTasks(e), open = ts.filter((t) => !t.done);
    list.push({ key: `soon@${e.id}`, short: `In ${minsUp(until)} Min.: ${evName(e)}${e.r ? `, ${e.r}` : ""}`, full: open.length ? `Offen dazu: ${open.map((t) => t.t).join(", ")}` : ts.length ? "Deine Lösung liegt bereit." : "", tone: "info", open: `ev:${e.id}` });
  }
  return list;
}
/** Schnellantworten direkt aus den Daten */
const QUICK = [["heute", "Heute"], ["nachholen", "Nachholen"], ["woche", "Diese Woche"], ["pruefungen", "Prüfungen"]];
function quick(q, now) {
  const all = evs(), dls = deadlines();
  const due = (t) => { const c = countdown(t.at, now); return { c: cls(t.m), title: t.t, sub: `${mName(t.m)} · ${dm(t.at)} ${t.ti && t.ti !== "23:59" ? t.ti : ""}`, chip: c.txt, tone: c.cls, open: `task:${t.id}` }; };
  if (q === "heute") {
    const today = all.filter((e) => key(e.S) === key(now) && e.E > now && !e.x);
    // Heute noch: heute fällig und Überfälliges (wie am Mac)
    const soon = dls.filter((t) => key(t.at) <= key(now));
    const att = questions(now).filter((x) => x.local && askable(x, now));
    const rows = [...today.map((e) => ({ c: cls(e.m), title: evName(e), sub: `${e.s} bis ${e.e}${e.r ? ` · ${e.r}` : ""}`, chip: e.S <= now ? "läuft" : `in ${dur(minsUp(e.S - now))}`, open: `ev:${e.id}` })), ...soon.map(due)];
    // Antippen öffnet den ersten offenen Termin, dort steht „War da / Nicht da“
    if (att.length) rows.push({ c: cls(att[0].m), title: `Anwesenheit eintragen (${att.length})`, sub: att[0].q, open: att[0].ev ? `ev:${att[0].ev}` : null });
    return { head: rows.length ? "Heute noch" : "Heute ist nichts mehr dran.", rows };
  }
  if (q === "nachholen") {
    const linked = new Set(D.tasks.filter((t) => t.ev).map((t) => t.ev));
    const rows = [
      ...D.tasks.filter((t) => t.k === "nachholen" && !t.done).map((t) => ({ c: cls(t.m), title: t.t, sub: mName(t.m), open: `task:${t.id}` })),
      ...all.filter((e) => e.a === "weg" && !e.o && !e.x && !linked.has(e.id)).map((e) => ({ c: cls(e.m), title: `${e.k} vom ${dm(e.S)} nachholen`, sub: mName(e.m), open: `ev:${e.id}` })),
    ];
    return { head: rows.length ? `${plural(rows.length, "Sache", "Sachen")} zum Nachholen` : "Nichts nachzuholen.", rows: rows.slice(0, 8) };
  }
  if (q === "woche") {
    const end = addDays(monday(now), 7);
    const rows = [...dls.filter((t) => t.at < end).map(due), ...all.filter((e) => (e.p || e.ex) && e.S > now && e.S < end).map((e) => ({ c: cls(e.m), title: evName(e), sub: `${dm(e.S)} ${e.s}${e.r ? ` · ${e.r}` : ""}`, chip: e.ex ? "Prüfung" : "Pflicht", tone: "hot", open: `ev:${e.id}` }))];
    return { head: rows.length ? "Diese Woche fällig" : "Diese Woche ist nichts fällig.", rows };
  }
  const ex = exams();
  return { head: ex.length ? `${plural(ex.length, "Prüfung steht", "Prüfungen stehen")} an` : "Keine Prüfungen mehr.", rows: ex.map((t) => ({ ...due(t), title: t.m === "EX" ? t.t : mName(t.m) })) };
}
// Überfällige bleiben stehen, bis sie abgehakt sind (dieselbe Regel wie am Mac)
const deadlines = () => D.tasks.filter((t) => t.k === "frist" && !t.done && t.d && !t.ex && t.m !== "EX").map((t) => ({ ...t, at: at(t.d, t.ti || "23:59") })).sort((a, b) => a.at - b.at);
// Prüfung ohne Uhrzeit zählt bis zum Ende des Tages, wie am Mac (23:59)
const exams = () => D.tasks.filter((t) => (t.ex || t.m === "EX") && !t.done && t.d).map((t) => ({ ...t, at: at(t.d, t.ti || "23:59") })).filter((t) => t.at > Date.now()).sort((a, b) => a.at - b.at);
/** Dieselben Wörter und Schwellen wie am Mac (time.ts until und urgency): rot unter 48 Std., orange unter 7 Tagen */
function countdown(d, now) {
  const ms = d - now, h = ms / 36e5;
  if (ms < 0) return { txt: "überfällig", cls: "hot" };
  const cls = h < 48 ? "hot" : h < 24 * 7 ? "soon" : "";
  const min = Math.round(ms / 6e4);
  if (min < 60) return { txt: `in ${Math.max(1, min)} Min.`, cls };
  const days = Math.round((at(key(d)) - at(key(now))) / 864e5);
  if (days === 0) return { txt: min < 360 ? `in ${Math.round(min / 60)} Std.` : `heute ${hhmm(d)}`, cls };
  if (days === 1) return { txt: `morgen ${hhmm(d)}`, cls };
  return { txt: `in ${days} T.`, cls };
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const ring = (a, n) => { const r = 10, c = 2 * Math.PI * r; return `<svg class="ring" viewBox="0 0 26 26"><circle class="bg" cx="13" cy="13" r="${r}"/><circle class="fg" cx="13" cy="13" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - (n ? a / n : 0))}"/></svg>`; };

// ---------- Bausteine ----------
function tags(e) {
  const t = [];
  if (e.x) t.push(`<span class="tag red">Fällt aus</span>`);
  // Vorher ein Vorhaben, danach verpasst (dieselben Wörter wie die Knöpfe)
  else if (e.a === "weg") t.push(`<span class="tag">${e.E && e.E < new Date() ? "Nicht da" : "Nicht hin"}</span>`);
  if (e.p) t.push(`<span class="tag red">Pflicht</span>`);
  if (e.ex && e.m !== "EX") t.push(`<span class="tag red">Prüfung</span>`);
  if (e.o) t.push(`<span class="tag">freiwillig</span>`);
  if (e.u) t.push(`<span class="tag">unklar</span>`);
  if (e.w) t.push(`<span class="tag ${e.pend ? "wait" : ""}">${e.pend ? "wartet auf den Mac" : "eigen"}</span>`);
  return t.join("");
}
function taskLines(e) {
  return evTasks(e).map((t) => (t.done ? `<div class="task ok">✓ ${esc(t.t)} · bereit</div>` : `<div class="task due">● ${esc(t.t)} · offen</div>`)).join("");
}
function evRow(e, now, i) {
  const past = e.E < now, live = e.S <= now && now < e.E && going(e);
  const title = evTitle(e), kind = evKind(e);
  return `<div class="card ev ${cls(e.m)} ${past ? "past" : ""} ${live ? "now" : ""} ${!going(e) ? "off" : ""} rise" style="--i:${i}" data-open="ev:${esc(e.id)}">
    <div class="t num"><b>${esc(e.s)}</b><span>${esc(e.e)}</span></div><div class="rail"></div>
    <div class="body"><div class="nm"><b>${esc(title)}</b>${kind ? `<span>${esc(kind)}</span>` : ""}${tags(e)}</div>
    ${e.r || !e.w ? `<div class="rm">${esc(e.r || "Raum offen")}</div>` : ""}${e.t && e.m !== "EX" ? `<div class="tp">${esc(e.t)}</div>` : ""}
    ${e.n ? `<div class="note ${e.w ? "plain" : ""}">${esc(e.n)}</div>` : ""}${e.m === "EX" ? "" : taskLines(e)}</div></div>`;
}
function hero(all, now) {
  const real = (e) => going(e) && (!e.o || e.a === "da");
  const cur = all.find((e) => real(e) && e.S <= now && now < e.E) || all.find((e) => going(e) && e.S <= now && now < e.E);
  const next = all.find((e) => real(e) && e.S > now);
  const e = cur || next;
  if (!e) return `<div class="card hero rise">${alarmPill(now)}<div class="lbl">Frei</div><div class="room">Nichts mehr geplant</div><div class="what"><span>Genieß es.</span></div></div>`;
  document.documentElement.style.setProperty("--c", e.m && KNOWN_MODS.has(String(e.m).toLowerCase()) ? `var(--${String(e.m).toLowerCase()})` : "var(--nomod)");
  // Ohne Fach und ohne Ort steht der Name schon groß oben, darunter dann nur, was es ist
  const title = !e.m && !e.r ? "Eigener Termin" : evTitle(e);
  const kind = evKind(e);
  let lbl, when, pct = 0;
  if (cur) {
    const left = minsUp(e.E - now);
    pct = Math.min(100, ((now - e.S) / (e.E - e.S)) * 100);
    lbl = `<i class="live"></i>Läuft`;
    when = `<span>${esc(e.s)} bis ${esc(e.e)}</span><strong class="num">noch ${dur(left)}</strong>`;
  } else {
    const inM = minsUp(e.S - now);
    const today = key(e.S) === key(now);
    lbl = today ? "Als Nächstes" : key(e.S) === key(addDays(now, 1)) ? "Morgen zuerst" : `${WDL[e.S.getDay()]} zuerst`;
    when = `<span>${today ? "" : dm(e.S) + " · "}${esc(e.s)} bis ${esc(e.e)}</span><strong class="num">${inM < 600 ? `in ${dur(inM)}` : esc(e.s)}</strong>`;
    // Bis zum Beginn: Balken füllt sich in der letzten Stunde
    pct = today && inM <= 60 ? 100 - (inM / 60) * 100 : 0;
  }
  const pill = alarmPill(now);
  return `<div class="card hero ${cls(e.m)} ${pill ? "has-pill" : ""} rise" data-open="ev:${esc(e.id)}">${pill}<div class="lbl">${lbl}</div>
    <div class="room">${esc(e.r || (e.w ? e.k : "Raum offen"))}</div>
    <div class="what"><b>${esc(title)}</b> <span>${e.w && !e.r ? "" : esc(kind)}${e.t && e.m !== "EX" ? ` · ${esc(e.t)}` : ""}</span></div>
    <div class="when">${when}</div><div class="bar"><i style="width:${pct}%"></i></div>
    ${e.n ? `<div class="note">${esc(e.n)}</div>` : ""}${e.m === "EX" ? "" : taskLines(e)}</div>`;
}
function dlCard(t, now, i) {
  const c = countdown(t.at, now);
  const st = t.st && t.st[1] ? `<span class="prog">${ring(t.st[0], t.st[1])}<span class="num">${t.st[0]}/${t.st[1]}</span></span>` : `<span>${t.up ? "Abgabe" : ""}</span>`;
  return `<div class="card dlc ${cls(t.m)} rise" style="--i:${i}" data-open="task:${esc(t.id)}"><div class="top"><span class="tag c">${esc(mTag(t.m))}</span><span class="cd ${c.cls} num">${c.txt}</span></div>
    <div class="tt">${esc(t.t)}</div><div class="ft">${st}<span class="num">${dm(t.at)} ${t.ti && t.ti !== "23:59" ? esc(t.ti) : ""}</span></div></div>`;
}

// ---------- Wecker ----------
// Einmal eingestellt: wie lange vom Aufstehen bis zum Losgehen und Ankommen. Wecker nur, wenn der erste Termin vor 13 Uhr liegt.
// Eine Quelle: in der Android-Hülle gilt die Vorlaufzeit der Hülle (sie stellt den Wecker), sonst die gemerkte
const lead = () => { const n = nat(); return Number((n && n.lead) || store.get("lead") || 90); };
let alarmHint = "";
// Android: der Uni-Wecker in der Uhr-App (Samsung, Google), von Studium still angelegt und nachgezogen
const nat = () => { try { return N?.alarmState ? JSON.parse(N.alarmState()) : null; } catch { return null; } };
const setLead = (v) => { store.set("lead", String(v)); const st = nat(); try { st && N.alarmConfig(!!st.on, v); } catch { /* egal */ } setTimeout(() => render(false), 1200); };
const autoSwitch = (on) => `<button class="sw ${on ? "on" : ""}" data-auto="1" role="switch" aria-checked="${on}" aria-label="Wecker automatisch übernehmen"><i></i></button>`;
function wakePlan(now) {
  // Der nächste Morgen, für den noch ein Wecker Sinn ergibt: heute, solange die Weckzeit noch kommt, sonst morgen
  const all = evs();
  const plan = (day) => {
    const first = all.find((e) => key(e.S) === key(day) && going(e) && (!e.o || e.a === "da"));
    if (!first) return { day, first: null };
    const wake = new Date(first.S.getTime() - lead() * 6e4);
    return { day, first, wake, needed: first.S.getHours() < CUTOFF && wake > now };
  };
  const today = plan(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  return today.first && today.needed ? today : plan(addDays(now, 1));
}
const ALARM_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3 2 6M22 6l-3-3"/></svg>`;
const CUTOFF = 13; // Wecker nur, wenn der erste Termin vor 13 Uhr beginnt (auch 12:15); später ist er ohnehin wach
const alarmPos = () => "unten"; // Julius: unter der Karte sieht besser aus
let sheet = null; // "alarm", "ev:<id>" oder "task:<id>"
function alarmInfo(now) {
  const p = wakePlan(now);
  if (!p.first || !p.needed) return null;
  const title = evTitle(p.first);
  return { ...p, title, dayLbl: key(p.day) === key(now) ? "heute" : "morgen", set: store.get("alarm") === `${key(p.day)} ${hhmm(p.wake)}` };
}
// Variante oben: kleine Pille in der freien Ecke der „Als Nächstes“-Karte
function alarmPill(now) {
  const a = alarmInfo(now);
  if (!a || alarmPos() !== "oben") return "";
  return `<button class="apill ${a.set ? "done" : ""}" data-open="alarm" aria-label="Wecker"><span class="ai">${ALARM_ICON}</span><span class="at"><b class="num">${hhmm(a.wake)}</b><span>${a.set ? "gestellt" : a.dayLbl}</span></span></button>`;
}
// Variante unten: schmale Zeile unter der Karte
function alarmRow(now) {
  const a = alarmInfo(now);
  if (!a || alarmPos() !== "unten") return "";
  const tagT = esc(a.first.m === "EX" ? a.title : mTag(a.first.m));
  const st = nat();
  if (st) {
    const live = st.on && Math.abs(st.sentAt - a.wake.getTime()) < 90_000;
    return `<div class="card arow ${cls(a.first.m)} ${st.on ? "auto" : ""} rise" style="--i:1" data-open="alarm"><span class="ai">${ALARM_ICON}</span>
      <div class="ab"><b>Wecker ${a.dayLbl} <span class="num">${hhmm(a.wake)}</span></b><span>${tagT} ${esc(a.first.s)} · ${st.on ? (live ? "in deiner Uhr-App" : a.wake - Date.now() > 864e5 ? "kommt am Vortag in die Uhr-App" : "wird übernommen") : `${dur(lead())} vorher`}</span></div>
      ${autoSwitch(st.on)}</div>`;
  }
  return `<div class="card arow ${cls(a.first.m)} rise" style="--i:1" data-open="alarm"><span class="ai">${ALARM_ICON}</span>
    <div class="ab"><b>Wecker ${a.dayLbl} <span class="num">${hhmm(a.wake)}</span></b><span>${tagT} ${esc(a.first.s)} · ${dur(lead())} vorher</span></div>
    <button class="abtn sm ${a.set ? "done" : ""}" data-alarm="${hhmm(a.wake)}" data-msg="${esc(`${a.title} ${a.first.s} · ${a.first.r || ""}`)}">${a.set ? "✓" : "Stellen"}</button></div>`;
}
// Blatt: Wecker (Vorlauf ändern, übernehmen)
function alarmSheet(now) {
  const a = alarmInfo(now);
  const st = nat();
  if (st) return nativeAlarmSheet(now, a, st);
  return `${a ? `<div class="sh-top"><span class="ai big">${ALARM_ICON}</span><div><span class="sh-l">Wecker für ${a.dayLbl}</span><b class="num sh-t">${hhmm(a.wake)}</b></div></div>
      <div class="sh-m">${esc(a.title)} ${esc(a.first.s)} · ${esc(a.first.r || "Raum offen")}</div>` : `<div class="sh-top"><span class="ai big">${ALARM_ICON}</span><div><b class="sh-t2">Kein Wecker nötig</b></div></div>`}
    ${leadRow()}
    ${a ? `<button class="abtn wide ${a.set ? "done" : ""}" data-alarm="${hhmm(a.wake)}" data-msg="${esc(`${a.title} ${a.first.s} · ${a.first.r || ""}`)}">${a.set ? "Gestellt ✓ · nochmal übernehmen" : "In den Wecker übernehmen"}</button>` : ""}
    ${alarmHint ? `<div class="ahint">${esc(alarmHint)}</div>` : ""}
    <p class="sh-f">Erscheint nur, wenn dein erster Termin vor ${CUTOFF} Uhr beginnt. Die Uhr-App öffnet sich mit fertigem Wecker, du bestätigst dort.</p>`;
}
// Android: eigener Wecker. Ein Schalter, die App stellt und verschiebt den Wecker selbst.
function nativeAlarmSheet(now, a, st) {
  const sent = st.on && st.sentAt > Date.now() ? new Date(st.sentAt) : null;
  const status = !st.on ? "Aus" : sent ? `In deiner Uhr-App: ${key(sent) === key(now) ? "heute" : dm(sent)} ${hhmm(sent)}` : a ? (a.wake - now > 864e5 ? "Kommt 24 Std. vorher in die Uhr-App" : "Wird gleich übernommen") : "Gerade kein Wecker nötig";
  return `<div class="sh-top"><span class="ai big">${ALARM_ICON}</span><div><span class="sh-l">${a ? `Wecker für ${a.dayLbl}` : "Wecker"}</span><b class="num sh-t">${a ? hhmm(a.wake) : "–"}</b></div></div>
    <div class="sh-m">${a ? `${esc(a.title)} ${esc(a.first.s)} · ${esc(a.first.r || "Raum offen")}` : "Gerade kein Uni-Morgen vor 13 Uhr"}</div>
    <div class="sw-line"><div><b>In die Uhr-App übernehmen</b><span>${esc(status)}</span></div>${autoSwitch(st.on)}</div>
    ${leadRow()}
    ${st.on && !st.background ? `<div class="warn"><span>Auch bei geschlossener App nachziehen: einmal „Über anderen Apps einblenden“ erlauben. Sonst kommt bei Änderungen eine Mitteilung zum Übernehmen.</span><button data-settings="overlay">Erlauben</button></div>` : ""}
    ${st.on && !st.notif && !st.background ? `<div class="warn"><span>Mitteilungen sind aus, Änderungen bei geschlossener App gehen so unter.</span><button data-settings="notif">Erlauben</button></div>` : ""}
    ${!st.clock ? `<div class="warn"><span>Keine Uhr-App gefunden, die Wecker annimmt.</span></div>` : ""}
    <p class="sh-f">Studium legt den Wecker still in deiner Uhr-App an (Name „Studium 06:45 · …“), ohne sie zu öffnen. Ändern sich Termine oder deine Fertigmach-Zeit, schaltet Studium den alten ab und stellt den neuen. Gilt nur für Uni-Morgen mit Beginn vor ${CUTOFF} Uhr. Weil die Uhr-App kein Datum kennt, kommt der Wecker erst 24 Std. vorher hinein.</p>`;
}
const leadRow = () => `<div class="alead"><span>Fertigmachen</span><button data-lead="-15" aria-label="15 Minuten weniger">−</button><b class="num">${dur(lead())}</b><button data-lead="15" aria-label="15 Minuten mehr">+</button></div>`;
// Blatt: ein Termin mit allem, was man vor Ort braucht
function evSheet(e, now) {
  const title = evTitle(e, true);
  const live = e.S <= now && now < e.E && going(e);
  const when = live ? `läuft · noch ${dur(minsUp(e.E - now))}` : e.S > now ? (key(e.S) === key(now) ? `in ${dur(minsUp(e.S - now))}` : dm(e.S)) : "vorbei";
  const ts = e.m === "EX" ? [] : evTasks(e);
  return `<div class="dt-head"><span class="dt-dot"></span><span class="dt-k">${esc(evKind(e) || "Termin")}</span>${tags(e)}</div>
    <div class="dt-title">${esc(title)}</div>
    ${e.r || !e.w ? `<div class="dt-room">${esc(e.r || "Raum offen")}</div>` : ""}
    <div class="dt-grid"><div><span>Wann</span><b class="num">${dm(e.S)} · ${esc(e.s)} bis ${esc(e.e)}</b></div><div><span>Bis dahin</span><b class="num">${esc(when)}</b></div></div>
    ${e.t && e.m !== "EX" ? `<div class="dt-row"><span>Thema</span><p>${esc(e.t)}</p></div>` : ""}
    ${e.n ? `<div class="dt-row"><span>${e.w ? "Notiz" : "Hinweis"}</span><p class="${e.w ? "" : "note"}">${esc(e.n)}</p></div>` : ""}
    ${ts.length ? `<div class="dt-row"><span>Dazu</span>${ts.map((t) => `<button class="dt-task ${t.done ? "ok" : ""}" data-open="task:${esc(t.id)}"><b>${t.done ? "✓" : "●"}</b><span>${esc(t.t)}${t.st && t.st[1] ? ` · ${t.st[0]}/${t.st[1]}` : ""}</span><i>›</i></button>`).join("")}</div>` : ""}
    ${e.m !== "EX" && !e.ex && !e.w && !e.u ? `<div class="dt-row"><span>${e.S < now ? "Anwesenheit" : "Vorhaben"}</span><div class="seg3" data-eid="${esc(e.id)}">
      <button data-att="da" class="${e.a === "da" && !e.x ? "on da" : ""}">${e.S < now ? "War da" : "Gehe hin"}</button>
      <button data-att="weg" class="${(e.a === "weg" || e.a === "nachgeholt") && !e.x ? "on weg" : ""}">${e.S < now ? "Nicht da" : "Nicht hin"}</button>
      <button data-att="aus" class="${e.x ? "on aus" : ""}">${e.S < now ? "Fiel aus" : "Fällt aus"}</button></div>${catchRow(e, now)}</div>` : ""}
    ${e.w ? `<div class="own"><span>Eigener Termin${e.pend ? " · wartet auf den Mac" : ""}</span><button class="obtn" data-edit-ev="${esc(e.id)}">Bearbeiten</button><button class="obtn del" data-del-ev="${esc(e.id)}">Löschen</button></div>` : ""}`;
}
/** Verpasst und vorbei: derselbe Haken „Nachgeholt“ wie am Mac (er hakt auch die Nachholen-Aufgabe dazu ab) */
function catchRow(e, now) {
  if (e.x || e.o || e.E > now || (e.a !== "weg" && e.a !== "nachgeholt")) return "";
  const ok = e.a === "nachgeholt";
  return `<button class="dt-task ${ok ? "ok" : ""}" data-catch="${esc(e.id)}"><b>${ok ? "✓" : "○"}</b><span>${ok ? "Nachgeholt" : "Steht unter Nachholen. Schon nachgeholt?"}</span></button>`;
}
// Blatt: eine Frist oder Prüfung
function taskSheet(t, now) {
  const due = t.d ? at(t.d, t.ti || "23:59") : null;
  const c = due ? countdown(due, now) : null;
  const ev = t.ev ? evs().find((e) => e.id === t.ev) : due ? evs().find((e) => e.m === t.m && e.d === t.d && e.s === t.ti) : null;
  const exam = t.ex || t.m === "EX";
  return `<div class="dt-head"><span class="dt-dot"></span><span class="dt-k">${exam ? "Prüfung" : t.k === "nachholen" ? "Nachholen" : "Frist"} · ${esc(t.m === "EX" ? "Prüfung" : mod(t.m)?.name || t.m)}</span>${t.done ? `<span class="tag c">erledigt</span>` : ""}</div>
    <div class="dt-title">${esc(exam && t.m !== "EX" ? mod(t.m)?.name || t.t : t.t)}</div>
    ${due ? `<div class="dt-grid"><div><span>${exam ? "Termin" : "Fällig"}</span><b class="num">${dm(due)}${t.ti && t.ti !== "23:59" ? ` · ${esc(t.ti)}` : ""}</b></div><div><span>Noch</span><b class="num ${c.cls}">${esc(c.txt)}</b></div></div>` : ""}
    ${t.st && t.st[1] ? `<div class="dt-row"><span>Fortschritt</span><div class="dt-prog">${ring(t.st[0], t.st[1])}<b class="num">${t.st[0]} von ${t.st[1]} Schritten</b></div></div>` : ""}
    ${t.det ? `<div class="dt-row"><span>Worum es geht</span><p>${esc(t.det)}</p></div>` : ""}
    ${ev ? `<div class="dt-row"><span>Termin dazu</span><button class="dt-task" data-open="ev:${esc(ev.id)}"><b>${esc(ev.s)}</b><span>${esc(dm(ev.S))} · ${esc(ev.r || "Raum offen")}</span><i>›</i></button></div>` : ""}
    ${t.up && !t.done ? `<p class="sh-f">Abgabe in Moodle: Ausarbeiten und Hochladen gehen auf dem Mac (Studium › Aufgabe › Abgabe vorbereiten).</p>` : ""}`;
}
let shownSheet = null;
function renderSheet(now) {
  if (!sheet || !D) return "";
  let body = "", c = "";
  if (sheet === "alarm") { body = alarmSheet(now); const a = alarmInfo(now); c = a ? cls(a.first.m) : ""; }
  else if (sheet === "eye") body = eyeSheet(now);
  else if (sheet === "form") { if (!draft) return (sheet = null), ""; body = formSheet(); c = cls(draft.m); }
  else if (sheet.startsWith("ev:")) { const e = evs().find((x) => x.id === sheet.slice(3)); if (!e) return (sheet = null), ""; body = evSheet(e, now); c = cls(e.m); }
  else if (sheet.startsWith("task:")) { const t = D.tasks.find((x) => x.id === sheet.slice(5)); if (!t) return (sheet = null), ""; body = taskSheet(t, now) + taskTools(t); c = cls(t.m); }
  // Nur beim Öffnen gleitet das Blatt herein; spätere Aktualisierungen bleiben ruhig. Wechselt nur der Inhalt (vom Auge ins
  // Formular, vom Termin ins Bearbeiten), bleibt das Blatt stehen und der Inhalt blendet um: eine Bewegung, kein zweites Blatt.
  const mode = shownSheet === sheet ? "still" : shownSheet ? "swap" : "";
  shownSheet = sheet;
  return `<div class="scrim ${mode ? "still" : ""}" data-close="1"></div><div class="sheet ${c} ${mode} ${sheet === "eye" || sheet === "form" ? "tall" : ""}" id="sheet" role="dialog" aria-modal="true" aria-label="${sheet === "eye" ? "Auge" : sheet === "form" ? "Termin" : sheet === "alarm" ? "Wecker" : "Details"}"><div class="grab"></div>${body}</div>`;
}
/** Abarbeiten am Handy: Schritte abhaken und ergänzen, die Aufgabe erledigen. Prüfungen hakt man nicht ab. */
function taskTools(t) {
  const exam = t.ex || t.m === "EX", steps = t.sp || [];
  return `${steps.length || !exam ? `<div class="dt-row"><span>Schritte</span>${steps.map((s, i) => `<button class="stp ${s[1] ? "ok" : ""}" data-step="${i}" data-tid="${esc(t.id)}"><i>${s[1] ? "✓" : ""}</i><span>${esc(s[0])}</span></button>`).join("")}
      ${exam ? "" : `<div class="stp-add"><input id="stp-new" type="text" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" maxlength="160" placeholder="${steps.length ? "Weiterer Schritt" : "In Schritte teilen: ersten Schritt eintippen"}"><button data-step-add="${esc(t.id)}" aria-label="Schritt hinzufügen">+</button></div>`}</div>` : ""}
    ${exam ? "" : `<button class="abtn wide ${t.done ? "done" : ""}" data-task-done="${esc(t.id)}">${t.done ? "Erledigt ✓ · wieder öffnen" : "Erledigt"}</button>`}
    ${t.w ? `<div class="own"><span>Eigene Aufgabe${t.pend ? " · wartet auf den Mac" : ""}</span><button class="obtn" data-edit-task="${esc(t.id)}">Bearbeiten</button><button class="obtn del" data-del-task="${esc(t.id)}">Löschen</button></div>` : ""}`;
}
/** Offenes Blatt neu zeichnen, ohne dass es neu hereingleitet oder die Stelle verliert */
function repaintSheet() {
  const y = $("#sheet")?.scrollTop || 0;
  $("#layer").innerHTML = renderSheet(new Date());
  const el = $("#sheet");
  if (el) el.scrollTop = y;
  placeEyes();
}
function addStep(id) {
  const inp = $("#stp-new"), text = (inp?.value || "").trim();
  if (!text) return inp?.focus();
  vib();
  post([{ op: "stepAdd", id, text }]);
  repaintSheet();
  $("#stp-new")?.focus();
}
/** Blatt schließen, wie es kam: nach unten weg, dann erst aus dem Baum */
let closing = false; // solange das Blatt hinausgleitet, zählt kein weiterer Tipp (sonst legte ein Doppeltipp zweimal an)
function closeSheet(then, force) {
  // Nach Speichern oder Löschen (then, force) ohne Rückfrage; Schließen von Hand fragt bei geändertem Formular
  if (!closing && !then && !force && !mayClose()) return;
  if (!closing && !then && !force && leaveForm()) return;
  const el = $("#sheet"), sc = $(".scrim");
  const done = () => { closing = false; sheet = null; draft = null; render(false); then && then(); };
  if (closing) return;
  closing = true;
  if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
  document.activeElement?.blur?.();
  el.style.transition = "transform 260ms cubic-bezier(0.4, 0, 0.7, 0.2)";
  el.style.transform = "translateY(105%)";
  if (sc) { sc.style.transition = "opacity 240ms ease"; sc.style.opacity = "0"; }
  setTimeout(done, 250);
}

// ---------- Das Blatt des Auges: eintragen, Rückfragen, Hinweise, Schnellantworten ----------
let cap = ""; // was gerade ins Auge getippt oder gesprochen wird
let capGot = null; // was das Auge daraus versteht
let quickOn = null;
let draft = null; // Termin im Formular: { id?, m, kind, date, start, end, room, note }
const lastMod = () => { const m = store.get("lastMod"); return D.mods.some((x) => x.id === m && m !== "EX") ? m : D.mods.find((x) => x.id !== "EX")?.id || ""; };
const dayChip = (k, now) => (k === key(now) ? "Heute" : k === key(addDays(now, 1)) ? "Morgen" : dm(at(k)));
/** Der Tag, der gilt, wenn keiner genannt ist: in der Woche der gezeigte, sonst heute */
const baseDay = () => (tab === "woche" && sel ? sel : null);
const TASK_WORD = /^\s*(aufgabe|todo|to-do|to do|erledigen|merken)\b\s*:?\s*/i;
function understand() {
  const now = new Date();
  const isTask = TASK_WORD.test(cap);
  const text = cap.replace(TASK_WORD, "");
  capGot = text.trim() ? window.StudiumVerstehen(text, now, D.mods, isTask ? null : baseDay(), isTask) : null;
  // Kein Fach im Satz: ein Termin bleibt ohne Fach (er gehört dann zu nichts), eine Aufgabe bekommt das zuletzt gewählte
  if (capGot && !capGot.m) capGot.m = isTask ? lastMod() : "";
  if (capGot) capGot.task = isTask;
  return capGot;
}
function capCard() {
  const g = capGot, now = new Date();
  if (!g) return `<p class="cap-hint">Zum Beispiel: <b>Gruppentreffen Mittwoch 14 Uhr Bib</b> oder <b>Aufgabe Folien lesen bis Freitag</b>. Tippen oder über die Tastatur einsprechen.</p>`;
  const sure = (ok, html) => `<span class="${ok ? "" : "guess"}">${html}</span>`;
  // Eine Aufgabe: fällig nur, wenn ein Tag genannt ist
  if (g.task) return `<div class="cap-card ${cls(g.m)}"><span class="rail"></span><span class="cc">
      <b>${esc(g.kind || "Aufgabe")}</b>
      <span class="cw num">${taskDay(g) ? `fällig ${esc(dayChip(taskDay(g), now))}${g.got.time ? ` · ${esc(g.start)}` : ""}` : "ohne Datum"}</span>
      <span class="ct"><i class="tag">Aufgabe</i>${sure(g.got.m, `<i class="tag c">${esc(mName(g.m))}</i>`)}</span></span></div>
    <div class="fc" id="cap-mods">${D.mods.filter((x) => x.id !== "EX").map((x) => `<button data-cap-mod="${esc(x.id)}" class="${cls(x.id)} ${g.m === x.id ? "on" : ""}" aria-label="${esc(x.name)}" aria-pressed="${g.m === x.id}"><i></i>${esc(mTag(x.id))}</button>`).join("")}</div>
    <div class="${cls(g.m)}"><button class="abtn wide" data-cap-save="1" ${g.kind ? "" : "disabled"}>${g.kind ? "Aufgabe eintragen" : "Noch ohne Namen"}</button></div>
    <p class="ferr" id="cap-err"></p>`;
  return `<button class="cap-card ${cls(g.m)}" data-cap-edit="1"><span class="rail"></span><span class="cc">
      <b>${esc(g.kind || "Termin")}</b>
      <span class="cw num">${sure(g.got.date, esc(dayChip(g.date, now)))} · ${sure(g.got.time && !g.got.pm, `${esc(g.start)} bis ${esc(g.end)}`)}</span>
      <span class="ct">${g.m ? sure(g.got.m, `<i class="tag c">${esc(mName(g.m))}</i>`) : ""}${g.room ? `<i class="tag">${esc(g.room)}</i>` : ""}</span></span><span class="ce">Ändern</span></button>
    <div class="${cls(g.m)}"><button class="abtn wide" data-cap-save="1" ${g.kind ? "" : "disabled"}>${g.kind ? "Eintragen" : "Noch ohne Namen"}</button></div>
    <p class="ferr" id="cap-err"></p>
    ${Object.values(g.got).some((x) => !x) ? `<p class="cap-note">Gepunktet ist angenommen, nicht genannt.</p>` : ""}`;
}
function eyeStatus(now) {
  if (sendErr && out.length) return { txt: sendErr, cls: "old" };
  if (out.length) {
    // Wie lange schon, und ob es am Handy liegt (ohne Netz) oder am Mac
    const oldest = out.reduce((a, o) => (!a || o.at < a ? o.at : a), "");
    const long = oldest && Date.now() - new Date(oldest).getTime() > 10 * 6e4 ? ` seit ${since(new Date(oldest), now)}` : "";
    return { txt: `${plural(out.length, "Eintrag wartet", "Einträge warten")}${long} auf den Mac${loadErr || navigator.onLine === false ? " · ohne Netz" : ""}`, cls: "wait" };
  }
  if (loadErr) return { txt: loadErr, cls: "old" };
  if (syncedAt && Date.now() - syncedAt < 5 * 6e4) return { txt: "Am Mac angekommen", cls: "" };
  return { txt: freshness(now) || "Stand vom Mac: noch keiner", cls: stale() ? "old" : "" };
}
function eyeDyn(now, fresh) {
  const qs = questions(now), due = qs.filter((q) => askable(q, now)), wait = qs.length - due.length;
  const ns = nudges(now);
  const a = quickOn ? quick(quickOn, now) : null;
  const row = (r) => `<button class="qr ${r.c || ""}" ${r.open ? `data-open="${esc(r.open)}"` : ""}><i></i><span><b>${esc(r.title)}</b><em>${esc(r.sub || "")}</em></span>${r.chip ? `<span class="cd ${r.tone || ""} num">${esc(r.chip)}</span>` : ""}</button>`;
  return `${due.length ? `<div class="ey-sec"><h3>${due.length === 1 ? "Eine Frage" : `${due.length} Fragen`} an dich</h3>${due.slice(0, 3).map((q) => `<div class="qc ${q.m ? cls(q.m) : ""}"><p>${esc(q.q)}</p>
      <div class="qo">${(q.opts || []).map((o) => `<button data-ans="${esc(q.id)}" data-a="${esc(o)}">${esc(o)}</button>`).join("")}</div>
      <div class="qm"><button data-snooze="${esc(q.id)}">Später</button><button data-skip="${esc(q.id)}">Unwichtig</button></div></div>`).join("")}
      ${due.length > 3 ? `<p class="ey-more">und ${due.length - 3} weitere, sie rücken nach</p>` : ""}</div>` : ""}
    ${ns.length ? `<div class="ey-sec"><h3>Hinweise</h3>${ns.map((n) => `<button class="nr ${n.tone}" ${n.open ? `data-open="${esc(n.open)}"` : ""} ${n.seen ? `data-seen="${esc(n.seen)}"` : ""} ${n.drop ? `data-drop="${esc(n.drop)}"` : ""} ${n.redo ? `data-redo="${esc(n.redo)}"` : ""}><i></i><span><b>${esc(n.short)}</b>${n.full ? `<em>${esc(n.full)}</em>` : ""}</span></button>`).join("")}</div>` : ""}
    <div class="ey-sec"><h3>Schnell gefragt</h3><div class="qk">${QUICK.map(([k, l]) => `<button data-quick="${k}" class="${quickOn === k ? "on" : ""}">${l}</button>`).join("")}</div>
      ${a ? `<div class="qa ${fresh ? "" : "still"}"><p class="qh">${esc(a.head)}</p>${a.rows.map(row).join("")}</div>` : ""}</div>
    ${!due.length && !ns.length && wait ? `<p class="ey-more">${plural(wait, "Frage ist", "Fragen sind")} zurückgestellt</p>` : ""}
    <p class="sh-f">Das Gespräch mit dem Assistenten und der Moodle-Abgleich laufen am Mac. Was du hier einträgst, kommt dort an, sobald Studium offen ist.</p>`;
}
function eyeSheet(now) {
  const st = eyeStatus(now);
  understand();
  return `<div class="ey-top"><span class="eye-slot" data-eye="48"></span><div><b>Was steht an?</b><button class="ey-st ${st.cls}" id="ey-st" data-refresh="1"><i></i><span>${esc(st.txt)}</span></button></div></div>
    <div class="cap"><input id="cap" type="text" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" spellcheck="false" maxlength="140" placeholder="Termin eintippen oder einsprechen" value="${esc(cap)}"><button class="cap-x" data-cap-clear="1" aria-label="Leeren" ${cap ? "" : "hidden"}>×</button></div>
    <div id="cap-out">${capCard()}</div>
    <div id="ey-dyn">${eyeDyn(now, true)}</div>`;
}
/** Nur die beweglichen Teile des Auges neu zeichnen: das Eingabefeld behält Fokus und Text */
function paintEye(fresh) {
  if (sheet !== "eye" || !$("#ey-dyn")) return;
  const now = new Date(), st = eyeStatus(now), el = $("#ey-st");
  $("#ey-dyn").innerHTML = eyeDyn(now, fresh);
  if (el) { el.className = `ey-st ${st.cls}`; el.querySelector("span").textContent = st.txt; }
}

// ---------- Formular: eigenen Termin anlegen oder ändern ----------
const DUR = [[45, "45 Min."], [60, "1 Std."], [90, "1,5 Std."], [120, "2 Std."]];
const minsOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
let formFrom = null; // "eye": Schließen führt zurück ins Auge, der Satz steht dort noch
let formBase = ""; // so sah das Formular beim Öffnen aus: geändert und geschlossen fragt einmal nach
let formArmed = 0;
function openForm(d, from = null) {
  const now = new Date();
  const start = Math.min(20, Math.max(8, now.getHours() + 1)) * 60;
  draft = { m: "", kind: "", date: baseDay() || key(now), start: hmOf(start), end: hmOf(start + 60), room: "", note: "", ...d };
  formFrom = from;
  formBase = JSON.stringify(draft);
  formArmed = 0;
  sheet = "form";
  render(false);
}
/**
 * Darf das Blatt jetzt zu? Ein geändertes Formular fragt einmal an Ort und Stelle („Nochmal schließen verwirft“),
 * statt Getipptes still wegzuwerfen. Aus dem Auge geöffnet, führt Schließen zurück ins Auge.
 */
function mayClose() {
  if (sheet !== "form" || !draft) return true;
  if (JSON.stringify(draft) === formBase || Date.now() - formArmed < 4000) return true;
  formArmed = Date.now();
  vib();
  const e = $("#f-err");
  if (e) e.textContent = "Änderungen verwerfen? Nochmal schließen";
  return false;
}
function leaveForm() {
  if (sheet === "form" && formFrom === "eye") {
    draft = null; formFrom = null; sheet = "eye";
    render(false);
    return true;
  }
  return false;
}
function formDays(now) {
  const days = Array.from({ length: 8 }, (_, i) => key(addDays(now, i)));
  const other = !!draft.date && !days.includes(draft.date);
  return days.map((k) => `<button data-f-day="${k}" class="${draft.date === k ? "on" : ""}">${esc(dayChip(k, now))}</button>`).join("") +
    `<label class="fdate ${other ? "on" : ""}"><span>${other ? esc(dm(at(draft.date))) : "Anderer Tag"}</span><input type="date" id="f-date" value="${esc(draft.date)}" min="${key(addDays(now, -14))}" max="${key(addDays(now, 365))}"></label>`;
}
/** Eigene Aufgabe ändern: Name, Fach, Tag oder ohne Datum, Uhrzeit optional */
function taskFormSheet() {
  const now = new Date();
  return `<div class="dt-head"><span class="dt-dot"></span><span class="dt-k">Aufgabe ändern</span></div>
    <input class="fi big" id="f-kind" type="text" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" maxlength="120" placeholder="Was ist zu tun?" value="${esc(draft.kind)}">
    <div class="fl">Fach</div><div class="fc" id="f-mods">${D.mods.filter((x) => x.id !== "EX").map((x) => `<button data-f-mod="${esc(x.id)}" class="${cls(x.id)} ${draft.m === x.id ? "on" : ""}" aria-label="${esc(x.name)}" aria-pressed="${draft.m === x.id}"><i></i>${esc(mTag(x.id))}</button>`).join("")}</div>
    <div class="fl">Bis wann</div><div class="fc scroll" id="f-days"><button data-f-day="" class="${!draft.date ? "on" : ""}">Ohne Datum</button>${formDays(now)}</div>
    <div class="fl">Uhrzeit</div><div class="ft"><input type="time" id="f-time" aria-label="Uhrzeit" value="${esc(draft.time || "")}"></div>
    <p class="ferr" id="f-err"></p>
    <button class="abtn wide" data-f-save="1">Speichern</button>`;
}
function formSheet() {
  if (draft.task) return taskFormSheet();
  const now = new Date(), len = minsOf(draft.end) - minsOf(draft.start);
  return `<div class="dt-head"><span class="dt-dot"></span><span class="dt-k">${draft.id ? "Termin ändern" : "Neuer Termin"}</span></div>
    <input class="fi big" id="f-kind" type="text" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" maxlength="60" placeholder="Was? Zum Beispiel Gruppentreffen" value="${esc(draft.kind)}">
    <div class="fl">Fach</div><div class="fc" id="f-mods">${D.mods.filter((x) => x.id !== "EX").map((x) => `<button data-f-mod="${esc(x.id)}" class="${cls(x.id)} ${draft.m === x.id ? "on" : ""}" aria-label="${esc(x.name)}" aria-pressed="${draft.m === x.id}"><i></i>${esc(x.short && x.short.length <= 10 ? x.short : x.name.length <= 10 ? x.name : x.id)}</button>`).join("")}</div>
    <div class="fl">Tag</div><div class="fc scroll" id="f-days">${formDays(now)}</div>
    <div class="fl">Zeit</div><div class="ft"><input type="time" id="f-start" aria-label="Beginn" value="${esc(draft.start)}"><span>bis</span><input type="time" id="f-end" aria-label="Ende" value="${esc(draft.end)}"></div>
    <div class="fc" id="f-dur">${DUR.map(([d, l]) => `<button data-f-dur="${d}" class="${len === d ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="fl">Ort</div><input class="fi" id="f-room" type="text" enterkeyhint="done" autocomplete="off" maxlength="80" placeholder="Raum, Adresse oder online" value="${esc(draft.room)}">
    <div class="fl">Notiz</div><textarea class="fi" id="f-note" rows="2" maxlength="300" placeholder="Optional">${esc(draft.note)}</textarea>
    <p class="ferr" id="f-err"></p>
    <button class="abtn wide" data-f-save="1">${draft.id ? "Speichern" : "Eintragen"}</button>`;
}
/** Formular nach einer Änderung nachziehen, ohne es neu zu bauen (Fokus und Tastatur bleiben) */
function paintForm() {
  const sh = $("#sheet");
  if (sheet !== "form" || !sh || !draft) return;
  sh.className = `sheet ${cls(draft.m)} still tall`;
  sh.querySelectorAll("[data-f-mod]").forEach((b) => { const on = b.dataset.fMod === draft.m; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  if (draft.task) {
    $("#f-days").innerHTML = `<button data-f-day="" class="${!draft.date ? "on" : ""}">Ohne Datum</button>${formDays(new Date())}`;
    if ($("#f-time") && $("#f-time").value !== (draft.time || "")) $("#f-time").value = draft.time || "";
    return;
  }
  $("#f-days").innerHTML = formDays(new Date());
  const len = minsOf(draft.end) - minsOf(draft.start);
  sh.querySelectorAll("[data-f-dur]").forEach((b) => b.classList.toggle("on", Number(b.dataset.fDur) === len));
  if ($("#f-start").value !== draft.start) $("#f-start").value = draft.start;
  if ($("#f-end").value !== draft.end) $("#f-end").value = draft.end;
  $("#f-err").textContent = len <= 0 ? "Ende liegt vor dem Beginn" : "";
}
const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "termin";
/** Geänderte eigene Aufgabe speichern (Formular aus dem Aufgabenblatt) */
function saveTaskEdit(d) {
  const title = (d.kind || "").trim();
  if (!title) return "Die Aufgabe braucht einen Namen";
  if (d.time && !d.date) return "Eine Uhrzeit braucht einen Tag";
  post([{ op: "task", task: { id: d.id, m: d.m, title, date: d.date || "", time: d.date && d.time ? d.time : "" } }]);
  vib();
  closeSheet(() => {
    say({ key: `saved@${d.id}@${Date.now()}`, short: `Gespeichert: ${title}${d.date ? `, fällig ${dm(at(d.date))}` : ""}`, tone: "info", open: `task:${d.id}` }, true);
    flashEye("done");
  });
  return "";
}
/** Eine Uhrzeit ohne Tag („bis 18 Uhr“): heute, wenn sie noch kommt, sonst morgen */
function taskDay(g) {
  if (g.got.date) return g.date;
  if (!g.got.time) return "";
  const now = new Date(), t = at(key(now), g.start);
  return key(t > now ? now : addDays(now, 1));
}
/** Eigene Aufgabe eintragen (aus dem Satz im Auge) */
function saveTask(g) {
  const title = (g.kind || "").trim();
  if (!title) return "Die Aufgabe braucht einen Namen";
  const id = `eigen-${slug(title)}-${uid().slice(0, 4)}`;
  store.set("lastMod", g.m);
  const day = taskDay(g);
  post([{ op: "task", task: { id, m: g.m, title, detail: "", date: day, time: day && g.got.time ? g.start : "" } }]);
  vib();
  closeSheet(() => {
    say({ key: `saved@${id}`, short: `Aufgabe eingetragen: ${title}${day ? `, fällig ${dm(at(day))}` : ""}`, tone: "info", open: `task:${id}` }, true);
    flashEye("done");
  });
  return "";
}
/** Eigenen Termin eintragen oder ändern. Gibt eine Meldung zurück, wenn etwas fehlt. */
function saveEvent(d) {
  const kind = (d.kind || "").trim();
  if (!kind) return "Der Termin braucht einen Namen";
  if (minsOf(d.end) <= minsOf(d.start)) return "Ende liegt vor dem Beginn";
  const id = d.id || `eigen-${slug(kind)}-${uid().slice(0, 4)}`;
  if (d.m) store.set("lastMod", d.m);
  post([{ op: "event", event: { id, m: d.m || "", kind, date: d.date, start: d.start, end: d.end, room: (d.room || "").trim(), note: (d.note || "").trim() } }]);
  vib();
  // Zeigen, wo er gelandet ist: in der Woche auf seinen Tag springen, wenn er in dieser oder der nächsten liegt
  const w = Math.round((monday(at(d.date)) - monday(new Date())) / (7 * 864e5));
  closeSheet(() => {
    if (tab === "woche" && (w === 0 || w === 1)) { week = w; sel = d.date; render(false); pageIn(0); }
    say({ key: `saved@${id}@${Date.now()}`, short: `${d.id ? "Gespeichert" : "Eingetragen"}: ${kind}, ${dm(at(d.date))}${at(d.date).getFullYear() !== new Date().getFullYear() ? String(at(d.date).getFullYear()) : ""} ${d.start}`, tone: "info", open: `ev:${id}` }, true);
    flashEye("done");
  });
  return "";
}
// Android: Uhr-App mit fertigem Wecker öffnen (du bestätigst dort)
function setAlarm(hhmmStr, msg) {
  const [h, m] = hhmmStr.split(":").map(Number);
  const now = new Date(), p = wakePlan(now);
  store.set("alarm", `${key(p.day)} ${hhmmStr}`);
  if (N) {
    let ok = false;
    try { ok = N.setAlarm(h, m, msg); } catch { ok = false; }
    alarmHint = ok ? "" : `Keine Uhr-App gefunden, die Wecker annimmt. Stell ihn selbst auf ${hhmmStr}.`;
    if (!ok) store.set("alarm", "");
    return render(false);
  }
  const url = `intent:#Intent;action=android.intent.action.SET_ALARM;i.android.intent.extra.alarm.HOUR=${h};i.android.intent.extra.alarm.MINUTES=${m};S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(msg)};B.android.intent.extra.alarm.SKIP_UI=false;end`;
  let left = false;
  const onHide = () => (left = true);
  document.addEventListener("visibilitychange", onHide, { once: true });
  location.href = url;
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    if (!left) {
      store.set("alarm", "");
      alarmHint = `Dein Handy hat den Wecker nicht direkt angenommen. Stell ihn in der Uhr-App auf ${hhmmStr}.`;
    } else alarmHint = "";
    render(false);
  }, 1500);
}

// ---------- Ansichten ----------
let tab = store.get("tab") || "heute";
let week = 0;
let sel = null;

/** Zeitpunkt kurz: heute 14:05, gestern 20:10, Mo 16.11. 21:40 */
const since = (d, now = new Date()) => (key(d) === key(now) ? `heute ${hhmm(d)}` : key(d) === key(addDays(now, -1)) ? `gestern ${hhmm(d)}` : `${dm(d)} ${hhmm(d)}`);
/** Wann der Mac diesen Stand geschrieben hat (nicht, wann das Handy ihn geholt hat): ist der Mac tagelang aus, steht das da */
const macAt = () => { const t = D0?.sent ? new Date(D0.sent).getTime() : 0; return Number.isFinite(t) && t > 0 ? t : fetchedAt; };
const stale = () => !macAt() || Date.now() - macAt() > 26 * 36e5;
function freshness(now) {
  const t = macAt();
  if (!t) return "";
  const m = Math.floor((now - t) / 6e4);
  if (m < 2) return "Stand vom Mac: gerade eben";
  if (m < 60) return `Stand vom Mac: vor ${m} Min.`;
  return `Stand vom Mac: ${since(new Date(t), now)}`;
}
function head(now, title, wd) {
  const old = stale();
  // Ohne Netz trotzdem sagen, wie alt der gezeigte Stand ist
  const sub = loadErr ? esc(macAt() ? `${loadErr} · ${freshness(now).replace("Stand vom Mac: ", "Stand ")}` : loadErr) : freshness(now);
  return `<div class="head rise"><div><div class="wd">${esc(wd)}</div><h1>${esc(title)}</h1><div class="sub"><i class="${old || loadErr ? "old" : ""}"></i>${sub}</div></div></div>`;
}

function vHeute(now) {
  const all = evs();
  const today = all.filter((e) => key(e.S) === key(now));
  let rows = "", i = 1, drawn = false;
  for (const e of today) {
    if (!drawn && e.S > now && today.some((x) => x.S <= now)) { rows += `<div class="nowline num">jetzt ${hhmm(now)}</div>`; drawn = true; }
    rows += evRow(e, now, i++);
  }
  const allDl = deadlines(), dls = allDl.slice(0, 8);
  return head(now, `${now.getDate()}. ${MON[now.getMonth()]}`, `${WDL[now.getDay()]} · KW ${isoWeek(now)}`) +
    hero(all, now) +
    alarmRow(now) +
    `<div class="sec"><h2>Heute</h2><span>${plural(today.filter(going).length, "Termin", "Termine")}</span></div><div class="tl">${rows || `<div class="card empty">Heute keine Termine</div>`}</div>` +
    (dls.length ? `<div class="sec"><h2>Fristen</h2><span>${allDl.length} offen</span></div><div class="strip">${dls.map((t, j) => dlCard(t, now, j)).join("")}</div>` : "");
}

let autoWeek = true; // beim Öffnen des Reiters: am Wochenende ohne Termine gleich die nächste Woche zeigen
function weekDays(now) {
  if (autoWeek && sel === null && week === 0 && (now.getDay() === 6 || now.getDay() === 0) && !evs().some((e) => e.S >= at(key(now)) && e.S < addDays(monday(now), 7))) week = 1;
  autoWeek = false;
  const mon = addDays(monday(now), week * 7);
  const all = evs();
  const weekend = all.some((e) => e.S >= addDays(mon, 5) && e.S < addDays(mon, 7));
  const days = Array.from({ length: weekend ? 7 : 5 }, (_, i) => addDays(mon, i));
  if (!sel || !days.some((d) => key(d) === sel)) sel = key(days.find((d) => key(d) === key(now)) || days.find((d) => d > now) || days[0]);
  return { mon, all, days };
}
/**
 * Eigene Termine nach der nächsten Woche (Zahnarzt in drei Wochen): die Woche blättert nur bis „Nächste Woche“, hier
 * bleiben sie auffindbar, zum Ansehen, Ändern und Löschen.
 */
function laterOwn(now) {
  const from = addDays(monday(now), 14);
  const list = evs().filter((e) => e.w && e.S >= from).slice(0, 20);
  if (!list.length) return "";
  const yr = now.getFullYear();
  return `<div class="sec"><h2>Später</h2><span>${plural(list.length, "eigener Termin", "eigene Termine")}</span></div>` +
    list.map((e, i) => `<div class="card dl ${cls(e.m)} rise" style="--i:${i}" data-open="ev:${esc(e.id)}"><div class="big"><b class="num">${e.S.getDate()}</b><span>${MON[e.S.getMonth()].slice(0, 3)}${e.S.getFullYear() !== yr ? ` ${e.S.getFullYear()}` : ""}</span></div>
      <div class="mid"><div class="tt">${esc(evTitle(e))}</div><div class="sb"><span class="num">${dm(e.S)} · ${esc(e.s)} bis ${esc(e.e)}</span>${e.pend ? `<span class="tag wait">wartet auf den Mac</span>` : ""}</div></div></div>`).join("");
}
const weekTitle = (mon) => (week === 0 ? "Diese Woche" : week === 1 ? "Nächste Woche" : `KW ${isoWeek(mon)}`);
function daysHTML(now, w) {
  const si = w.days.findIndex((d) => key(d) === sel);
  return `<span class="dsel" style="--si:${si}"></span>${w.days.map((d) => {
    const de = w.all.filter((e) => key(e.S) === key(d) && going(e));
    return `<button class="day ${key(d) === sel ? "on" : ""} ${key(d) === key(now) ? "today" : ""}" data-day="${key(d)}"><span class="w">${WD[d.getDay()]}</span><span class="n num">${d.getDate()}</span><span class="dots">${de.slice(0, 4).map((e) => `<i class="${cls(e.m)}"></i>`).join("")}</span></button>`;
  }).join("")}`;
}
/** Der gewählte Tag: Überschrift, Termine, Fristen */
function dayPage(now, all) {
  const dayEv = (all || evs()).filter((e) => key(e.S) === sel);
  const dls = deadlines().filter((t) => key(t.at) === sel);
  const sd = at(sel);
  return `<div class="sec"><h2>${WDL[sd.getDay()]}</h2><span>${String(sd.getDate()).padStart(2, "0")}.${String(sd.getMonth() + 1).padStart(2, "0")}.</span></div>
    <div class="tl">${dayEv.map((e, i) => evRow(e, now, i + 2)).join("") || `<div class="card empty rise">Keine Termine</div>`}
    ${dls.map((t, i) => `<div class="card dl ${cls(t.m)} rise" style="--i:${i + 3}" data-open="task:${esc(t.id)}"><div class="big"><b class="num">${esc(t.ti && t.ti !== "23:59" ? t.ti : "ganzt.")}</b></div><div class="mid"><div class="tt">${esc(t.t)}</div><div class="sb"><span class="tag c">${esc(mTag(t.m))}</span>Frist</div></div></div>`).join("")}</div>`;
}
function vWoche(now) {
  const w = weekDays(now);
  return head(now, weekTitle(w.mon), `${dm(w.mon)} bis ${dm(addDays(w.mon, w.days.length - 1))}`) +
    `<div class="seg rise"><span class="sl" style="transform:translateX(${week === 0 ? 0 : 100}%)"></span><button data-week="0" class="${week === 0 ? "on" : ""}">Diese Woche</button><button data-week="1" class="${week === 1 ? "on" : ""}">Nächste Woche</button></div>` +
    `<div class="days rise" id="days" style="--n:${w.days.length};--i:1">${daysHTML(now, w)}</div>` +
    `<div class="swipe" id="swipe"><div class="page" id="page">${dayPage(now, w.all)}</div></div>` +
    laterOwn(now);
}
const CALM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Neuer Tag gleitet aus der Richtung herein, in die es weitergeht (dir 1 = vor, -1 = zurück, 0 = nur einblenden) */
function pageIn(dir, from = 0) {
  const pg = $("#page");
  if (!pg) return;
  pg.querySelectorAll(".rise").forEach((el) => el.classList.remove("rise"));
  if (CALM()) return pg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
  pg.animate([{ transform: `translateX(${from || dir * 44}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
}
/** Tag wechseln, ohne die Ansicht neu aufzubauen: Markierung gleitet, alter Tag geht in Wischrichtung, neuer kommt nach */
function changeDay(k, dir, dragged = 0) {
  if (k === sel || !$("#page")) return;
  vib();
  sel = k;
  const now = new Date(), btns = [...document.querySelectorAll("[data-day]")];
  btns.forEach((b) => b.classList.toggle("on", b.dataset.day === sel));
  $(".dsel")?.style.setProperty("--si", btns.findIndex((b) => b.dataset.day === sel));
  const pager = $("#swipe"), old = $("#page");
  pager.querySelectorAll(".page.gone").forEach((x) => x.remove()); // Reste eines früheren Wechsels
  old.getAnimations().forEach((a) => a.cancel());
  const next = document.createElement("div");
  next.className = "page"; next.id = "page";
  next.innerHTML = dayPage(now);
  old.removeAttribute("id"); old.classList.add("gone");
  pager.appendChild(next);
  lastApp = vWoche(now); // der Stand im Bild entspricht wieder dem frisch gerechneten: der nächste Takt baut nichts neu
  if (CALM()) { old.remove(); return pageIn(0); }
  old.style.transform = ""; old.style.opacity = "";
  old.animate([{ transform: `translateX(${dragged}px)`, opacity: Math.max(0.2, 1 - Math.abs(dragged) / 260) }, { transform: `translateX(${dragged - dir * 60}px)`, opacity: 0 }], { duration: 170, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
  setTimeout(() => old.remove(), 190); // nicht auf das Ende der Bewegung warten: im Hintergrund käme es nie
  pageIn(dir);
}
/** Woche wechseln: Kopf, Schalter und Tagesleiste ziehen nach, der Inhalt gleitet in Blätterrichtung */
function changeWeek(n, last) {
  if (n === week || !$("#page")) return;
  vib();
  const dir = n > week ? 1 : -1, now = new Date();
  week = n; sel = null;
  let w = weekDays(now);
  if (last) { sel = key(w.days[w.days.length - 1]); w = weekDays(now); } // rückwärts hineingewischt: auf dem letzten Tag landen
  const h1 = $(".head h1"), wd = $(".head .wd"), sl = $(".seg .sl"), days = $("#days");
  if (h1) h1.textContent = weekTitle(w.mon);
  if (wd) wd.textContent = `${dm(w.mon)} bis ${dm(addDays(w.mon, w.days.length - 1))}`;
  if (sl) sl.style.transform = `translateX(${week === 0 ? 0 : 100}%)`;
  document.querySelectorAll("[data-week]").forEach((b) => b.classList.toggle("on", Number(b.dataset.week) === week));
  if (days) {
    days.style.setProperty("--n", w.days.length);
    days.classList.remove("rise");
    days.innerHTML = daysHTML(now, w);
    if (!CALM()) days.animate([{ transform: `translateX(${dir * 36}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  }
  const old = $("#page");
  $("#swipe").querySelectorAll(".page.gone").forEach((x) => x.remove());
  old.innerHTML = dayPage(now, w.all);
  lastApp = vWoche(now);
  pageIn(dir);
}
function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const n = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - n); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return Math.ceil(((t - y) / 864e5 + 1) / 7); }

function vFristen(now) {
  const dls = deadlines();
  const ex = exams();
  const over = dls.filter((t) => t.at < now), ahead = dls.filter((t) => t.at >= now);
  const soon = ahead.filter((t) => t.at - now < 7 * 864e5), later = ahead.filter((t) => t.at - now >= 7 * 864e5);
  const loose = D.tasks.filter((x) => x.k === "offen" && !x.done && !x.ex && x.m !== "EX");
  const row = (t, i, exam) => {
    // Überfällig: wie viele Tage schon drüber (die Überschrift „Überfällig“ sagt, wofür die Zahl steht)
    const late = t.at < now, days = Math.abs(Math.round((at(key(t.at)) - at(key(now))) / 864e5));
    const h = (t.at - now) / 36e5, c = late || h < 48 ? "hot" : h < 24 * 7 ? "soon" : "";
    return `<div class="card dl ${cls(t.m)} rise" style="--i:${i}" data-open="task:${esc(t.id)}"><div class="big ${c}"><b class="num">${days === 0 ? "heute" : days}</b><span>${days === 0 ? "" : days === 1 ? "Tag" : "Tage"}</span></div>
      <div class="mid"><div class="tt">${esc(exam && t.m !== "EX" ? mName(t.m) : t.t)}</div><div class="sb">${exam ? "" : `<span class="tag c">${esc(mTag(t.m))}</span>`}<span class="num">${dm(t.at)}${t.ti && t.ti !== "23:59" ? ` ${esc(t.ti)}` : ""}</span>${t.st && t.st[1] ? `<span class="prog">${ring(t.st[0], t.st[1])}<span class="num">${t.st[0]}/${t.st[1]}</span></span>` : ""}</div>
      ${exam && t.det ? `<div class="sb">${esc(t.det)}</div>` : ""}</div>${exam ? "" : `<button class="chk" data-task-done="${esc(t.id)}" aria-label="Erledigt: ${esc(t.t)}"></button>`}</div>`;
  };
  let i = 1;
  return head(now, "Fristen", `${dls.length} offen · ${plural(ex.length, "Prüfung", "Prüfungen")}`) +
    (over.length ? `<div class="sec"><h2>Überfällig</h2><span>abhaken, wenn erledigt</span></div>${over.map((t) => row(t, i++)).join("")}` : "") +
    (soon.length ? `<div class="sec"><h2>Nächste 7 Tage</h2></div>${soon.map((t) => row(t, i++)).join("")}` : "") +
    (later.length ? `<div class="sec"><h2>Später</h2></div>${later.map((t) => row(t, i++)).join("")}` : "") +
    (!dls.length ? `<div class="card empty rise">Keine offenen Fristen</div>` : "") +
    // Aufgaben ohne Datum (auch am Handy eingetragene): sonst wären sie hier unsichtbar
    (loose.length ? `<div class="sec"><h2>Ohne Datum</h2><span>${loose.length} offen</span></div>${loose.map((x) => `<div class="card dl ${cls(x.m)} rise" style="--i:${i++}" data-open="task:${esc(x.id)}"><div class="big"><i class="ld"></i></div>
      <div class="mid"><div class="tt">${esc(x.t)}</div><div class="sb"><span class="tag c">${esc(mTag(x.m))}</span>${x.st && x.st[1] ? `<span class="prog">${ring(x.st[0], x.st[1])}<span class="num">${x.st[0]}/${x.st[1]}</span></span>` : ""}${x.pend ? `<span class="tag wait">wartet auf den Mac</span>` : ""}</div></div><button class="chk" data-task-done="${esc(x.id)}" aria-label="Erledigt: ${esc(x.t)}"></button></div>`).join("")}` : "") +
    (ex.length ? `<div class="sec"><h2>Prüfungen</h2></div>${ex.map((t) => row(t, i++, true)).join("")}` : "");
}

function vFaecher(now) {
  const all = evs();
  const until = addDays(now, 28);
  const cards = D.mods.filter((m) => m.id !== "EX").map((m, i) => {
    const slots = new Map();
    for (const e of all) {
      if (e.m !== m.id || e.x || e.o || e.S < at(key(now)) || e.S > until) continue;
      const k = `${(e.S.getDay() + 6) % 7}|${e.s}`;
      if (!slots.has(k)) slots.set(k, e);
    }
    const sl = [...slots.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, e]) => `<div class="slot"><b class="num">${WD[e.S.getDay()]} ${esc(e.s)}</b><span>${esc(e.k)}</span><em>${esc(e.r || "Raum offen")}</em></div>`).join("");
    const nx = all.find((e) => e.m === m.id && going(e) && e.S > now);
    const open = D.tasks.filter((t) => t.m === m.id && !t.done && !t.ex && t.k !== "nachholen").length;
    const back = D.tasks.filter((t) => t.m === m.id && !t.done && t.k === "nachholen").length;
    const ex = D.tasks.find((t) => t.m === m.id && t.ex && !t.done && t.d);
    return `<div class="card mod ${cls(m.id)} rise" style="--i:${i}"><h3><i></i>${esc(m.name)}</h3>${sl || `<div class="slot">Keine Termine in den nächsten vier Wochen</div>`}
      <div class="chips">${nx ? `<span class="tag c">Nächster ${dm(nx.S)} ${esc(nx.s)}</span>` : ""}${ex ? `<span class="tag red">Prüfung ${dm(at(ex.d))}</span>` : ""}${open ? `<span class="tag">${open} offen</span>` : ""}${back ? `<span class="tag">${back} nachholen</span>` : ""}</div></div>`;
  });
  const st = nat();
  const settings = `<div class="sec"><h2>Einstellungen</h2></div><div class="card setc rise" style="--i:${cards.length + 1}">${st ? `<div class="sw-line first"><div><b>Wecker in die Uhr-App</b><span>${st.on ? (st.sentAt > Date.now() ? `Gestellt: ${dm(new Date(st.sentAt))} ${hhmm(new Date(st.sentAt))}` : "Gerade kein Wecker nötig") : "Aus"}</span></div>${autoSwitch(st.on)}</div>` : ""}${leadRow()}
    <p class="sh-f">Zeit vom Aufstehen bis zum Losgehen. Der Wecker rechnet damit.</p>
    <div class="set-line"><span>Verbindung zum Mac</span><button class="unpair" data-unpair="1">Verbindung trennen</button></div></div>`;
  return head(now, "Fächer", D.sem || "") + cards.join("") + settings;
}

function hello() {
  // Schlüssel schon da (QR gescannt), nur der Stand fehlt noch: nicht das Code-Formular zeigen, sondern laden und
  // bei einem Fehler sagen, was los ist, mit „Erneut versuchen“
  if (store.get("k")) return `<div class="hello rise"><div class="eye-slot" data-eye="96"></div><h1>Studium</h1>
    <p>${loadErr ? esc(loadErr) : "Verbunden. Der Stand vom Mac wird geladen …"}</p>
    ${loadErr ? `<button class="abtn wide" data-refresh="1">Erneut versuchen</button>` : ""}</div>`;
  return `<div class="hello rise"><div class="eye-slot" data-eye="96"></div><h1>Studium</h1>
    <p>Dein Stundenplan, Fristen und Räume aus der Mac-App, verschlüsselt. Nur dieses Gerät kann sie lesen.</p>
    <form class="pair" id="pair" autocomplete="off">
      <label for="code">Kopplungscode</label>
      <input id="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="14" placeholder="XXXX-XXXX-XXXX" value="${esc(pairDraft)}">
      <button class="abtn wide" type="submit" ${pairBusy ? "disabled" : ""}>${pairBusy ? "Verbindet …" : "Verbinden"}</button>
      ${pairErr ? `<div class="perr">${esc(pairErr)}</div>` : ""}
    </form>
    <p class="hint">Den Code zeigt die Mac-App unter <b>Gehe zu › Handy verbinden …</b> neben dem QR-Code. Er gilt 24 Stunden. Scannst du stattdessen den QR-Code, verbindet sich ${N ? "die App" : "die Seite"} von selbst.</p>
    ${loadErr && store.get("k") ? `<p style="color:var(--hot)">${esc(loadErr)}</p>` : ""}</div>`;
}

// ---------- Koppeln ohne Mac: Code eingeben ----------
let pairDraft = "", pairErr = "", pairBusy = false;
const fmtCode = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12).replace(/(.{4})(?=.)/g, "$1-");
async function pair(codeIn) {
  const c = codeIn.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 12) throw new Error("Der Code hat 12 Zeichen, etwa K7QM-4TZP-WX9D");
  let r;
  try { r = await net(`pair.enc?t=${Date.now()}`, { cache: "no-store" }); } catch (e) { throw new Error(netErr(e, "Code lässt sich nicht prüfen")); }
  if (!r.ok) throw new Error("Kein gültiger Code online. Auf dem Mac einen neuen anlegen.");
  let p;
  try { p = await r.json(); } catch { throw new Error("Kein gültiger Code online. Auf dem Mac einen neuen anlegen."); }
  if (new Date(p.exp) < new Date()) throw new Error("Dieser Code ist abgelaufen.");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(c), "PBKDF2", false, ["deriveKey"]);
  const k = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(p.salt), iterations: p.it, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  let raw;
  try { raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(p.iv) }, k, b64(p.ct))); }
  catch { throw new Error("Der Code stimmt nicht."); }
  const k64 = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  store.set("k", k64);
}
document.addEventListener("input", (e) => {
  if (e.target.id !== "code") return;
  const v = fmtCode(e.target.value);
  if (v !== e.target.value) e.target.value = v;
  pairDraft = v;
  pairErr = "";
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "pair") return;
  e.preventDefault();
  vib();
  pairBusy = true; pairErr = ""; busy++; eyeAuto(); render(false);
  let ok = false;
  try {
    await pair(pairDraft);
    await load(false);
    if (!D) throw new Error(loadErr || "Verbunden, aber noch keine Daten");
    ok = true;
  } catch (err) {
    pairErr = String(err.message || err);
  }
  pairBusy = false; busy--;
  render(true);
  if (ok) flashEye("done"); else eyeState("alert");
});

// ---------- Das Auge (aus der Mac-App) ----------
// Bleibt über alle Neuzeichnungen dasselbe Element, damit Blinzeln und Blick nicht neu anfangen.
// Das Auge unten rechts bleibt über alle Neuzeichnungen dasselbe Element (Blinzeln und Blick fangen nicht neu an).
// Im Blatt und auf dem Verbinden-Bildschirm sitzt je ein eigenes.
const eyes = new Map(); // Platz (Element) → Auge
let eyeNow = "idle";
let busy = 0; // lädt oder sendet gerade
let flash = ""; // kurz „done“ nach etwas Gelungenem
let speaking = false;
function eyeState(st) {
  eyeNow = st;
  for (const [slot, e] of eyes) { if (!slot.isConnected) { e.m?.dispose?.(); eyes.delete(slot); } else e.m?.setState(st); }
}
/** Zustand des Auges aus dem, was gerade los ist */
function eyeAuto() {
  let attention = !!loadErr || (sendErr && out.length > 0);
  if (D) { const now = new Date(); attention = attention || questions(now).some((q) => askable(q, now)) || rejected.length > 0 || freshCh(now).length > 0; }
  eyeState(busy > 0 ? "thinking" : speaking ? "speaking" : flash || (attention ? "alert" : "idle"));
  const fab = $("#eyefab");
  if (fab) fab.classList.toggle("attn", attention && !busy);
}
function flashEye(st) { flash = st; eyeAuto(); setTimeout(() => { flash = ""; eyeAuto(); }, 2400); }
function placeEyes() {
  if (!window.StudiumEye) return;
  document.querySelectorAll(".eye-slot").forEach((slot) => {
    if (eyes.has(slot)) return;
    const el = document.createElement("div");
    el.className = "eye-host";
    slot.appendChild(el);
    eyes.set(slot, { m: window.StudiumEye.mount(el, Number(slot.dataset.eye) === 96 ? 96 : 48, eyeNow) });
  });
  for (const [slot, e] of eyes) if (!slot.isConnected) { e.m?.dispose?.(); eyes.delete(slot); }
}
// Sprechblase: eine Meldung, Zeichen für Zeichen wie gesprochen; Antippen führt hin
let bubble = null, bubbleT = 0, typeT = 0;
const pendingSay = [];
function say(n, now) {
  if (bubble && !now) return pendingSay.push(n);
  const el = $("#say");
  if (!el || sheet === "eye") return;
  clearTimeout(bubbleT); clearInterval(typeT);
  bubble = n;
  el.hidden = false;
  el.className = `say ${n.tone === "alert" ? "alert" : ""}`;
  const txt = el.querySelector("span");
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let i = calm ? n.short.length : 0;
  txt.textContent = n.short.slice(0, i);
  speaking = !calm; eyeAuto();
  if (!calm) typeT = setInterval(() => { i += 2; txt.textContent = n.short.slice(0, i); if (i >= n.short.length) { clearInterval(typeT); speaking = false; eyeAuto(); } }, 22);
  requestAnimationFrame(() => el.classList.add("in"));
  bubbleT = setTimeout(hush, 9000);
}
function hush() {
  const el = $("#say");
  clearTimeout(bubbleT); clearInterval(typeT);
  speaking = false;
  if (el && bubble) { el.classList.remove("in"); setTimeout(() => { if (!bubble) el.hidden = true; }, 260); }
  bubble = null;
  eyeAuto();
  if (pendingSay.length) setTimeout(() => !bubble && pendingSay.length && say(pendingSay.shift()), 700);
}
/** Von selbst melden: jede Meldung einmal (auch über einen Neustart), Rückfragen alle zwei Stunden wieder */
function speakUp() {
  if (keyOffer && !bubble) {
    const k = keyOffer; keyOffer = null;
    return say({ key: `key@${Date.now()}`, short: "Link mit einem anderen Schlüssel. Antippen verbindet neu, Wartendes geht dabei verloren", tone: "alert", adopt: k }, true);
  }
  if (!D || bubble || sheet || document.visibilityState !== "visible") return;
  const now = new Date();
  let done = {};
  try { done = JSON.parse(store.get("nudged") || "{}"); } catch { /* egal */ }
  const n = nudges(now).find((x) => !done[x.key]);
  if (n) {
    done[n.key] = Date.now();
    for (const [k, v] of Object.entries(done)) if (Date.now() - v > 14 * 864e5) delete done[k];
    store.set("nudged", JSON.stringify(done));
    return say(n);
  }
  const due = questions(now).filter((q) => askable(q, now));
  if (!due.length) return;
  let asked = {};
  try { asked = JSON.parse(store.get("asked") || "{}"); } catch { /* egal */ }
  if (Date.now() - (asked[due[0].id] || 0) < 2 * 36e5) return;
  asked[due[0].id] = Date.now();
  for (const [k, v] of Object.entries(asked)) if (Date.now() - v > 30 * 864e5) delete asked[k];
  store.set("asked", JSON.stringify(asked));
  say({ key: `frage@${due[0].id}`, short: due.length > 1 ? `${due[0].q} (noch ${due.length - 1})` : due[0].q, tone: "alert", eye: true });
}

// ---------- Darstellen ----------
const VIEWS = { heute: vHeute, woche: vWoche, fristen: vFristen, faecher: vFaecher };
let lastApp = "";
function render(animate) {
  const app = $("#app");
  const tabs = $("#tabs");
  const fab = $("#eyefab");
  if (!store.get("k") || !D) {
    app.innerHTML = hello();
    lastApp = "";
    $("#layer").innerHTML = "";
    tabs.hidden = true;
    fab.hidden = true;
    placeEyes();
    return;
  }
  tabs.hidden = false;
  fab.hidden = false;
  const now = new Date();
  if (tab !== "heute") document.documentElement.style.setProperty("--c", "var(--cyan)");
  // Nur neu aufbauen, wenn sich etwas geändert hat: sonst bräche jeder Takt laufende Bewegungen ab (Einblenden beim Start,
  // Schalter, Wischen) und setzte Gedrücktes zurück
  const html = VIEWS[tab](now);
  if (animate || html !== lastApp || !app.firstChild) {
    const stripX = $(".strip")?.scrollLeft || 0;
    app.innerHTML = lastApp = html;
    if (stripX && $(".strip")) $(".strip").scrollLeft = stripX;
    if (!animate) app.querySelectorAll(".rise").forEach((el) => el.classList.remove("rise"));
  }
  // Das Blatt liegt über allem, auch über der Leiste unten. Blätter mit Eingabe (Auge, Formular) bleiben stehen,
  // solange sie offen sind: ein Neuaufbau nähme Fokus, Text und Tastatur weg.
  // … und ein Blatt, in dem gerade „Wirklich löschen“ scharf ist, ebenfalls: sonst spränge der Knopf vor Ablauf zurück
  if ((sheet === "eye" || sheet === "form" || (sheet || "").startsWith("task:") || $("#sheet [data-armed]")) && shownSheet === sheet && $("#sheet")) paintEye();
  else $("#layer").innerHTML = renderSheet(now);
  if (!sheet) shownSheet = null;
  fab.classList.toggle("away", !!sheet);
  if (sheet && bubble) hush();
  placeEyes();
  eyeAuto();
  const idx = Object.keys(VIEWS).indexOf(tab);
  $("#pill").style.transform = `translateX(${idx * 100}%)`;
  tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
}
function go(t) {
  if (t === tab) return window.scrollTo({ top: 0, behavior: "smooth" });
  vib();
  if (t === "woche") (sel = null), (week = 0), (autoWeek = true);
  sheet = null;
  tab = t;
  store.set("tab", t);
  const run = () => (render(true), window.scrollTo(0, 0));
  document.startViewTransition ? document.startViewTransition(run) : run();
}

/** Zweimal tippen für alles, was sich nicht zurückholen lässt: erst scharf, dann ausführen (vier Sekunden Zeit) */
function armed(b, question, back) {
  if (b.dataset.armed) return true;
  b.dataset.armed = "1"; b.textContent = question;
  setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = back; } }, 4000);
  return false;
}
document.addEventListener("click", (e) => {
  if (closing) return;
  if (e.target.closest("[data-close]")) return closeSheet();
  // Der angefangene Satz bleibt stehen, bis er eingetragen oder mit × geleert ist
  if (e.target.closest("#eyebtn")) { vib(); hush(); quickOn = null; sheet = "eye"; return render(false); }
  const sayEl = e.target.closest("#say");
  if (sayEl) {
    vib();
    const n = bubble;
    hush();
    // „Erledigt: … Antippen nimmt es zurück“: der Tipp macht es rückgängig, kein Blatt
    if (n?.undo) { post(n.undo); eyeAuto(); return render(false); }
    // Neuer Schlüssel aus einem Link: jetzt übernehmen (wie neu verbinden)
    if (n?.adopt) { try { localStorage.clear(); } catch { /* egal */ } store.set("k", n.adopt); D = D0 = null; out = []; fetchedAt = 0; return load(true).then(() => render(true)); }
    // Gesehen erst, wenn der Tipp den Hinweis wirklich zeigt (ein Blatt öffnet); sonst steht er im Auge zum Lesen
    if (n?.seen && n.open && !n.eye) markSeen(n.seen);
    sheet = n?.open && !n.eye ? n.open : "eye";
    if (sheet === "eye") quickOn = null;
    return render(false);
  }
  const btn = e.target.closest("button");
  const open = e.target.closest("[data-open]");
  // Karte antippen öffnet die Details (Knöpfe in der Karte haben Vorrang)
  if (open && (!btn || btn.dataset.open)) {
    vib();
    if (open.dataset.seen) markSeen(open.dataset.seen);
    sheet = open.dataset.open; alarmHint = "";
    return render(false);
  }
  const b = btn;
  if (!b) return;
  if (b.dataset.unpair) {
    vib();
    const lose = out.length ? ` ${plural(out.length, "Eintrag geht", "Einträge gehen")} verloren.` : "";
    if (armed(b, `Wirklich trennen?${lose} Nochmal tippen`, "Verbindung trennen")) { try { localStorage.clear(); } catch { /* egal */ } D = D0 = null; out = []; fetchedAt = 0; tab = "heute"; sheet = null; try { N?.pending?.(""); } catch { /* egal */ } try { N?.forget?.(); } catch { /* ältere App */ } return render(true); }
    return;
  }
  if (b.dataset.refresh) {
    vib();
    return load(false).then(() => { render(false); paintEye(); if (!loadErr) flashEye("done"); });
  }
  // ---- Auge: eintragen
  if (b.dataset.capClear) { cap = ""; capGot = null; $("#cap").value = ""; $("#cap-out").innerHTML = capCard(); b.hidden = true; return $("#cap").focus(); }
  if (b.dataset.capEdit) { vib(); const g = capGot; return openForm({ kind: g.kind, m: g.m, date: g.date, start: g.start, end: g.end, room: g.room }, "eye"); }
  // Fach der Aufgabe wählen, statt es zu raten (zweiter Tipp auf das gewählte lässt das zuletzt benutzte)
  if (b.dataset.capMod && capGot) { vib(); capGot.m = b.dataset.capMod; capGot.got.m = true; store.set("lastMod", capGot.m); return paintEye(); }
  if (b.dataset.capSave) { const err = capGot.task ? saveTask(capGot) : saveEvent(capGot); if (!err) cap = ""; else if ($("#cap-err")) $("#cap-err").textContent = err; return; }
  // ---- Auge: Rückfragen, Hinweise, Schnellantworten
  if (b.dataset.ans || b.dataset.snooze || b.dataset.skip) {
    vib();
    const now = new Date(), id = b.dataset.ans || b.dataset.snooze || b.dataset.skip;
    const q = questions(now).find((x) => x.id === id);
    if (!q) return paintEye();
    if (b.dataset.ans) answer(q, b.dataset.a);
    else post([{ op: "question", question: b.dataset.snooze ? { id, snooze: later(now) } : { id, status: "unwichtig" } }]);
    const card = b.closest(".qc");
    if (card && !CALM()) { card.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(24px) scale(0.98)" }], { duration: 200, easing: "ease-in", fill: "forwards" }).onfinish = paintEye; }
    else paintEye();
    return eyeAuto();
  }
  if (b.dataset.seen && !b.dataset.open) { markSeen(b.dataset.seen); eyeAuto(); return paintEye(); }
  if (b.dataset.drop) { vib(); rejected = rejected.filter((x) => x.id !== b.dataset.drop); saveRej(); eyeAuto(); return paintEye(); }
  if (b.dataset.redo) {
    // Abgelehnter Termin: ins Formular, korrigieren, neu eintragen
    vib();
    const n = rejected.find((x) => x.id === b.dataset.redo), x = n?.ops?.[0]?.event;
    rejected = rejected.filter((y) => y.id !== b.dataset.redo); saveRej(); eyeAuto();
    if (!x) return paintEye();
    const known = (D0?.evs || []).some((e) => e.id === x.id);
    return openForm({ ...(known ? { id: x.id } : {}), m: x.m || "", kind: x.kind || "", date: x.date, start: x.start, end: x.end, room: x.room || "", note: x.note || "" }, "eye");
  }
  if (b.dataset.quick) { vib(); quickOn = quickOn === b.dataset.quick ? null : b.dataset.quick; return paintEye(true); }
  // ---- Formular
  if (b.dataset.fMod) { vib(); draft.m = draft.m === b.dataset.fMod ? "" : b.dataset.fMod; return paintForm(); }
  if (b.dataset.fDay !== undefined) { vib(); draft.date = b.dataset.fDay; if (!draft.date && draft.task) draft.time = ""; return paintForm(); }
  if (b.dataset.fDur) { vib(); draft.end = hmOf(Math.min(23 * 60 + 59, minsOf(draft.start) + Number(b.dataset.fDur))); return paintForm(); }
  if (b.dataset.fSave) { const err = draft.task ? saveTaskEdit(draft) : saveEvent(draft); if (err) { $("#f-err").textContent = err; if (!draft.kind.trim()) $("#f-kind").focus(); } return; }
  if (b.dataset.editTask) {
    vib();
    const x = D.tasks.find((y) => y.id === b.dataset.editTask);
    if (!x) return;
    draft = { task: true, id: x.id, m: x.m, kind: x.t, date: x.d || "", time: x.ti && x.ti !== "23:59" ? x.ti : "" };
    formFrom = null; formBase = JSON.stringify(draft); formArmed = 0; sheet = "form";
    return render(false);
  }
  // ---- Aufgaben abarbeiten
  if (b.dataset.step) {
    vib();
    const x = D.tasks.find((y) => y.id === b.dataset.tid), i = Number(b.dataset.step), s = x?.sp?.[i];
    if (!s) return;
    post([{ op: "step", id: x.id, i, text: s[0], done: !s[1] }]);
    return repaintSheet();
  }
  if (b.dataset.stepAdd) return addStep(b.dataset.stepAdd);
  if (b.dataset.taskDone) {
    vib();
    const x = D.tasks.find((y) => y.id === b.dataset.taskDone);
    if (!x) return;
    post([{ op: "taskDone", id: x.id, done: !x.done }]);
    flashEye("done");
    // In der Liste: die Zeile hakt sich ab und geht, dann rückt der Rest nach. Im Blatt: Blatt schließt sich.
    const row = b.closest(".card.dl");
    // In der Liste verschwindet die Zeile: kurz sagen, was erledigt ist, und den Weg zurück anbieten
    if (row && !x.done) say({ short: `Erledigt: ${x.t}. Antippen nimmt es zurück`, tone: "info", undo: [{ op: "taskDone", id: x.id, done: false }] }, true);
    if (row && !CALM()) {
      b.classList.add("on");
      row.animate([{ opacity: 1, transform: "none" }, { opacity: 1, transform: "none", offset: 0.45 }, { opacity: 0, transform: "translateX(28px) scale(0.98)" }], { duration: 460, easing: "ease-in", fill: "forwards" });
      return void setTimeout(() => render(false), 480); // nicht auf das Ende der Bewegung warten: im Hintergrund käme es nie
    }
    if (sheet) return x.done ? repaintSheet() : closeSheet();
    return render(false);
  }
  if (b.dataset.delTask) {
    vib();
    const lbl = b.parentElement.querySelector("span"), name = D.tasks.find((y) => y.id === b.dataset.delTask)?.t || "Aufgabe", before = lbl.textContent;
    if (!armed(b, "Wirklich löschen", "Löschen")) {
      lbl.textContent = `„${name}“ verschwindet auch am Mac`; lbl.classList.add("ask");
      return setTimeout(() => { if (lbl.isConnected) { lbl.textContent = before; lbl.classList.remove("ask"); } }, 4000);
    }
    post([{ op: "taskRemove", id: b.dataset.delTask }]);
    return closeSheet();
  }
  // ---- Anwesenheit und Vorhaben im Terminblatt (wie im Termin am Mac)
  if (b.dataset.att) {
    vib();
    const id = b.parentElement.dataset.eid, e = D.evs.find((y) => y.id === id);
    if (!e) return;
    // „Nachgeholt“ gehört zu „Nicht da“: ein Tipp darauf nimmt es zurück, statt still „verpasst“ daraus zu machen
    const cur = e.a === "nachgeholt" ? "weg" : e.a;
    if (b.dataset.att === "aus") post([{ op: "cancel", id, cancelled: !e.x }]);
    else post([...(e.x ? [{ op: "cancel", id, cancelled: false }] : []), { op: "attendance", id, value: cur === b.dataset.att && !e.x ? null : b.dataset.att }]);
    eyeAuto();
    return repaintSheet();
  }
  if (b.dataset.catch) {
    vib();
    const e = D.evs.find((y) => y.id === b.dataset.catch);
    if (!e) return;
    post([{ op: "attendance", id: e.id, value: e.a === "nachgeholt" ? "weg" : "nachgeholt" }]);
    eyeAuto();
    return repaintSheet();
  }
  // ---- Eigener Termin: ändern, löschen
  if (b.dataset.editEv) { vib(); const x = evs().find((y) => y.id === b.dataset.editEv); return x && openForm({ id: x.id, m: x.m, kind: x.k, date: x.d, start: x.s, end: x.e, room: x.r || "", note: x.n || "" }); }
  if (b.dataset.delEv) {
    vib();
    // Rückfrage am Ort: was gelöscht wird und was das heißt
    const lbl = b.parentElement.querySelector("span"), name = evs().find((y) => y.id === b.dataset.delEv)?.k || "Termin", before = lbl.textContent;
    if (!armed(b, "Wirklich löschen", "Löschen")) {
      lbl.textContent = `„${name}“ verschwindet auch am Mac`; lbl.classList.add("ask");
      return setTimeout(() => { if (lbl.isConnected) { lbl.textContent = before; lbl.classList.remove("ask"); } }, 4000);
    }
    const id = b.dataset.delEv, mine = out.filter((o) => o.ops[0]?.op === "event" && o.ops[0].event.id === id);
    // Noch gar nicht beim Mac und nichts davon je geschickt: einfach aus dem Postausgang nehmen. Ist schon etwas unterwegs,
    // muss das Löschen hinterher, sonst legt der Mac den Termin später doch an.
    if (mine.length && mine.every((o) => !o.sent) && !flushing && !D0.evs.some((y) => y.id === id)) { out = out.filter((o) => !mine.includes(o)); saveOut(); D = merged(); tellNative(); }
    else post([{ op: "eventRemove", id }]);
    return closeSheet();
  }
  if (b.dataset.pos) { vib(); store.set("alarmPos", b.dataset.pos); return render(false); }
  if (b.dataset.tab) go(b.dataset.tab);
  else if (b.dataset.week) changeWeek(Number(b.dataset.week));
  else if (b.dataset.day) { const ks = [...document.querySelectorAll("[data-day]")].map((x) => x.dataset.day); changeDay(b.dataset.day, ks.indexOf(b.dataset.day) > ks.indexOf(sel) ? 1 : -1); }
  else if (b.dataset.lead) { vib(); alarmHint = ""; setLead(Math.max(15, Math.min(240, lead() + Number(b.dataset.lead)))); store.set("alarm", ""); render(false); }
  else if (b.dataset.auto) { vib(); const st = nat(); try { N.alarmConfig(!st?.on, lead()); } catch { /* egal */ } setTimeout(() => render(false), 150); setTimeout(() => render(false), 1200); }
  else if (b.dataset.settings) { vib(); try { N.openSettings(b.dataset.settings); } catch { /* egal */ } }
  else if (b.dataset.alarm) { vib(); setAlarm(b.dataset.alarm, b.dataset.msg || "Uni"); }
});
// Tippen und Sprechen: das Auge versteht mit, das Formular merkt sich jede Angabe
let capT = 0;
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "cap") {
    cap = el.value;
    $(".cap-x").hidden = !cap;
    clearTimeout(capT);
    capT = setTimeout(() => {
      understand();
      const o = $("#cap-out");
      if (!o) return;
      const had = !!o.querySelector(".cap-card");
      o.innerHTML = capCard();
      if (had) o.querySelector(".cap-card")?.classList.add("still"); // schon da: nur der Inhalt wechselt, kein neues Einblenden
    }, 140);
    return;
  }
  if (!draft) return;
  if (el.id === "f-kind") { draft.kind = el.value; if ($("#f-err").textContent) $("#f-err").textContent = ""; }
  else if (el.id === "f-room") draft.room = el.value;
  else if (el.id === "f-note") draft.note = el.value;
  else if (el.id === "f-date" && el.value) { draft.date = el.value; paintForm(); }
  else if (el.id === "f-start" && el.value) {
    // Beginn verschieben nimmt das Ende mit: die Dauer bleibt
    const len = Math.max(15, minsOf(draft.end) - minsOf(draft.start));
    draft.start = el.value; draft.end = hmOf(Math.min(23 * 60 + 59, minsOf(el.value) + len)); paintForm();
  } else if (el.id === "f-end" && el.value) { draft.end = el.value; paintForm(); }
  else if (el.id === "f-time") { draft.time = el.value || ""; }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.tagName === "TEXTAREA") return;
  if (e.target.id === "cap") { e.preventDefault(); clearTimeout(capT); understand(); if (closing) return; if (capGot?.kind) { const err = capGot.task ? saveTask(capGot) : saveEvent(capGot); if (!err) cap = ""; else { const o = $("#cap-out"); if (o) o.innerHTML = capCard(); if ($("#cap-err")) $("#cap-err").textContent = err; } } else e.target.blur(); }
  else if (e.target.id === "stp-new") { e.preventDefault(); addStep(sheet.slice(5)); }
  else if (e.target.closest?.("#sheet") && sheet === "form") { e.preventDefault(); e.target.blur(); }
});

// Wischen in der Woche: der Tag folgt dem Finger. Loslassen jenseits der Schwelle (oder mit Schwung) wechselt den Tag,
// sonst federt er zurück. Am Rand der Woche gibt er nur wenig nach, außer es geht in die andere Woche weiter.
let sx = 0, sy = 0, st0 = 0, drag = null; // drag: null = noch offen, false = senkrecht (scrollen), true = waagerecht
const dayKeys = () => [...document.querySelectorAll("[data-day]")].map((b) => b.dataset.day);
const canGo = (dir) => { const ks = dayKeys(), i = ks.indexOf(sel) + dir; return (i >= 0 && i < ks.length) || (dir > 0 && week === 0) || (dir < 0 && week === 1); };
document.addEventListener("touchstart", (e) => {
  sx = e.touches[0].clientX; sy = e.touches[0].clientY; st0 = Date.now();
  drag = tab === "woche" && !sheet && e.target.closest("#swipe") ? null : false;
  ptrStart(e);
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (drag === false) return;
  const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
  if (drag === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    drag = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (!drag) return;
    pulling = false; // waagerecht gewischt: kein Ziehen zum Aktualisieren
    $("#page")?.getAnimations().forEach((a) => a.cancel()); // eine noch laufende Bewegung überdeckte sonst den Finger
  }
  const pg = $("#page");
  if (!pg) return;
  const x = canGo(dx < 0 ? 1 : -1) ? dx : dx * 0.28;
  pg.style.transform = `translateX(${x}px)`;
  pg.style.opacity = String(Math.max(0.35, 1 - Math.abs(x) / 320));
}, { passive: true });
document.addEventListener("touchend", (e) => {
  ptrEnd();
  if (drag !== true) return;
  drag = false;
  const pg = $("#page");
  if (!pg) return;
  const dx = e.changedTouches[0].clientX - sx, dir = dx < 0 ? 1 : -1;
  const fast = Math.abs(dx) / Math.max(1, Date.now() - st0) > 0.45 && Math.abs(dx) > 24;
  const back = () => {
    const x = canGo(dir) ? dx : dx * 0.28;
    pg.style.transform = ""; pg.style.opacity = "";
    if (!CALM()) pg.animate([{ transform: `translateX(${x}px)`, opacity: Math.max(0.35, 1 - Math.abs(x) / 320) }, { transform: "none", opacity: 1 }], { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  };
  if ((Math.abs(dx) < 64 && !fast) || !canGo(dir)) return back();
  const ks = dayKeys(), i = ks.indexOf(sel) + dir;
  if (i >= 0 && i < ks.length) return changeDay(ks[i], dir, dx);
  // Über den Rand hinaus: in die andere Woche, dort auf den ersten bzw. letzten Tag, in einer Bewegung
  pg.style.transform = ""; pg.style.opacity = "";
  changeWeek(week + dir, dir < 0);
});
// Bricht das System eine Berührung ab (Anruf, Geste vom Rand), darf nichts halb verschoben stehen bleiben
document.addEventListener("touchcancel", () => {
  drag = false; shY = null;
  const pg = $("#page"), sh = $("#sheet");
  if (pg) { pg.style.transform = ""; pg.style.opacity = ""; }
  if (sh) { sh.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)"; sh.style.transform = ""; }
  ptrEnd();
});

// Blatt nach unten wischen schließt es
let shY = null;
// Blatt nach unten wischen schließt. Es folgt dem Finger erst ab 12 px und nur, wenn die Bewegung senkrecht ist:
// ein waagerechtes Wischen über die Tage im Formular nimmt das Blatt nicht mit.
let shX = 0, shOn = false;
document.addEventListener("touchstart", (e) => {
  const s0 = e.target.closest("#sheet");
  shY = s0 && s0.scrollTop <= 0 ? e.touches[0].clientY : null;
  shX = e.touches[0].clientX; shOn = false;
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (shY === null) return;
  const dy = e.touches[0].clientY - shY, dx = e.touches[0].clientX - shX;
  if (!shOn) {
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { shY = null; return; }
    if (dy < 12) return;
    shOn = true;
  }
  const el = $("#sheet"); if (el) { el.style.transition = "none"; el.style.transform = `translateY(${Math.max(0, dy - 12)}px)`; }
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (shY === null) return;
  const d = e.changedTouches[0].clientY - shY - 12; shY = null;
  if (!shOn) return;
  const el = $("#sheet"); if (!el) return;
  el.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)";
  if (d > 90 && mayClose()) {
    if (leaveForm()) return;
    el.style.transform = "translateY(110%)"; vib(); setTimeout(() => { sheet = null; draft = null; render(false); }, 240);
  } else el.style.transform = "";
});

// Ziehen zum Aktualisieren
const ptr = Object.assign(document.createElement("div"), { className: "ptr" });
document.body.appendChild(ptr);
let pulling = false, py = 0;
function ptrStart(e) { pulling = window.scrollY <= 0 && !sheet; py = e.touches[0].clientY; }
document.addEventListener("touchmove", (e) => {
  if (!pulling) return;
  const d = Math.max(0, Math.min(90, e.touches[0].clientY - py));
  ptr.style.opacity = String(d / 70);
  ptr.style.transform = `translateY(${d - 40}px) rotate(${d * 4}deg)`;
}, { passive: true });
function ptrEnd() {
  if (!pulling) return;
  pulling = false;
  const pulled = Number(ptr.style.opacity) >= 1;
  if (!pulled) { ptr.style.opacity = "0"; ptr.style.transform = "translateY(-40px)"; return; }
  vib();
  ptr.classList.add("go");
  load(false).then(() => { ptr.classList.remove("go"); ptr.style.opacity = "0"; ptr.style.transform = "translateY(-40px)"; render(false); });
}

// Android: Zurück-Taste und Rückkehr in die App
window.__back = () => {
  if (!D) return false;
  if (sheet) { closeSheet(); return true; }
  if (bubble) { hush(); return true; }
  if (tab !== "heute") { go("heute"); return true; }
  return false;
};
// Zurück in die App: erst mit der Uhr neu zeichnen (heutiges Datum, Countdowns), dann laden; sonst stünde bis zu
// 12 Sekunden der Bildschirm von gestern da
window.__resume = () => { render(false); return load(false).then(() => { render(false); speakUp(); }); };
// Android-Widget: die App bei Heute öffnen ("heute") oder genau bei einem Termin ("ev:<id>").
// true = erledigt. false = der Stand ist noch nicht geladen, die App fragt dann gleich noch einmal.
window.__open = (what) => {
  if (!store.get("k") || !D) return false;
  const id = typeof what === "string" && what.startsWith("ev:") ? what.slice(3) : null;
  tab = "heute";
  store.set("tab", tab);
  sheet = id && evs().some((x) => x.id === id) ? "ev:" + id : null; // Termin nicht mehr im Stand: dann eben Heute
  alarmHint = "";
  render(false);
  window.scrollTo(0, 0);
  return true;
};
const scheme = matchMedia("(prefers-color-scheme: light)");
const tellTheme = () => { try { N?.theme(scheme.matches); } catch { /* egal */ } };
tellTheme();
scheme.addEventListener?.("change", tellTheme);

// Start: sofort den letzten Stand zeigen, dann frisch laden; Countdowns laufen mit
(async function start() {
  try { if (store.get("k")) N?.setKey(store.get("k")); } catch { /* egal */ }
  await fromCache();
  render(true);
  await load(false);
  render(!D ? true : false);
  setInterval(() => document.visibilityState === "visible" && D && drag !== true && (render(false), speakUp()), 30_000);
  setInterval(() => document.visibilityState === "visible" && load(false).then(() => render(false)), 5 * 60_000);
  // Wartet etwas auf den Mac, öfter nachsehen, ob es angekommen ist (der Mac holt etwa jede Minute ab)
  setInterval(() => document.visibilityState === "visible" && out.length && load(false).then(() => { render(false); paintEye(); if (Date.now() - syncedAt < 3000) flashEye("done"); }), 40_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && (render(false), load(false).then(() => { render(false); speakUp(); })));
  setTimeout(speakUp, 2500);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
