// Studium · Handy. Das Auge versteht einen Satz: „Gruppentreffen Mittwoch 14 Uhr Bib“ wird zu Name, Tag, Zeit, Fach und Ort.
// Rein rechnerisch, ohne Netz und ohne KI. Was nicht erkannt wird, bekommt eine vernünftige Annahme und ist als solche
// markiert (got.*), damit die Karte zeigen kann, was verstanden und was nur angenommen wurde.
"use strict";
(function (root) {
  const WDAYS = [
    ["sonntag", "so"], ["montag", "mo"], ["dienstag", "di"], ["mittwoch", "mi"], ["donnerstag", "do"], ["freitag", "fr"], ["samstag", "sa"],
  ];
  const WD_ANY = "montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag";
  const MONTHS = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
  // Wörter, die fast immer ein Ort sind, auch ohne „in“ davor
  const PLACES = "bib|bibliothek|thulb|mensa|cafeteria|caf[eé]|online|zoom|teams|discord|webex|bbb|campus|eap|cz3|uhg|foyer|labor|pc-?pool|pool";
  // Nach diesen Wörtern ist eine Zahl eine Nummer, keine Uhrzeit („Übungsblatt 8“)
  const COUNTED = "blatt|übungsblatt|aufgabenblatt|übung|kapitel|aufgabe|teil|serie|gruppe|woche|vorlesung|folie|folien|seite|seiten|zettel|lektion|tutorium|nr|nr\\.|nummer|termin|sitzung|raum";
  // Nach der Zahl ein gezähltes Ding: „mit 10 Leuten“ ist keine Uhrzeit
  const COUNT_NOUN = "leute|leuten|personen|teilnehmer|seiten|folien|aufgaben|kapitel|stück|euro|€";
  const MON_SHORT = ["jan", "feb", "mär|mrz|maer", "apr", "mai", "jun", "jul", "aug", "sep|sept", "okt", "nov", "dez"];
  const pad = (n) => String(n).padStart(2, "0");
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const DAY_END = 23 * 60 + 59;
  // Uhrzeit aus Stunde und Minute; eine Zahl von 1 bis 6 ohne Zusatz meint am Nachmittag (um 3 = 15 Uhr)
  const clock = (h, mi, loose) => {
    h = Number(h); mi = Number(mi || 0);
    if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
    if (loose && h >= 1 && h <= 6) h += 12;
    return h * 60 + mi;
  };

  /**
   * text: was getippt oder gesprochen wurde · now: jetzt · mods: [{id, name, short}] · base: Tag, der gilt, wenn keiner genannt ist (JJJJ-MM-TT)
   * → { kind, m, date, start, end, room, got: { date, time, end, m, room } }
   */
  function verstehen(text, now, mods, base, task) {
    let s = ` ${String(text || "").replace(/\s+/g, " ").trim()} `;
    // pm: eine Stunde von 1 bis 6 ohne Zusatz wurde als Nachmittag gelesen (eine Annahme, die Karte zeigt sie gepunktet)
    const got = { date: false, time: false, end: false, m: false, room: false, pm: false };
    // „früh“, „morgens“: dann ist 6 Uhr 6 Uhr, nicht 18 Uhr
    let early = /\s(?:früh|morgens|vormittags?)(?=[\s,.]|$)/i.test(s);
    const cut = (re) => { const m = s.match(re); if (m) s = s.replace(m[0], " "); return m; };
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // ---- Ort mit festem Muster zuerst, damit „Raum 2“ nicht als Uhrzeit endet
    let room = "";
    const fixed = s.match(/\s((?:raum|hs|sr|h[oö]rsaal|seminarraum)\s?\.?\s?[a-z]?\d+[a-z]?(?:\.\d+)?)(?=[\s,.]|$)/i);
    let fixedRoom = "";
    if (fixed) { fixedRoom = fixed[1].trim(); s = s.replace(fixed[1], " \u0001 "); }

    let date = null, start = null, end = null;
    let m;

    // ---- „in 20 Minuten“, „in einer Stunde“: von jetzt an gerechnet (auf fünf Minuten)
    let rel = null;
    if ((m = cut(/\sin\s(\d{1,3})\s?(?:min|minuten)\.?(?=[\s,.]|$)/i))) rel = Number(m[1]);
    else if ((m = cut(/\sin\s(?:einer|1)\shalben\s(?:std|stunde)\.?(?=[\s,.]|$)/i))) rel = 30;
    else if ((m = cut(/\sin\s(\d(?:[.,]\d)?|einer|eine|zwei|drei)\s?(?:std|stunden?)\.?(?=[\s,.]|$)/i))) rel = Math.round((({ einer: 1, eine: 1, zwei: 2, drei: 3 })[m[1].toLowerCase()] || Number(m[1].replace(",", "."))) * 60);
    if (rel !== null && rel > 0) {
      const t = Math.ceil((nowMin + rel) / 5) * 5; // die Uhrzeit auf fünf Minuten, nicht der Abstand
      date = addDays(today, Math.floor(t / 1440));
      start = t % 1440;
      got.date = got.time = true;
    }

    // ---- Tag
    const dayWord = new RegExp(`\\s(?:heute|morgen|übermorgen|uebermorgen|${WD_ANY})(?=[\\s,.]|$)`, "i").test(s);
    if (!date) {
      // „18. November“, wie die Spracheingabe es schreibt
      const mn = s.match(new RegExp(`\\s(?:am\\s|den\\s)?(\\d{1,2})\\.?\\s(${MONTHS.join("|")}|${MON_SHORT.join("|")})\\.?(?:\\s(\\d{4}))?(?=[\\s,.]|$)`, "i"));
      // „18.11.“ ist ein Datum, „18.30 Uhr“ eine Uhrzeit: nur gültige Monate, nie wenn „Uhr“ folgt. Steht schon ein Tag im Satz
      // („morgen 8.10“), ist eine Zahl ohne Schlusspunkt die Uhrzeit.
      const dm = s.match(/\s(?:am\s|den\s)?(\d{1,2})\.\s?(\d{1,2})(\.)?(?:(\d{2})(?=[\s,]|$)|\s?(\d{4}))?(?=[\s,]|$)(?!\s?(?:uhr|h)(?=[\s,.]|$))/i);
      // „am 25.“: Tag ohne Monat, in diesem Monat (ist er schon länger vorbei, im nächsten)
      const dayOnly = s.match(/\s(?:am|den)\s(\d{1,2})\.(?=[\s,]|$)(?!\s?\d)/i);
      const pick = (dd, mm, yy, hit) => {
        const y = yy ? (String(yy).length === 2 ? 2000 + Number(yy) : Number(yy)) : now.getFullYear();
        let d = new Date(y, mm - 1, dd);
        // Ohne Jahr: knapp vergangene Tage (bis 14 zurück) bleiben in diesem Jahr, erst ältere meinen das nächste
        if (!yy && d < addDays(today, -14)) d = new Date(y + 1, mm - 1, dd);
        if (d.getDate() !== dd) return;
        s = s.replace(hit, " ");
        date = d;
      };
      const monthOf = (w) => {
        const l = w.toLowerCase();
        const i = MONTHS.indexOf(l);
        return i >= 0 ? i + 1 : MON_SHORT.findIndex((x) => new RegExp(`^(?:${x})$`).test(l)) + 1;
      };
      if (mn && Number(mn[1]) >= 1 && Number(mn[1]) <= 31 && monthOf(mn[2]) > 0) pick(Number(mn[1]), monthOf(mn[2]), mn[3], mn[0]);
      else if (dm && Number(dm[2]) >= 1 && Number(dm[2]) <= 12 && Number(dm[1]) >= 1 && Number(dm[1]) <= 31 && (dm[3] || dm[4] || dm[5] || !dayWord)) pick(Number(dm[1]), Number(dm[2]), dm[4] || dm[5], dm[0]);
      else if (dayOnly && Number(dayOnly[1]) >= 1 && Number(dayOnly[1]) <= 31) {
        const dd = Number(dayOnly[1]);
        let d = new Date(today.getFullYear(), today.getMonth(), dd);
        if (d < addDays(today, -14) || d.getDate() !== dd) d = new Date(today.getFullYear(), today.getMonth() + 1, dd);
        if (d.getDate() === dd) { s = s.replace(dayOnly[0], " "); date = d; }
      }
    }
    const afterNext = !!cut(/\s(?:in\sder\s)?übern[aä]chste[nr]?\swoche(?=[\s,.]|$)/i);
    const nextWeek = afterNext || !!cut(/\s(?:in\sder\s)?n[aä]chste[nr]?\swoche(?=[\s,.]|$)/i);
    const mondayNext = addDays(addDays(today, (8 - (today.getDay() || 7)) % 7 || 7), afterNext ? 7 : 0);
    if (!date) {
      for (let i = 0; i < 7 && !date; i++) {
        const [long, short] = WDAYS[i];
        const re = new RegExp(`\\s(?:am\\s|an\\s|diesen\\s|kommenden\\s|n[aä]chsten\\s|n[aä]chste\\s)?(${long}|${short})(s|\\.)?(?=[\\s,]|$)`, "i");
        const hit = s.match(re);
        if (!hit) continue;
        // Kürzel nur als eigenes Wort und nicht, wenn es klein mitten im Satz ein anderes Wort sein kann („so“, „do“, „mi“)
        if (hit[1].length === 2 && hit[1] !== hit[1][0].toUpperCase() + hit[1][1] && !/^\s(?:am|an)\s/i.test(hit[0])) continue;
        // „Freitag morgen“: hier ist „morgen“ die Tageszeit, nicht der Tag danach
        if (new RegExp(`${esc(hit[0])}\\s(?:morgens?|früh|vormittags?)(?=[\\s,.]|$)`, "i").test(s)) early = true;
        s = s.replace(new RegExp(`(${esc(hit[0])})\\s(?:morgens?|früh|vormittags?)(?=[\\s,.]|$)`, "i"), "$1");
        s = s.replace(hit[0], " ");
        const next = /n[aä]chste/i.test(hit[0]);
        let diff = (i - today.getDay() + 7) % 7;
        if (diff === 0 && next) diff = 7;
        date = nextWeek ? addDays(mondayNext, (i + 6) % 7) : addDays(today, diff);
        date._wd = !nextWeek;
      }
    }
    if (!date && (m = cut(/\s(heute|morgen|übermorgen|uebermorgen|gestern)(?=[\s,.]|$)/i))) {
      const w = m[1].toLowerCase();
      date = addDays(today, w === "heute" ? 0 : w === "morgen" ? 1 : w === "gestern" ? -1 : 2);
    } else if (!date && (m = cut(/\sin\s(\d{1,2})\stagen?(?=[\s,.]|$)/i))) {
      date = addDays(today, Number(m[1]));
    } else if (!date && (m = cut(/\sin\s(\d{1,2}|einer|zwei|drei|vier)\swochen?(?=[\s,.]|$)/i))) {
      date = addDays(today, 7 * (({ einer: 1, zwei: 2, drei: 3, vier: 4 })[m[1].toLowerCase()] || Number(m[1])));
    } else if (!date && nextWeek) {
      date = mondayNext; // nur „nächste Woche“: deren Montag
    }
    if (date) got.date = true;
    // „Di 17.11.“: der Wochentag neben dem Datum gehört nicht in den Namen
    if (date && !date._wd) s = s.replace(new RegExp(`\\s(?:${WD_ANY}|Mo|Di|Mi|Do|Fr|Sa|So)\\.?,?(?=\\s)`), " ");

    // ---- Tageszeit: „abends um 8“ ist 20 Uhr
    const late = !!cut(/\s(?:am\s)?(?:abend|abends|nachmittag|nachmittags)(?=[\s,.]|$)/i);
    cut(/\s(?:am\s)?(?:morgens|vormittag|vormittags|früh)(?=[\s,.]|$)/i);

    // ---- Zeit: erst Spannen, dann einzelne Uhrzeiten, dann eine Dauer
    const T = "(\\d{1,2})(?:[:.](\\d{2}))?";
    // Eine Stunde von 1 bis 6 meint den Nachmittag, außer mit „früh“, führender Null („06 Uhr“) oder Minuten („6:00“)
    const loose = (h, mi) => !early && !/^0/.test(String(h)) && !mi;
    const pmMark = (h, mi) => { if (loose(h, mi) && Number(h) >= 1 && Number(h) <= 6) got.pm = true; };
    if (start === null) {
      // Spannen: bei Aufgaben nur mit „von, ab, um“ oder „Uhr“ („Kapitel 3 bis 5 lesen“ ist keine Uhrzeit)
      const span = task ? `\\s(?:von\\s|ab\\s|um\\s)${T}\\s?(?:uhr)?\\s?(?:-|–|bis)\\s?${T}\\s?(?:uhr)?(?=[\\s,.]|$)` : `\\s(?:von\\s|ab\\s|um\\s)?${T}\\s?(?:uhr)?\\s?(?:-|–|bis)\\s?${T}\\s?(?:uhr)?(?=[\\s,.]|$)`;
      if ((m = s.match(new RegExp(span, "i"))) && !new RegExp(`(?:^|\\s)(?:${COUNTED})$`, "i").test(s.slice(0, m.index).trimEnd())) {
        s = s.replace(m[0], " ");
        const a = clock(m[1], m[2], loose(m[1], m[2])), b = clock(m[3], m[4], loose(m[3], m[4]));
        pmMark(m[1], m[2]);
        if (a !== null && b !== null) {
          start = a;
          end = b > a ? b : b + 12 * 60 > a && b + 12 * 60 <= 24 * 60 ? b + 12 * 60 : null;
          // Über Mitternacht („22 bis 2 Uhr“): bis Tagesende, als Annahme
          if (end === null && b < a) end = DAY_END;
          else got.end = end !== null;
        }
      } else if ((m = cut(/\s(?:um\s)?halb\s(\d{1,2}|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)(?=[\s,.]|$)/i))) {
        const words = ["", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf"];
        let h = /\d/.test(m[1]) ? Number(m[1]) : words.indexOf(m[1].toLowerCase());
        if (h >= 1 && h <= 24) { h -= 1; start = clock(h === 0 ? 12 : h, 30, !early); }
      } else if ((m = cut(/\s(?:um\s)?viertel\s(nach|vor)\s(\d{1,2})(?=[\s,.]|$)/i))) {
        // „viertel nach 3“ ist 15:15, „viertel vor 4“ 15:45
        const h = Number(m[2]);
        const base = clock(h, 0, loose(m[2], 0));
        if (base !== null) { pmMark(m[2], 0); start = m[1].toLowerCase() === "nach" ? base + 15 : base - 15; }
      } else if ((m = cut(new RegExp(`\\s(?:um\\s|ab\\s)?${T}\\s?uhr(?:\\s([0-5]\\d)(?!\\s?(?:min|std|stunden?|h)))?(?=[\\s,.]|$)`, "i")))) {
        start = clock(m[1], m[2] || m[3], loose(m[1], m[2] || m[3])); // auch „14 Uhr 30“
        pmMark(m[1], m[2] || m[3]);
      } else if ((m = s.match(/\s(?:um\s|ab\s)?(\d{1,2})\s?h(?=[\s,.]|$)/i)) && Number(m[1]) >= 7) {
        s = s.replace(m[0], " "); // „14h“ ist eine Uhrzeit, „2h“ bleibt eine Dauer
        start = clock(m[1], 0, false);
      } else if ((m = cut(/\s(?:um\s|ab\s)?(\d{1,2})[:.](\d{2})(?=[\s,]|$)/))) {
        start = clock(m[1], m[2], false);
      } else if ((m = cut(/\s(?:um|ab)\s(\d{1,2})(?=[\s,.]|$)/i))) {
        start = clock(m[1], 0, loose(m[1], 0));
        pmMark(m[1], 0);
      } else if (!task && (m = s.match(new RegExp(`(?<!\\s(?:${COUNTED}))\\s(\\d{1,2})(?=[\\s,]|$)(?!\\s(?:${COUNT_NOUN})(?=[\\s,.]|$))`, "i"))) && Number(m[1]) >= 7 && Number(m[1]) <= 22) {
        // Eine nackte Zahl zwischen 7 und 22 („Mittwoch 14“) ist die Uhrzeit, außer sie zählt etwas („Blatt 8“)
        s = s.replace(m[0], " ");
        start = clock(m[1], 0, false);
      }
      if (start !== null && late && start < 12 * 60) start += 12 * 60;
      // „abends 8 bis 10“: auch das Ende am Abend
      if (end !== null && late && end < 12 * 60) end += 12 * 60;
      if (start !== null) got.time = true;
    }
    let durMin = null;
    if ((m = cut(/\s(?:für\s)?(\d{1,3})\s?(?:min|minuten)\.?(?=[\s,.]|$)/i))) durMin = Number(m[1]);
    else if ((m = cut(/\s(?:für\s)?(\d(?:[.,]\d)?)\s?(?:std|stunden?|h)\.?(?=[\s,.]|$)/i))) durMin = Math.round(Number(m[1].replace(",", ".")) * 60);
    else if (cut(/\s(?:für\s)?(?:anderthalb|eineinhalb)\s(?:std|stunden?)\.?(?=[\s,.]|$)/i)) durMin = 90;
    else if (cut(/\s(?:für\s)?eine\s(?:std|stunde)\.?(?=[\s,.]|$)/i)) durMin = 60;
    else if ((m = cut(/\s(?:für\s)?(zwei|drei|vier)\s(?:std|stunden)\.?(?=[\s,.]|$)/i))) durMin = ({ zwei: 2, drei: 3, vier: 4 })[m[1].toLowerCase()] * 60;
    if (start !== null && end === null && durMin) { end = Math.min(DAY_END, start + durMin); got.end = true; }

    // ---- Fach: Kürzel groß geschrieben oder der Name, als ganzes Wort
    let mod = "";
    for (const x of mods || []) {
      if (x.id === "EX") continue;
      const names = [x.name, x.short].filter(Boolean).sort((a, b) => b.length - a.length);
      let hit = null;
      for (const n of names) if ((hit = s.match(new RegExp(`\\s(${esc(n)})(?=[\\s,.]|$)`, "i")))) break;
      if (!hit) hit = s.match(new RegExp(`\\s(${esc(x.id)})(?=[\\s,.]|$)`, x.id.length >= 3 ? "i" : ""));
      if (hit) { mod = x.id; got.m = true; s = s.replace(hit[1], " "); break; }
    }

    // ---- Ort: „im/in der/bei …“ (bis „mit/und/für“ oder zum Satzende), „in“ nur vor einem bekannten Ort, sonst ein
    // bekanntes Ortswort für sich. Nie der ganze Rest des Satzes: „Bib lernen“ ist Lernen in der Bib.
    let roomFirst = false;
    // Bei Aufgaben gibt es keinen Ort: „Bücher in die Bib zurückbringen“ bleibt ganz im Namen
    if (!task && ((m = s.match(/\s(?:in\sder|in\sdem|im|bei|beim|@)\s(.+?)(?=\s(?:mit|und|für|wegen)\s|\s*$)/i)) ||
        (m = s.match(new RegExp(`\\sin\\s((?:${PLACES}|\\u0001)(?:\\s+\\u0001)?)(?=[\\s,.]|$)`, "i"))) ||
        (m = s.match(new RegExp(`\\s((?:${PLACES})(?:\\s+\\u0001)?)(?=[\\s,.]|$)`, "i"))))) {
      room = m[1]; roomFirst = !s.slice(0, m.index).trim(); s = s.replace(m[0], " ");
    }
    if (fixedRoom) {
      if (room.includes("\u0001")) room = room.replace("\u0001", fixedRoom);
      else room = room ? `${room} ${fixedRoom}` : fixedRoom;
      s = s.replace("\u0001", " ");
    }
    room = room.replace(/\u0001/g, "").replace(/\s+/g, " ").replace(/^[,.\s]+|[,.\s]+$/g, "");
    if (room) { got.room = true; if (/^[a-zäöü]/.test(room) && !/^online$/i.test(room)) room = room[0].toUpperCase() + room.slice(1); }

    // ---- Name: was übrig bleibt, ohne lose Füllwörter am Rand
    let kind = s.replace(/\u0001/g, " ").replace(/\s+/g, " ").trim().replace(/^(?:termin\s*:?\s*|neuer termin\s*:?\s*)/i, "").replace(/^[,.\-–:\s]+|[,.\-–:\s]+$/g, "");
    for (let i = 0; i < 3; i++) kind = kind.replace(/\s(?:am|um|von|bis|ab|mit|für|und|in|im)$/i, "").replace(/^(?:am|um|von|bis|ab)\s/i, "").trim();
    // Beginnt der Satz mit dem Ort und bleibt kein eigener Name („Mensa mit Tim“), heißt der Termin wie sein Ort
    if (room && roomFirst && /^(?:mit|und)\s/i.test(kind)) kind = `${room} ${kind}`.trim();
    if (!kind && room) kind = room; // nur ein Ort genannt („Mensa in einer Stunde“): der Termin heißt wie der Ort
    if (kind) kind = kind[0].toUpperCase() + kind.slice(1);

    // ---- Annahmen für alles, was fehlt
    if (start === null) {
      start = Math.min(20 * 60, Math.max(8 * 60, Math.ceil((nowMin + 5) / 60) * 60));
      if (date && key(date) !== key(today)) start = 10 * 60;
    }
    if (end === null || end <= start) end = Math.min(DAY_END, start + (durMin || 60));
    // „um 23:59“: kein Platz für ein Ende danach. Dann beginnt er 15 Minuten vorher, als Annahme gepunktet
    if (end <= start) { start = Math.max(0, end - 15); got.time = false; }
    if (!date) {
      date = base ? new Date(Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1, Number(base.slice(8, 10))) : today;
      // Ohne Tag und die Uhrzeit ist heute schon vorbei: dann ist morgen gemeint
      if (key(date) === key(today) && got.time && start <= nowMin) date = addDays(today, 1);
    } else if (date._wd && key(date) === key(today) && got.time && start <= nowMin) {
      date = addDays(date, 7); // „Mittwoch 10 Uhr“, am Mittwochnachmittag gesagt: der nächste
    }
    return { kind, m: mod, date: key(date), start: hm(start), end: hm(end), room, got };
  }

  root.StudiumVerstehen = verstehen;
  if (typeof module !== "undefined" && module.exports) module.exports = verstehen;
})(typeof window !== "undefined" ? window : globalThis);
