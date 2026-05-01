#!/usr/bin/env node
/**
 * update-preview.js
 *
 * Lädt die "Laufende Saison" Excel-Datei vom Land Vorarlberg
 * (https://vorarlberg.at/-/120_tourismus) und ergänzt vorläufige Monats-
 * Daten für die Gemeinde Mittelberg (GKZ 80228) in data/hauptgliederung.csv.
 *
 * Hintergrund:
 *  - Die offizielle data.vorarlberg.gv.at-CSV hat einen ~1-monatigen Verzug.
 *  - Die "Laufende Saison" Excel ist 1-2 Wochen aktueller.
 *  - Das Script nimmt die Excel-Werte und verteilt sie proportional auf die
 *    drei Unterkunftsarten (basierend auf den letzten 3 vollständigen Monaten).
 *
 * Wird in der GitHub-Action update-data.yml stündlich ausgeführt.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execSync } = require('child_process');
const { tmpdir } = require('os');

const PAGE_URL = 'https://vorarlberg.at/-/120_tourismus';
const CSV_PATH = path.join(__dirname, '..', 'data', 'hauptgliederung.csv');
const TMP_DIR = path.join(tmpdir(), 'vbg_excel_' + Date.now());

const MONTH_DE = {
    'Jänner': 1, 'Januar': 1, 'Februar': 2, 'März': 3, 'April': 4,
    'Mai': 5, 'Juni': 6, 'Juli': 7, 'August': 8,
    'September': 9, 'Oktober': 10, 'November': 11, 'Dezember': 12
};
const CATS = ['Gewerbliche Beherbergungsbetriebe', 'Privatquartiere', 'Andere Unterkünfte'];
const GKZ = '80228';
const GEMEINDE = 'Mittelberg';

function get(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('Too many redirects'));
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kleinwalsertal-statistik/1.0)' }, timeout: 30000 }, (res) => {
            if ([301, 302, 303, 307].includes(res.statusCode)) {
                let loc = res.headers.location;
                if (!loc.startsWith('http')) loc = 'https://vorarlberg.at' + loc;
                return get(loc, redirects + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function findExcelUrl(html) {
    // Suche aktuelle Saison-Datei: "Laufende_Saison_Tourismus_Winter2025_2026.xlsx" o.ä.
    const re = /\/documents\/302033\/472236\/Laufende_Saison_Tourismus_(Winter|Sommer)\d{4}[_-]?\d{0,4}[^"]*\.xlsx[^"]*/g;
    const matches = [...html.matchAll(re)];
    if (matches.length === 0) return null;
    // Nimm den ersten, decode HTML entities
    return 'https://vorarlberg.at' + matches[0][0].replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
    const strings = [];
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
        strings.push(t ? t[1] : '');
    }
    return strings;
}

function parseSheet(xml) {
    const rows = [];
    // Match each <c ...>...</c> separately, then group by row
    // Each cell: capture col, optional t attribute (anywhere in attrs), and <v> value
    const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
        const rowNum = parseInt(rm[1]);
        const inner = rm[2];
        const cells = {};
        // Match each <c ... /> or <c ...>...</c>
        const cellRe = /<c\s+([^>\/]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm;
        while ((cm = cellRe.exec(inner)) !== null) {
            const attrs = cm[1];
            const body = cm[2] || '';
            const refMatch = attrs.match(/r="([A-Z]+)\d+"/);
            if (!refMatch) continue;
            const col = refMatch[1];
            const tMatch = attrs.match(/\bt="([^"]+)"/);
            const type = tMatch ? tMatch[1] : 'n';
            const vMatch = body.match(/<v>([^<]+)<\/v>/);
            if (vMatch) {
                cells[col] = { type, value: vMatch[1] };
            }
        }
        rows.push({ rowNum, cells });
    }
    return rows;
}

function findKleinwalsertalStringIdx(strings) {
    // Excel hat zwei "Kleinwalsertal"-Einträge: einer im Header (Region-Liste),
    // einer als Zeilen-Label. Wir wollen den späteren (typisch idx > 30).
    const candidates = [];
    strings.forEach((s, i) => {
        if (s === 'Kleinwalsertal') candidates.push(i);
    });
    if (candidates.length === 0) return -1;
    // Höchsten Index nehmen (das ist der Zeilenname)
    return candidates[candidates.length - 1];
}

function getMonthFromString(s) {
    // "März 2026" -> {month: 3, year: 2026} (Unicode-aware: matcht ä, ö, ü etc.)
    const m = s.match(/^([A-Za-zÄÖÜäöüß]+)\s+(\d{4})$/);
    if (!m) return null;
    const monNum = MONTH_DE[m[1]];
    if (!monNum) return null;
    return { month: monNum, year: parseInt(m[2]), label: s };
}

function readCsvByMonth(csvText) {
    const lines = csvText.split(/\r?\n/);
    const data = {}; // key "YYYY-MM" -> { 'Gewerbliche...': {ank, nae}, ... }
    for (const line of lines.slice(1)) {
        if (!line.includes(';' + GKZ + ';')) continue;
        const cols = line.split(';').map(c => c.replace(/^"|"$/g, ''));
        if (cols.length < 10) continue;
        const y = parseInt(cols[0]);
        const m = parseInt(cols[3]);
        const cat = cols[6];
        const ank = parseInt(cols[8]);
        const nae = parseInt(cols[9]);
        if (!isFinite(y) || !isFinite(m)) continue;
        const key = `${y}-${m.toString().padStart(2, '0')}`;
        if (!data[key]) data[key] = {};
        data[key][cat] = { ank, nae };
    }
    return data;
}

function computeSplit(csvData) {
    // Mittelt die Anteile der 3 Kategorien aus den letzten 3 vollständigen Monaten
    const sorted = Object.keys(csvData).sort().reverse();
    const completeMonths = sorted.filter(k => CATS.every(c => csvData[k][c])).slice(0, 3);
    if (completeMonths.length === 0) {
        // Fallback: ungefährer historischer Durchschnitt für Kleinwalsertal
        return {
            ank: { 'Gewerbliche Beherbergungsbetriebe': 0.66, 'Privatquartiere': 0.18, 'Andere Unterkünfte': 0.16 },
            nae: { 'Gewerbliche Beherbergungsbetriebe': 0.63, 'Privatquartiere': 0.20, 'Andere Unterkünfte': 0.17 }
        };
    }
    const split = { ank: {}, nae: {} };
    CATS.forEach(c => { split.ank[c] = 0; split.nae[c] = 0; });
    completeMonths.forEach(k => {
        let totA = 0, totN = 0;
        CATS.forEach(c => { totA += csvData[k][c].ank; totN += csvData[k][c].nae; });
        CATS.forEach(c => {
            split.ank[c] += csvData[k][c].ank / totA / completeMonths.length;
            split.nae[c] += csvData[k][c].nae / totN / completeMonths.length;
        });
    });
    return split;
}

function tourismusjahr(month, year) {
    // Tourismusjahr beginnt am 1. November und endet am 31. Oktober
    if (month >= 11) return year + 1;
    return year;
}
function saison(month) {
    return [11, 12, 1, 2, 3, 4].includes(month) ? 'Winter' : 'Sommer';
}

async function main() {
    console.log('[update-preview] Lade Vorarlberg Tourismus-Seite...');
    const pageHtml = (await get(PAGE_URL)).toString('utf8');
    const excelUrl = findExcelUrl(pageHtml);
    if (!excelUrl) {
        console.log('[update-preview] Keine "Laufende Saison" Excel gefunden – nichts zu tun.');
        return;
    }
    console.log('[update-preview] Excel:', excelUrl);

    const excelBuf = await get(excelUrl);
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const xlsxFile = path.join(TMP_DIR, 'file.xlsx');
    fs.writeFileSync(xlsxFile, excelBuf);
    console.log('[update-preview] Excel geladen:', excelBuf.length, 'bytes');

    // Unzip
    execSync(`unzip -oq "${xlsxFile}" -d "${TMP_DIR}/extracted"`);

    const ssXml = fs.readFileSync(path.join(TMP_DIR, 'extracted/xl/sharedStrings.xml'), 'utf8');
    const strings = parseSharedStrings(ssXml);

    const klwIdx = findKleinwalsertalStringIdx(strings);
    if (klwIdx < 0) { console.log('[update-preview] Kein Kleinwalsertal-Eintrag gefunden.'); return; }
    console.log('[update-preview] Kleinwalsertal Index:', klwIdx);

    // Sheet1 = Ankünfte_LFS, Sheet2 = Nächtigungen_LFS
    const sheet1Xml = fs.readFileSync(path.join(TMP_DIR, 'extracted/xl/worksheets/sheet1.xml'), 'utf8');
    const sheet2Xml = fs.readFileSync(path.join(TMP_DIR, 'extracted/xl/worksheets/sheet2.xml'), 'utf8');

    const sheet1Rows = parseSheet(sheet1Xml);
    const sheet2Rows = parseSheet(sheet2Xml);

    // Header-Zeile finden (irgendeine Zeile mit Monatsstring-Indizes in den Spalten)
    function findHeaderRow(rows) {
        for (const r of rows) {
            const cols = Object.values(r.cells).filter(c => c.type === 's');
            const monthCols = cols.filter(c => {
                const s = strings[parseInt(c.value)];
                return s && getMonthFromString(s);
            });
            if (monthCols.length >= 3) return r;
        }
        return null;
    }

    const headerRow = findHeaderRow(sheet2Rows) || findHeaderRow(sheet1Rows);
    if (!headerRow) { console.log('[update-preview] Header-Zeile mit Monaten nicht gefunden.'); return; }

    const colToMonth = {};
    Object.entries(headerRow.cells).forEach(([col, c]) => {
        if (c.type === 's') {
            const s = strings[parseInt(c.value)];
            const mo = s && getMonthFromString(s);
            if (mo) colToMonth[col] = mo;
        }
    });
    console.log('[update-preview] Monats-Spalten:', Object.entries(colToMonth).map(([c, m]) => `${c}=${m.label}`).join(', '));

    function findRowByLabel(rows, labelIdx) {
        for (const r of rows) {
            const a = r.cells['A'];
            if (a && a.type === 's' && parseInt(a.value) === labelIdx) return r;
        }
        return null;
    }

    const ankRow = findRowByLabel(sheet1Rows, klwIdx);
    const naeRow = findRowByLabel(sheet2Rows, klwIdx);
    if (!ankRow || !naeRow) { console.log('[update-preview] Kleinwalsertal-Datenzeile nicht gefunden.'); return; }

    // Vorhandene CSV einlesen
    const csvText = fs.readFileSync(CSV_PATH, 'utf8');
    if (csvText.includes('<!DOCTYPE') || csvText.includes('<html')) {
        console.log('[update-preview] CSV enthält HTML – breche ab.');
        return;
    }
    const csvData = readCsvByMonth(csvText);
    const sortedKeys = Object.keys(csvData).sort();
    const latestKey = sortedKeys[sortedKeys.length - 1] || '0000-00';
    const [latestY, latestM] = latestKey.split('-').map(Number);
    console.log('[update-preview] Letzter Monat in CSV:', latestKey);

    const split = computeSplit(csvData);
    console.log('[update-preview] Aufteilungs-Verhältnis:',
        Object.fromEntries(CATS.map(c => [c, `${(split.nae[c] * 100).toFixed(1)}%`])));

    // Neue Zeilen sammeln
    const newRows = [];
    for (const [col, mo] of Object.entries(colToMonth)) {
        const monthKey = `${mo.year}-${mo.month.toString().padStart(2, '0')}`;
        if (monthKey <= latestKey) continue; // schon in CSV

        const ankCell = ankRow.cells[col];
        const naeCell = naeRow.cells[col];
        if (!ankCell || !naeCell) continue;

        const ankTotal = parseFloat(ankCell.value);
        const naeTotal = parseFloat(naeCell.value);
        if (!isFinite(ankTotal) || !isFinite(naeTotal) || ankTotal === 0 || naeTotal === 0) continue;

        const tj = tourismusjahr(mo.month, mo.year);
        const sa = saison(mo.month);
        for (const cat of CATS) {
            const ankVal = Math.round(ankTotal * split.ank[cat]);
            const naeVal = Math.round(naeTotal * split.nae[cat]);
            newRows.push(`${mo.year};${tj};"${sa}";${mo.month};${GKZ};"${GEMEINDE}";"${cat}";"vorläufig";${ankVal};${naeVal}`);
        }
        console.log(`[update-preview] + ${monthKey} (${mo.label}): ${Math.round(ankTotal)} Ankünfte, ${Math.round(naeTotal)} Nächtigungen`);
    }

    if (newRows.length === 0) {
        console.log('[update-preview] CSV ist auf neuestem Stand – kein Append nötig.');
        return;
    }

    const updated = csvText.replace(/\s+$/, '') + '\n' + newRows.join('\n') + '\n';
    fs.writeFileSync(CSV_PATH, updated);
    console.log(`[update-preview] ${newRows.length} Zeilen für ${newRows.length / CATS.length} Monat(e) ergänzt.`);

    // Cleanup
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}

main().catch(e => {
    console.error('[update-preview] Fehler:', e.message);
    process.exit(0); // nicht harter Fehler – CSV bleibt unverändert
});
