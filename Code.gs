/**
 * Road to 80 — Google Apps Script API (append-only backend for the GitHub Pages app).
 *
 * SETUP (full walkthrough in DEPLOY.md)
 * 1. Open your "Road_To_80_Logs" sheet → Extensions → Apps Script. Replace Code.gs with this file.
 *    (Delete the old "Index" HTML file if you created one; the page now lives on GitHub Pages.)
 * 2. Project Settings → Time zone = Asia/Singapore.
 * 3. Run `setup` once (▶) and approve permissions. It prepares the Logs tab and creates your
 *    secret API token. Copy the token from View → Logs (or Project Settings → Script properties).
 * 4. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *    Copy the /exec URL. Enter URL + token once in the app on each device.
 * 5. After editing this file later: Deploy → Manage deployments → ✎ → Version: New version.
 *    (Keeps the same /exec URL.)
 *
 * WHY THE TOKEN IS IN THE BODY, NOT AN "X-Auth-Token" HEADER
 * Apps Script does not expose request headers to doPost, and a custom header forces the browser
 * to send a CORS preflight that Apps Script cannot answer. So every call is a text/plain POST
 * whose JSON body carries { token, action, ... }. The token never appears in a URL.
 *
 * Corrections: edit or delete rows directly in the sheet. The API can only append.
 */

const SHEET_NAME = 'Logs';
const HEADERS = ['Timestamp', 'Shift_Date', 'Weight', 'Systolic_BP', 'Diastolic_BP', 'Water_Liters',
  'Steps', 'Workout_Type', 'Workout_Mins', 'Calories_In', 'Calories_Out', 'Net_Deficit',
  'Meals_Summary', 'Notes', 'Day_Type'];
const WORKOUTS = ['None', 'Light', 'Moderate', 'Intense'];
const DAY_TYPES = ['Shift', 'Rest', 'Sick'];
const BP_LIMIT = 140;

/* ---------------- entry points ---------------- */

function doGet() {
  return json_({ status: 'ok', service: 'road-to-80', hint: 'POST {token, action} to use the API.' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!tokenOk_(body.token)) return json_({ status: 'error', code: 'unauthorized', error: 'Wrong or missing token' });
    switch (body.action || 'append') {
      case 'ping':   return json_({ status: 'success' });
      case 'list':   return json_({ status: 'success', logs: readLogs_(), serverTime: new Date().toISOString() });
      case 'append': return json_(appendLog_(body.log || body));
      default:       return json_({ status: 'error', code: 'bad_action', error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ status: 'error', code: 'server', error: String(err && err.message || err) });
  }
}

/* ---------------- one-time setup ---------------- */

function setup() {
  const sh = sheet_();
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_TOKEN', token);
  }
  Logger.log('Sheet ready: "%s" (%s rows).', sh.getName(), Math.max(0, sh.getLastRow() - 1));
  Logger.log('API token (enter this in the app): %s', token);
}

/** Run this if the token ever leaks. Every device must then re-enter the new token. */
function rotateToken() {
  PropertiesService.getScriptProperties().deleteProperty('API_TOKEN');
  setup();
}

/* ---------------- internals ---------------- */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    const first = ss.getSheets()[0];
    sh = (ss.getSheets().length === 1 && first.getLastRow() === 0) ? first.setName(SHEET_NAME) : ss.insertSheet(SHEET_NAME);
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  } else {
    // Upgrade older sheets: add any missing header columns at the end (e.g. Day_Type).
    const have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    HEADERS.forEach((h, i) => { if (have[i] !== h && !have[i]) sh.getRange(1, i + 1).setValue(h); });
  }
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  sh.getRange('B:B').setNumberFormat('@');   // keep Shift_Date as text
  return sh;
}

function appendLog_(d) {
  const shiftDate = String(d.shiftDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) return { status: 'error', code: 'bad_date', error: 'Invalid shift date' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    const logs = readLogs_(sh);
    if (logs.some(r => r.Shift_Date === shiftDate)) {
      return { status: 'duplicate', message: 'This shift is already logged and locked.', log: logs.filter(r => r.Shift_Date === shiftDate).pop() };
    }

    const sys = num_(d.systolic, 50, 260, 0);
    const workout = WORKOUTS.indexOf(d.workoutType) >= 0 ? d.workoutType : 'None';
    // Safety lock, enforced here too: with systolic > 140 (this entry, or the last reading
    // on record when BP is left blank) only "None" or "Light" workouts are accepted.
    const refSys = sys !== '' ? sys : lastReading_(logs, shiftDate);
    if (refSys !== '' && refSys > BP_LIMIT && (workout === 'Moderate' || workout === 'Intense')) {
      return { status: 'error', code: 'bp_lock', error: 'Systolic ' + refSys + ' is above ' + BP_LIMIT + ': only light workouts can be logged.' };
    }

    const row = [
      new Date().toISOString(),
      shiftDate,
      num_(d.weight, 30, 300, 1),
      sys,
      num_(d.diastolic, 30, 180, 0),
      num_(d.water, 0, 10, 1) || 0,
      num_(d.steps, 0, 150000, 0) || 0,
      workout,
      workout === 'None' ? 0 : (num_(d.workoutMins, 0, 600, 0) || 0),
      num_(d.caloriesIn, 0, 20000, 0) || 0,
      num_(d.caloriesOut, 0, 20000, 0) || 0,
      num_(d.netDeficit, -20000, 20000, 0) || 0,
      text_(d.mealsSummary, 1000),
      text_(d.notes, 1000),
      DAY_TYPES.indexOf(d.dayType) >= 0 ? d.dayType : 'Shift'
    ];
    sh.appendRow(row);
    return { status: 'success', message: 'Logged to Google Sheet.', log: rowToObj_(row) };
  } finally {
    lock.releaseLock();
  }
}

function lastReading_(logs, beforeDate) {
  const withBp = logs.filter(r => r.Systolic_BP !== '' && r.Shift_Date < beforeDate)
    .sort((a, b) => a.Shift_Date < b.Shift_Date ? -1 : 1);
  return withBp.length ? Number(withBp[withBp.length - 1].Systolic_BP) : '';
}

function readLogs_(sh) {
  sh = sh || sheet_();
  const last = sh.getLastRow();
  if (last <= 1) return [];
  const rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const tz = Session.getScriptTimeZone();
  return rows.filter(r => r[1] !== '' && r[1] != null).map(r => rowToObj_(r, tz));
}

function rowToObj_(r, tz) {
  const o = {};
  HEADERS.forEach((h, i) => {
    let v = r[i];
    if (v instanceof Date) v = h === 'Shift_Date' ? Utilities.formatDate(v, tz || Session.getScriptTimeZone(), 'yyyy-MM-dd') : v.toISOString();
    o[h] = v === undefined || v === null ? '' : v;
  });
  o.Shift_Date = String(o.Shift_Date).slice(0, 10);
  if (!o.Day_Type) o.Day_Type = 'Shift';
  return o;
}

function num_(v, min, max, dp) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) return '';
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// Plain text only: strip control characters and markup brackets; escape formula starters.
function text_(v, max) {
  let s = String(v == null ? '' : v)
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, '').replace(/[<>]/g, '')
    .trim()
    .slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function tokenOk_(t) {
  const want = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!want || typeof t !== 'string' || t.length !== want.length) return false;   // no token set → API closed
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ t.charCodeAt(i);
  return diff === 0;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
