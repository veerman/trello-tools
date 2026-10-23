/**
 * @OnlyCurrentDoc
 *
 * File link lookup. Attach this script to a Google Sheet (Extensions > Apps Script) and deploy
 * it as a web app. It answers one name at a time:
 *   <web app address>?f=project-plan  ->  {"url": "https://drive.google.com/file/d/..."}
 * so the Sheet itself stays private and nobody can download the whole list.
 *
 * The Sheet: a tab named "Links", first row "name | link", then one row per file.
 * Names match ignoring case, and spaces, dashes and underscores count as the same.
 *
 * @OnlyCurrentDoc limits the script to this one spreadsheet: it cannot see the rest of the Drive.
 */
const SHEET_NAME = 'Links';
const CACHE_SECONDS = 300;

function doGet(e) {
  const wanted = normalizeName((e && e.parameter && e.parameter.f) || '');
  const url = wanted ? loadTable()[wanted] : null;
  return json(url ? { url: url } : { error: 'not found' });
}

// The table is cached for a few minutes, so most clicks don't have to read the Sheet
function loadTable() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('table');
  if (cached) return JSON.parse(cached);

  const table = {};
  // The "Links" tab, or the first tab (as in a Sheet imported from a CSV)
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.getSheets()[0];
  const rows = sheet.getDataRange().getValues();
  rows.slice(1).forEach(function (row) {
    const name = normalizeName(String(row[0] || ''));
    const link = String(row[1] || '').trim();
    // Only web addresses: a link that isn't https is never handed out
    if (name && /^https:\/\//i.test(link)) table[name] = link;
  });
  try {
    cache.put('table', JSON.stringify(table), CACHE_SECONDS);
  } catch (tooBig) {
    // Google caches at most 100 KB; a bigger table is simply read from the Sheet each time
  }
  return table;
}

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function json(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}
