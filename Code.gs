/**
 * Road to 80 — Google Apps Script API, v3 (calendar days + timestamped entries).
 *
 * DATA MODEL
 *  "Entries" tab  — append-only event log. One row per thing you log (a dosa, a walk, a weight…).
 *                   The app can only append here. Fix mistakes by editing/deleting rows by hand.
 *  "Daily" tab    — derived summary, one row per calendar day (Asia/Singapore, 00:00:00–23:59:59).
 *                   Rebuilt automatically after every log and whenever you edit "Entries" by hand.
 *                   Never edit "Daily"; your changes would be overwritten.
 *  "Logs" tab     — the old one-row-per-shift sheet from v2. Left untouched. Run
 *                   `migrateLegacyLogs` once to copy its history into "Entries".
 *
 * SETUP / UPGRADE (details in DEPLOY.md)
 *  1. Paste this file over Code.gs. Project Settings → Time zone: Asia/Singapore.
 *  2. Run `setup` once. It creates "Entries" + "Daily" and keeps your existing API_TOKEN.
 *  3. Optional: run `migrateLegacyLogs` once to bring v2 history across.
 *  4. Deploy → Manage deployments → ✎ → Version: New version → Deploy (same /exec URL).
 *
 * API: POST text/plain JSON { token, action, ... }  (token in body: Apps Script cannot read headers)
 *   ping                         → { status }
 *   log      { entries:[…] }     → appends new entries (idempotent by id) → returns summary
 *   summary                      → { profile, days[], recent{date:[entries]}, totals, today }
 *   day      { date }            → { entries } for one date
 *   setProfile { profile }       → saves height/age/gender/start/goal → returns summary
 */

const CONFIG = {
  TZ: 'Asia/Singapore',
  KCAL_PER_KG: 7700,
  RECENT_DAYS: 8,                 // entries returned inline for today + the 7 days before (covers offline catch-up)
  PROFILE_DEFAULT: {
    heightCm: 167.64,             // 5'6"
    age: 32,
    gender: 'male',               // 'male' | 'female'  (Mifflin-St Jeor +5 / -161)
    startKg: 110,
    goalKg: 80,
    stepKcalPerKgPerStep: 0.0004  // 10,000 steps ≈ 440 kcal at 110 kg, ≈ 320 kcal at 80 kg
  }
};

const ENTRY_SHEET = 'Entries';
const DAILY_SHEET = 'Daily';
const ENTRY_HEADERS = ['Entry_ID', 'Logged_At', 'Date', 'Time', 'Type', 'Item', 'Qty', 'Kcal_Each', 'Kcal', 'Value', 'Value2', 'Note', 'Source'];
const DAILY_HEADERS = ['Date', 'Weight_kg', 'Weight_Used_kg', 'Food_kcal', 'Steps', 'Step_kcal', 'Workout_kcal', 'BMR_kcal',
  'Burned_kcal', 'Deficit_kcal', 'Counted', 'Cumulative_Deficit_kcal', 'Water_L', 'Systolic', 'Diastolic', 'Day_Tag', 'Entries', 'Updated_At'];
const TYPES = ['food', 'steps', 'workout', 'weight', 'bp', 'water', 'tag', 'note'];
const TAGS = ['Normal', 'Rest', 'Sick'];

/* ======================= entry points ======================= */

function doGet() {
  return json_({ status: 'ok', service: 'road-to-80', version: 3 });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!tokenOk_(body.token)) return json_({ status: 'error', code: 'unauthorized', error: 'Wrong or missing token' });
    switch (body.action) {
      case 'ping':       return json_({ status: 'success', version: 3 });
      case 'summary':    return json_(Object.assign({ status: 'success' }, summary_()));
      case 'day':        return json_({ status: 'success', entries: entriesForDate_(String(body.date || '')) });
      case 'log':        return json_(logEntries_(body.entries || []));
      case 'setProfile': saveProfile_(body.profile || {}); rebuildDaily_(); return json_(Object.assign({ status: 'success' }, summary_()));
      default:           return json_({ status: 'error', code: 'bad_action', error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ status: 'error', code: 'server', error: String(err && err.message || err) });
  }
}

/** Simple trigger: hand edits to "Entries" (corrections) refresh the "Daily" summary. */
function onEdit(e) {
  if (e && e.range && e.range.getSheet().getName() === ENTRY_SHEET) rebuildDaily_();
}

/* ======================= setup & maintenance ======================= */

function setup() {
  entriesSheet_(); dailySheet_();
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_TOKEN', token);
  }
  rebuildDaily_();
  Logger.log('Ready. Entries: %s rows. API token: %s', Math.max(0, entriesSheet_().getLastRow() - 1), token);
}

function rotateToken() {
  PropertiesService.getScriptProperties().deleteProperty('API_TOKEN');
  setup();
}

/** Run by hand after bulk edits in "Entries", or if "Daily" ever looks stale. */
function rebuildDailyNow() { rebuildDaily_(); }

/**
 * One-time import of the v2 "Logs" sheet (one row per shift) into timestamped entries.
 * Each old shift becomes entries at 12:00:00 on its Shift_Date. Safe to run twice (ids are fixed).
 */
function migrateLegacyLogs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const old = ss.getSheetByName('Logs');
  if (!old || old.getLastRow() < 2) { Logger.log('No legacy Logs sheet with data.'); return; }
  const vals = old.getDataRange().getValues(), head = vals[0];
  const col = n => head.indexOf(n);
  const out = [];
  vals.slice(1).forEach(r => {
    let d = r[col('Shift_Date')];
    d = d instanceof Date ? Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd') : String(d).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const at = d + 'T12:00:00+08:00', base = 'legacy-' + d + '-';
    const n = v => (v === '' || v == null) ? null : Number(v);
    const w = n(r[col('Weight')]), steps = n(r[col('Steps')]), kin = n(r[col('Calories_In')]), kout = n(r[col('Calories_Out')]);
    if (kin) out.push({ id: base + 'food', type: 'food', item: 'Legacy shift total', qty: 1, kcalEach: kin, clientTime: at, note: String(r[col('Meals_Summary')] || '').slice(0, 500) });
    if (steps) out.push({ id: base + 'steps', type: 'steps', value: steps, clientTime: at });
    if (w) out.push({ id: base + 'weight', type: 'weight', value: w, clientTime: at });
    const sys = n(r[col('Systolic_BP')]); if (sys) out.push({ id: base + 'bp', type: 'bp', value: sys, value2: n(r[col('Diastolic_BP')]), clientTime: at });
    const water = n(r[col('Water_Liters')]); if (water) out.push({ id: base + 'water', type: 'water', value: water, clientTime: at });
    // Workout kcal is reconstructed from the old Calories_Out (which used BMR 10W+892.75 and 0.0005 × W per step).
    const wk = kout && w ? Math.max(0, Math.round(kout - (10 * w + 892.75) - (steps || 0) * w * 0.0005)) : 0;
    if (wk) out.push({ id: base + 'workout', type: 'workout', item: String(r[col('Workout_Type')] || 'Workout'), value: n(r[col('Workout_Mins')]), kcal: wk, clientTime: at });
    const tag = col('Day_Type') >= 0 ? String(r[col('Day_Type')] || '') : '';
    if (tag === 'Rest' || tag === 'Sick') out.push({ id: base + 'tag', type: 'tag', item: tag, clientTime: at });
    const note = String(r[col('Notes')] || ''); if (note) out.push({ id: base + 'note', type: 'note', note: note, clientTime: at });
  });
  const res = logEntries_(out, { allowOld: true });
  Logger.log('Migrated: %s new entries (%s already present).', res.added, res.skipped);
}

/* ======================= logging ======================= */

function logEntries_(list, opts) {
  opts = opts || {};
  if (!Array.isArray(list) || !list.length) return { status: 'error', code: 'empty', error: 'No entries' };
  if (list.length > 500) return { status: 'error', code: 'too_many', error: 'Too many entries in one request' };
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = entriesSheet_();
    const last = sh.getLastRow();
    const ids = new Set(last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : []);
    const now = new Date(), rows = [], rejected = [];
    let skipped = 0;
    list.forEach(raw => {
      const id = String(raw.id || '').slice(0, 64);
      if (!/^[A-Za-z0-9_.:-]{6,64}$/.test(id)) { rejected.push({ id: id, error: 'bad id' }); return; }
      if (ids.has(id)) { skipped++; return; }                 // retry of an entry we already have
      const row = buildRow_(raw, now, opts);
      if (row.error) { rejected.push({ id: id, error: row.error }); return; }
      ids.add(id); rows.push(row.values);
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, ENTRY_HEADERS.length).setValues(rows);
    if (rows.length) rebuildDaily_();
    return Object.assign({ status: 'success', added: rows.length, skipped: skipped, rejected: rejected }, opts.allowOld ? {} : summary_());
  } finally {
    lock.releaseLock();
  }
}

function buildRow_(e, now, opts) {
  const type = String(e.type || '');
  if (TYPES.indexOf(type) < 0) return { error: 'bad type' };

  // Calendar date/time in Asia/Singapore. Offline entries keep their real time (up to 7 days old);
  // anything missing, in the future, or older than that is stamped with the server clock.
  let at = now;
  if (e.clientTime) {
    const t = new Date(e.clientTime);
    const ageMs = now - t, maxAge = opts.allowOld ? Infinity : 7 * 864e5;
    if (!isNaN(t) && ageMs > -5 * 60e3 && ageMs < maxAge) at = t;
  }
  const date = Utilities.formatDate(at, CONFIG.TZ, 'yyyy-MM-dd');
  const time = Utilities.formatDate(at, CONFIG.TZ, 'HH:mm:ss');

  let item = '', qty = '', each = '', kcal = '', value = '', value2 = '', note = text_(e.note, 500);
  switch (type) {
    case 'food':
      item = text_(e.item, 60); qty = num_(e.qty, 0.25, 20, 2); each = num_(e.kcalEach, 0, 5000, 0);
      if (!item || qty === '' || each === '') return { error: 'food needs item, qty and kcal' };
      kcal = Math.round(qty * each); break;
    case 'steps':
      value = num_(e.value, 1, 100000, 0); if (value === '') return { error: 'steps 1–100000' }; break;
    case 'workout':
      item = text_(e.item, 60) || 'Workout'; kcal = num_(e.kcal, 1, 3000, 0); value = num_(e.value, 0, 600, 0);
      if (kcal === '') return { error: 'workout kcal 1–3000' }; break;
    case 'weight':
      value = num_(e.value, 30, 300, 1); if (value === '') return { error: 'weight 30–300 kg' }; break;
    case 'bp':
      value = num_(e.value, 50, 260, 0); value2 = num_(e.value2, 30, 180, 0);
      if (value === '') return { error: 'systolic 50–260' }; break;
    case 'water':
      value = num_(e.value, 0.05, 5, 2); if (value === '') return { error: 'water 0.05–5 L' }; break;
    case 'tag':
      item = TAGS.indexOf(e.item) >= 0 ? e.item : ''; if (!item) return { error: 'tag Normal/Rest/Sick' }; break;
    case 'note':
      if (!note) return { error: 'empty note' }; break;
  }
  return { values: [String(e.id), at.toISOString(), date, time, type, item, qty, each, kcal, value, value2, note, text_(e.source, 20)] };
}

/* ======================= aggregation ======================= */

function readEntries_() {
  const sh = entriesSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, ENTRY_HEADERS.length).getValues()
    .filter(r => r[0] !== '' && r[2] !== '')
    .map(r => {
      const o = {};
      ENTRY_HEADERS.forEach((h, i) => {
        let v = r[i];
        if (v instanceof Date) v = h === 'Date' ? Utilities.formatDate(v, CONFIG.TZ, 'yyyy-MM-dd')
          : h === 'Time' ? Utilities.formatDate(v, CONFIG.TZ, 'HH:mm:ss') : v.toISOString();
        o[h] = v;
      });
      o.Date = String(o.Date).slice(0, 10); o.Time = String(o.Time);
      return o;
    })
    .sort((a, b) => (a.Date + a.Time + a.Logged_At) < (b.Date + b.Time + b.Logged_At) ? -1 : 1);
}

function bmr_(p, w) { return 10 * w + 6.25 * p.heightCm - 5 * p.age + (p.gender === 'female' ? -161 : 5); }

/** Same rules as aggregateDays() in index.html — keep the two in step. */
function aggregate_(entries, p) {
  const byDate = {};
  entries.forEach(e => (byDate[e.Date] = byDate[e.Date] || []).push(e));
  const n = v => (v === '' || v == null || isNaN(Number(v))) ? 0 : Number(v);
  let carry = null, cum = 0;
  return Object.keys(byDate).sort().map(date => {
    const list = byDate[date], d = { date: date, food: 0, steps: 0, workout: 0, water: 0, weight: null, sys: null, dia: null, tag: 'Normal', count: list.length };
    list.forEach(e => {
      switch (e.Type) {
        case 'food': d.food += n(e.Kcal); break;
        case 'steps': d.steps += n(e.Value); break;
        case 'workout': d.workout += n(e.Kcal); break;
        case 'water': d.water += n(e.Value); break;
        case 'weight': d.weight = n(e.Value); break;          // entries are time-sorted: latest wins
        case 'bp': d.sys = n(e.Value); d.dia = e.Value2 === '' ? null : n(e.Value2); break;
        case 'tag': d.tag = e.Item; break;
      }
    });
    d.weightUsed = d.weight != null ? d.weight : (carry != null ? carry : p.startKg);
    if (d.weight != null) carry = d.weight;
    d.bmr = bmr_(p, d.weightUsed);
    d.stepKcal = d.steps * d.weightUsed * p.stepKcalPerKgPerStep;
    d.burned = d.bmr + d.stepKcal + d.workout;
    ['bmr', 'stepKcal', 'burned'].forEach(k => d[k] = Math.round(d[k]));
    d.food = Math.round(d.food);
    d.deficit = d.burned - d.food;                        // positive = deficit
    d.counted = d.food > 0;                               // days without food logged don't count
    if (d.counted) cum += d.deficit;                      // sum of the rounded daily figures shown
    d.cumulative = cum;
    d.water = Math.round(d.water * 100) / 100;
    return d;
  });
}

function summary_() {
  const p = profile_(), entries = readEntries_(), days = aggregate_(entries, p);
  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const recentFrom = Utilities.formatDate(new Date(Date.now() - (CONFIG.RECENT_DAYS - 1) * 864e5), CONFIG.TZ, 'yyyy-MM-dd');
  const recent = {};
  entries.filter(e => e.Date >= recentFrom).forEach(e => (recent[e.Date] = recent[e.Date] || []).push(e));
  const target = Math.round((p.startKg - p.goalKg) * CONFIG.KCAL_PER_KG);
  const cumulative = days.length ? days[days.length - 1].cumulative : 0;
  return {
    today: today, serverTime: new Date().toISOString(), profile: p, days: days, recent: recent,
    totals: { cumulative: cumulative, target: target, pct: target ? Math.round(cumulative / target * 1000) / 10 : 0,
      fatKg: Math.round(cumulative / CONFIG.KCAL_PER_KG * 100) / 100, kcalPerKg: CONFIG.KCAL_PER_KG }
  };
}

function entriesForDate_(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  return readEntries_().filter(e => e.Date === date);
}

function rebuildDaily_() {
  const sh = dailySheet_(), days = aggregate_(readEntries_(), profile_()), stamp = new Date().toISOString();
  const rows = days.map(d => [d.date, d.weight == null ? '' : d.weight, d.weightUsed, d.food, d.steps, d.stepKcal, d.workout, d.bmr,
    d.burned, d.deficit, d.counted ? 'Y' : 'N', d.cumulative, d.water, d.sys == null ? '' : d.sys, d.dia == null ? '' : d.dia, d.tag, d.count, stamp]);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, DAILY_HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, DAILY_HEADERS.length).setValues(rows);
}

/* ======================= profile ======================= */

function profile_() {
  let saved = {};
  try { saved = JSON.parse(PropertiesService.getScriptProperties().getProperty('PROFILE') || '{}'); } catch (e) {}
  return Object.assign({}, CONFIG.PROFILE_DEFAULT, saved);
}

function saveProfile_(p) {
  const clean = {};
  const h = num_(p.heightCm, 120, 230, 2); if (h !== '') clean.heightCm = h;
  const a = num_(p.age, 14, 100, 0); if (a !== '') clean.age = a;
  if (p.gender === 'male' || p.gender === 'female') clean.gender = p.gender;
  const s = num_(p.startKg, 30, 300, 1); if (s !== '') clean.startKg = s;
  const g = num_(p.goalKg, 30, 300, 1); if (g !== '') clean.goalKg = g;
  PropertiesService.getScriptProperties().setProperty('PROFILE', JSON.stringify(Object.assign(profile_(), clean)));
}

/* ======================= sheets & helpers ======================= */

function entriesSheet_() { return sheetWithHeaders_(ENTRY_SHEET, ENTRY_HEADERS, ['C:C', 'D:D']); }
function dailySheet_() { return sheetWithHeaders_(DAILY_SHEET, DAILY_HEADERS, ['A:A']); }

function sheetWithHeaders_(name, headers, textCols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  textCols.forEach(c => sh.getRange(c).setNumberFormat('@'));   // keep dates/times as plain text
  return sh;
}

function num_(v, min, max, dp) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) return '';
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function text_(v, max) {
  let s = String(v == null ? '' : v)
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, '').replace(/[<>]/g, '')
    .trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function tokenOk_(t) {
  const want = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!want || typeof t !== 'string' || t.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ t.charCodeAt(i);
  return diff === 0;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
