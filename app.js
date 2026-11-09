// Studium · Handy. Liest den verschlüsselten Stand der Mac-App, entschlüsselt ihn nur auf diesem Gerät und zeigt,
// was ansteht, wann und wo. Kein Bearbeiten, keine Dateien.
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
(function takeKey() {
  const m = location.hash.match(/k=([A-Za-z0-9_-]{40,})/);
  if (m) { store.set("k", m[1]); history.replaceState(null, "", location.pathname); }
})();

async function decrypt(enc) {
  const k = store.get("k");
  if (!k) throw new Error("kein Schlüssel");
  const ck = await crypto.subtle.importKey("raw", b64url(k), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, ck, b64(enc.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

let D = null;
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
  eyeState("thinking");
  try {
    const r = await fetch(`data.enc?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "Noch keine Daten hochgeladen" : `Laden fehlgeschlagen (${r.status})`);
    const txt = await r.text();
    D = await decrypt(JSON.parse(txt));
    store.set("enc", txt);
    try { N?.setKey(store.get("k")); N?.dataUpdated(txt); } catch { /* egal */ }
    fetchedAt = Date.now();
    store.set("fetchedAt", String(fetchedAt));
    loadErr = "";
  } catch (e) {
    loadErr = navigator.onLine === false ? "Offline, letzter Stand" : e.message === "kein Schlüssel" ? "" : String(e.message || e).includes("decrypt") || e.name === "OperationError" ? "Schlüssel passt nicht, bitte neu verbinden" : String(e.message || e);
  } finally {
    eyeState(loadErr ? "alert" : "idle");
  }
}
async function fromCache() {
  const enc = store.get("enc");
  if (!enc) return;
  try { D = await decrypt(JSON.parse(enc)); } catch { /* bleibt leer */ }
}

// ---------- Ableitungen ----------
const mod = (id) => D.mods.find((m) => m.id === id);
const mName = (id) => (id === "EX" ? "Prüfung" : mod(id)?.short || mod(id)?.name || id);
const mTag = (id) => { const m = mod(id); return m?.short && m.short.length <= 10 ? m.short : id; };
const cls = (id) => `m-${String(id).toLowerCase()}`;
const evs = () => D.evs.map((e) => ({ ...e, S: at(e.d, e.s), E: at(e.d, e.e) })).sort((a, b) => a.S - b.S);
const evTasks = (e) => D.tasks.filter((t) => t.k !== "nachholen" && (t.ev === e.id || (t.k === "frist" && t.m === e.m && t.d === e.d && t.ti === e.s)));
const going = (e) => !e.x && e.a !== "weg";
const deadlines = () => D.tasks.filter((t) => t.k === "frist" && !t.done && t.d && !t.ex && t.m !== "EX").map((t) => ({ ...t, at: at(t.d, t.ti || "23:59") })).filter((t) => t.at > Date.now() - 36e5).sort((a, b) => a.at - b.at);
const exams = () => D.tasks.filter((t) => (t.ex || t.m === "EX") && !t.done && t.d).map((t) => ({ ...t, at: at(t.d, t.ti || "09:00") })).filter((t) => t.at > Date.now()).sort((a, b) => a.at - b.at);
function countdown(d, now) {
  const ms = d - now, h = ms / 36e5;
  if (ms < 0) return { txt: "vorbei", cls: "" };
  if (h < 1) return { txt: `in ${minsUp(ms)} Min.`, cls: "hot" };
  if (h < 24 && key(d) === key(now)) return { txt: `heute ${hhmm(d)}`, cls: "hot" };
  if (key(d) === key(addDays(now, 1))) return { txt: `morgen ${hhmm(d)}`, cls: "hot" };
  const days = Math.round((at(key(d)) - at(key(now))) / 864e5);
  return { txt: `in ${days} T.`, cls: days <= 3 ? "soon" : "" };
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const ring = (a, n) => { const r = 10, c = 2 * Math.PI * r; return `<svg class="ring" viewBox="0 0 26 26"><circle class="bg" cx="13" cy="13" r="${r}"/><circle class="fg" cx="13" cy="13" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - (n ? a / n : 0))}"/></svg>`; };

// ---------- Bausteine ----------
function tags(e) {
  const t = [];
  if (e.x) t.push(`<span class="tag red">Fällt aus</span>`);
  else if (e.a === "weg") t.push(`<span class="tag">Nicht hin</span>`);
  if (e.p) t.push(`<span class="tag red">Pflicht</span>`);
  if (e.ex && e.m !== "EX") t.push(`<span class="tag red">Prüfung</span>`);
  if (e.o) t.push(`<span class="tag">freiwillig</span>`);
  if (e.u) t.push(`<span class="tag">unklar</span>`);
  return t.join("");
}
function taskLines(e) {
  return evTasks(e).map((t) => (t.done ? `<div class="task ok">✓ ${esc(t.t)} · bereit</div>` : `<div class="task due">● ${esc(t.t)} · offen</div>`)).join("");
}
function evRow(e, now, i) {
  const past = e.E < now, live = e.S <= now && now < e.E && going(e);
  const title = e.m === "EX" ? e.t || e.k : mName(e.m);
  const kind = e.m === "EX" ? "Prüfung" : e.k;
  return `<div class="card ev ${cls(e.m)} ${past ? "past" : ""} ${live ? "now" : ""} ${!going(e) ? "off" : ""} rise" style="--i:${i}" data-open="ev:${esc(e.id)}">
    <div class="t num"><b>${esc(e.s)}</b><span>${esc(e.e)}</span></div><div class="rail"></div>
    <div class="body"><div class="nm"><b>${esc(title)}</b><span>${esc(kind)}</span>${tags(e)}</div>
    <div class="rm">${esc(e.r || "Raum offen")}</div>${e.t && e.m !== "EX" ? `<div class="tp">${esc(e.t)}</div>` : ""}
    ${e.n ? `<div class="note">${esc(e.n)}</div>` : ""}${e.m === "EX" ? "" : taskLines(e)}</div></div>`;
}
function hero(all, now) {
  const real = (e) => going(e) && (!e.o || e.a === "da");
  const cur = all.find((e) => real(e) && e.S <= now && now < e.E) || all.find((e) => going(e) && e.S <= now && now < e.E);
  const next = all.find((e) => real(e) && e.S > now);
  const e = cur || next;
  if (!e) return `<div class="card hero rise">${alarmPill(now)}<div class="lbl">Frei</div><div class="room">Nichts mehr geplant</div><div class="what"><span>Genieß es.</span></div></div>`;
  document.documentElement.style.setProperty("--c", `var(--${String(e.m).toLowerCase()}, var(--cyan))`);
  const title = e.m === "EX" ? e.t || e.k : mName(e.m);
  const kind = e.m === "EX" ? "Prüfung" : e.k;
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
    <div class="room">${esc(e.r || "Raum offen")}</div>
    <div class="what"><b>${esc(title)}</b> <span>${esc(kind)}${e.t && e.m !== "EX" ? ` · ${esc(e.t)}` : ""}</span></div>
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
const lead = () => Number(store.get("lead") || 90);
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
  const title = p.first.m === "EX" ? p.first.t || p.first.k : mName(p.first.m);
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
  const title = e.m === "EX" ? e.t || e.k : mod(e.m)?.name || mName(e.m);
  const live = e.S <= now && now < e.E && going(e);
  const when = live ? `läuft · noch ${dur(minsUp(e.E - now))}` : e.S > now ? (key(e.S) === key(now) ? `in ${dur(minsUp(e.S - now))}` : dm(e.S)) : "vorbei";
  const ts = e.m === "EX" ? [] : evTasks(e);
  return `<div class="dt-head"><span class="dt-dot"></span><span class="dt-k">${esc(e.m === "EX" ? "Prüfung" : e.k)}</span>${tags(e)}</div>
    <div class="dt-title">${esc(title)}</div>
    <div class="dt-room">${esc(e.r || "Raum offen")}</div>
    <div class="dt-grid"><div><span>Wann</span><b class="num">${dm(e.S)} · ${esc(e.s)} bis ${esc(e.e)}</b></div><div><span>Bis dahin</span><b class="num">${esc(when)}</b></div></div>
    ${e.t && e.m !== "EX" ? `<div class="dt-row"><span>Thema</span><p>${esc(e.t)}</p></div>` : ""}
    ${e.n ? `<div class="dt-row"><span>Hinweis</span><p class="note">${esc(e.n)}</p></div>` : ""}
    ${ts.length ? `<div class="dt-row"><span>Dazu</span>${ts.map((t) => `<button class="dt-task ${t.done ? "ok" : ""}" data-open="task:${esc(t.id)}"><b>${t.done ? "✓" : "●"}</b><span>${esc(t.t)}${t.st && t.st[1] ? ` · ${t.st[0]}/${t.st[1]}` : ""}</span><i>›</i></button>`).join("")}</div>` : ""}`;
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
  else if (sheet.startsWith("ev:")) { const e = evs().find((x) => x.id === sheet.slice(3)); if (!e) return (sheet = null), ""; body = evSheet(e, now); c = cls(e.m); }
  else if (sheet.startsWith("task:")) { const t = D.tasks.find((x) => x.id === sheet.slice(5)); if (!t) return (sheet = null), ""; body = taskSheet(t, now); c = cls(t.m); }
  // Nur beim Öffnen gleitet das Blatt herein; spätere Aktualisierungen bleiben ruhig
  const still = shownSheet === sheet ? "still" : "";
  shownSheet = sheet;
  return `<div class="scrim ${still}" data-close="1"></div><div class="sheet ${c} ${still}" id="sheet"><div class="grab"></div>${body}</div>`;
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

function freshness(now) {
  if (!fetchedAt) return "";
  const m = Math.floor((now - fetchedAt) / 6e4);
  if (m < 2) return "Gerade aktualisiert";
  if (m < 60) return `Aktualisiert vor ${m} Min.`;
  const d = new Date(fetchedAt);
  return key(d) === key(now) ? `Aktualisiert um ${hhmm(d)}` : `Aktualisiert ${dm(d)} ${hhmm(d)}`;
}
function head(now, title, wd) {
  const old = !fetchedAt || Date.now() - fetchedAt > 6 * 36e5;
  const sub = loadErr ? esc(loadErr) : freshness(now);
  return `<div class="head rise"><div><div class="wd">${esc(wd)}</div><h1>${esc(title)}</h1><div class="sub"><i class="${old || loadErr ? "old" : ""}"></i>${sub}</div></div><button class="eye-slot" data-eye="48" data-refresh="1" aria-label="Aktualisieren"></button></div>`;
}

function vHeute(now) {
  const all = evs();
  const today = all.filter((e) => key(e.S) === key(now));
  let rows = "", i = 1, drawn = false;
  for (const e of today) {
    if (!drawn && e.S > now && today.some((x) => x.S <= now)) { rows += `<div class="nowline num">jetzt ${hhmm(now)}</div>`; drawn = true; }
    rows += evRow(e, now, i++);
  }
  const dls = deadlines().slice(0, 8);
  return head(now, `${now.getDate()}. ${MON[now.getMonth()]}`, `${WDL[now.getDay()]} · KW ${isoWeek(now)}`) +
    hero(all, now) +
    alarmRow(now) +
    `<div class="sec"><h2>Heute</h2><span>${plural(today.filter(going).length, "Termin", "Termine")}</span></div><div class="tl">${rows || `<div class="card empty">Heute keine Termine</div>`}</div>` +
    (dls.length ? `<div class="sec"><h2>Fristen</h2><span>${dls.length} offen</span></div><div class="strip">${dls.map((t, j) => dlCard(t, now, j)).join("")}</div>` : "");
}

function vWoche(now) {
  if (sel === null && week === 0 && (now.getDay() === 6 || now.getDay() === 0) && !evs().some((e) => e.S >= at(key(now)) && e.S < addDays(monday(now), 7))) week = 1;
  const mon = addDays(monday(now), week * 7);
  const all = evs();
  const weekend = all.some((e) => e.S >= addDays(mon, 5) && e.S < addDays(mon, 7));
  const days = Array.from({ length: weekend ? 7 : 5 }, (_, i) => addDays(mon, i));
  if (!sel || !days.some((d) => key(d) === sel)) sel = key(days.find((d) => key(d) === key(now)) || days.find((d) => d > now) || days[0]);
  const dayEv = all.filter((e) => key(e.S) === sel);
  const dls = deadlines().filter((t) => key(t.at) === sel);
  const sd = at(sel);
  return head(now, week === 0 ? "Diese Woche" : week === 1 ? "Nächste Woche" : `KW ${isoWeek(mon)}`, `${dm(mon)} bis ${dm(addDays(mon, days.length - 1))}`) +
    `<div class="seg rise"><span class="sl" style="transform:translateX(${week === 0 ? 0 : 100}%)"></span><button data-week="0" class="${week === 0 ? "on" : ""}">Diese Woche</button><button data-week="1" class="${week === 1 ? "on" : ""}">Nächste Woche</button></div>` +
    `<div class="days rise" style="--n:${days.length};--i:1">${days.map((d) => {
      const de = all.filter((e) => key(e.S) === key(d) && going(e));
      return `<button class="day ${key(d) === sel ? "on" : ""} ${key(d) === key(now) ? "today" : ""}" data-day="${key(d)}"><span class="w">${WD[d.getDay()]}</span><span class="n num">${d.getDate()}</span><span class="dots">${de.slice(0, 4).map((e) => `<i class="${cls(e.m)}"></i>`).join("")}</span></button>`;
    }).join("")}</div>` +
    `<div class="swipe" id="swipe"><div class="sec"><h2>${WDL[sd.getDay()]}</h2><span>${String(sd.getDate()).padStart(2, "0")}.${String(sd.getMonth() + 1).padStart(2, "0")}.</span></div>
    <div class="tl">${dayEv.map((e, i) => evRow(e, now, i + 2)).join("") || `<div class="card empty rise">Keine Termine</div>`}
    ${dls.map((t, i) => `<div class="card dl ${cls(t.m)} rise" style="--i:${i + 3}" data-open="task:${esc(t.id)}"><div class="big"><b class="num">${esc(t.ti && t.ti !== "23:59" ? t.ti : "ganzt.")}</b></div><div class="mid"><div class="tt">${esc(t.t)}</div><div class="sb"><span class="tag c">${esc(mTag(t.m))}</span>Frist</div></div></div>`).join("")}</div></div>`;
}
function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const n = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - n); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return Math.ceil(((t - y) / 864e5 + 1) / 7); }

function vFristen(now) {
  const dls = deadlines();
  const ex = exams();
  const soon = dls.filter((t) => t.at - now < 7 * 864e5), later = dls.filter((t) => t.at - now >= 7 * 864e5);
  const row = (t, i, exam) => {
    const days = Math.max(0, Math.round((at(key(t.at)) - at(key(now))) / 864e5));
    const c = days <= 1 ? "hot" : days <= 3 ? "soon" : "";
    return `<div class="card dl ${cls(t.m)} rise" style="--i:${i}" data-open="task:${esc(t.id)}"><div class="big ${c}"><b class="num">${days === 0 ? "heute" : days}</b><span>${days === 0 ? "" : days === 1 ? "Tag" : "Tage"}</span></div>
      <div class="mid"><div class="tt">${esc(exam && t.m !== "EX" ? mName(t.m) : t.t)}</div><div class="sb">${exam ? "" : `<span class="tag c">${esc(mTag(t.m))}</span>`}<span class="num">${dm(t.at)}${t.ti && t.ti !== "23:59" ? ` ${esc(t.ti)}` : ""}</span>${t.st && t.st[1] ? `<span class="prog">${ring(t.st[0], t.st[1])}<span class="num">${t.st[0]}/${t.st[1]}</span></span>` : ""}</div>
      ${exam && t.det ? `<div class="sb">${esc(t.det)}</div>` : ""}</div></div>`;
  };
  let i = 1;
  return head(now, "Fristen", `${dls.length} offen · ${plural(ex.length, "Prüfung", "Prüfungen")}`) +
    (soon.length ? `<div class="sec"><h2>Nächste 7 Tage</h2></div>${soon.map((t) => row(t, i++)).join("")}` : "") +
    (later.length ? `<div class="sec"><h2>Später</h2></div>${later.map((t) => row(t, i++)).join("")}` : "") +
    (!dls.length ? `<div class="card empty rise">Keine offenen Fristen</div>` : "") +
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
  const r = await fetch(`pair.enc?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error("Kein gültiger Code online. Auf dem Mac einen neuen anlegen.");
  const p = await r.json();
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
  pairBusy = true; pairErr = ""; eyeState("thinking"); render(false);
  try {
    await pair(pairDraft);
    await load(false);
    if (!D) throw new Error(loadErr || "Verbunden, aber noch keine Daten");
    eyeState("done"); setTimeout(() => eyeState("idle"), 2400);
  } catch (err) {
    pairErr = String(err.message || err);
    eyeState("alert");
  }
  pairBusy = false;
  render(true);
});

// ---------- Das Auge (aus der Mac-App) ----------
// Bleibt über alle Neuzeichnungen dasselbe Element, damit Blinzeln und Blick nicht neu anfangen.
const eyes = {};
let eyeNow = "idle";
function eyeState(st) {
  eyeNow = st;
  for (const e of Object.values(eyes)) e.m?.setState(st);
}
function placeEyes() {
  document.querySelectorAll(".eye-slot").forEach((slot) => {
    const size = Number(slot.dataset.eye);
    if (!window.StudiumEye) return;
    if (!eyes[size]) {
      const el = document.createElement("div");
      el.className = "eye-host";
      eyes[size] = { el, m: window.StudiumEye.mount(el, size, eyeNow) };
    }
    slot.appendChild(eyes[size].el);
  });
}

// ---------- Darstellen ----------
const VIEWS = { heute: vHeute, woche: vWoche, fristen: vFristen, faecher: vFaecher };
function render(animate) {
  const app = $("#app");
  const tabs = $("#tabs");
  if (!store.get("k") || !D) {
    app.innerHTML = hello();
    $("#layer").innerHTML = "";
    tabs.hidden = true;
    placeEyes();
    return;
  }
  tabs.hidden = false;
  const now = new Date();
  if (tab !== "heute") document.documentElement.style.setProperty("--c", "var(--cyan)");
  const stripX = $(".strip")?.scrollLeft || 0;
  app.innerHTML = VIEWS[tab](now);
  if (stripX && $(".strip")) $(".strip").scrollLeft = stripX;
  // Das Blatt liegt über allem, auch über der Leiste unten
  $("#layer").innerHTML = renderSheet(now);
  if (!sheet) shownSheet = null;
  if (!animate) app.querySelectorAll(".rise").forEach((el) => el.classList.remove("rise"));
  placeEyes();
  const idx = Object.keys(VIEWS).indexOf(tab);
  $("#pill").style.transform = `translateX(${idx * 100}%)`;
  tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
}
function go(t) {
  if (t === tab) return window.scrollTo({ top: 0, behavior: "smooth" });
  vib();
  if (t === "woche") (sel = null), (week = 0);
  sheet = null;
  tab = t;
  store.set("tab", t);
  const run = () => (render(true), window.scrollTo(0, 0));
  document.startViewTransition ? document.startViewTransition(run) : run();
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) { sheet = null; return render(false); }
  const btn = e.target.closest("button");
  const open = e.target.closest("[data-open]");
  // Karte antippen öffnet die Details (Knöpfe in der Karte haben Vorrang)
  if (open && (!btn || btn.dataset.open)) { vib(); sheet = open.dataset.open; alarmHint = ""; return render(false); }
  const b = btn;
  if (!b) return;
  if (b.dataset.unpair) {
    vib();
    if (b.dataset.armed) { try { localStorage.clear(); } catch { /* egal */ } D = null; fetchedAt = 0; tab = "heute"; sheet = null; return render(true); }
    b.dataset.armed = "1"; b.textContent = "Wirklich trennen? Nochmal tippen";
    return setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Verbindung trennen"; } }, 4000);
  }
  if (b.dataset.refresh) {
    vib();
    return load(false).then(() => { render(false); if (!loadErr) { eyeState("done"); setTimeout(() => eyeState("idle"), 2400); } });
  }
  if (b.dataset.pos) { vib(); store.set("alarmPos", b.dataset.pos); return render(false); }
  if (b.dataset.tab) go(b.dataset.tab);
  else if (b.dataset.week) { vib(); week = Number(b.dataset.week); sel = null; render(true); }
  else if (b.dataset.day) { vib(); sel = b.dataset.day; render(true); }
  else if (b.dataset.lead) { vib(); alarmHint = ""; setLead(Math.max(15, Math.min(240, lead() + Number(b.dataset.lead)))); store.set("alarm", ""); render(false); }
  else if (b.dataset.auto) { vib(); const st = nat(); try { N.alarmConfig(!st?.on, lead()); } catch { /* egal */ } setTimeout(() => render(false), 150); setTimeout(() => render(false), 1200); }
  else if (b.dataset.settings) { vib(); try { N.openSettings(b.dataset.settings); } catch { /* egal */ } }
  else if (b.dataset.alarm) { vib(); setAlarm(b.dataset.alarm, b.dataset.msg || "Uni"); }
});

// Wischen in der Woche: Tag vor und zurück
let sx = 0, sy = 0;
document.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; ptrStart(e); }, { passive: true });
document.addEventListener("touchend", (e) => {
  ptrEnd();
  if (tab !== "woche" || !e.target.closest("#swipe")) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  const btns = [...document.querySelectorAll("[data-day]")];
  const i = btns.findIndex((b) => b.dataset.day === sel) + (dx < 0 ? 1 : -1);
  if (i >= 0 && i < btns.length) { vib(); sel = btns[i].dataset.day; render(true); }
  else if (dx < 0 && week === 0) { week = 1; sel = null; render(true); }
  else if (dx > 0 && week === 1) { week = 0; sel = null; render(true); }
});

// Blatt nach unten wischen schließt es
let shY = null;
document.addEventListener("touchstart", (e) => { const s0 = e.target.closest("#sheet"); shY = s0 && s0.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (shY === null) return;
  const d = Math.max(0, e.touches[0].clientY - shY);
  const el = $("#sheet"); if (el) { el.style.transition = "none"; el.style.transform = `translateY(${d}px)`; }
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (shY === null) return;
  const d = e.changedTouches[0].clientY - shY; shY = null;
  const el = $("#sheet"); if (!el) return;
  el.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)";
  if (d > 90) { el.style.transform = "translateY(110%)"; vib(); setTimeout(() => { sheet = null; render(false); }, 240); }
  else el.style.transform = "";
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
  if (sheet) { sheet = null; render(false); return true; }
  if (tab !== "heute") { go("heute"); return true; }
  return false;
};
window.__resume = () => load(false).then(() => render(false));
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
  setInterval(() => document.visibilityState === "visible" && D && render(false), 30_000);
  setInterval(() => document.visibilityState === "visible" && load(false).then(() => render(false)), 5 * 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load(false).then(() => render(false)));
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
