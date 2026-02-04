# Kleinwalsertal Tourismusstatistik

🏔️ **Live-Dashboard für Tourismuszahlen im Kleinwalsertal**

→ **[kleinwalsertal-statistik.at](https://kleinwalsertal-statistik.at)**

## Features

- 📊 Automatische Daten von Land Vorarlberg Open Government Data
- 📈 Interaktives Chart mit Nächtigungen pro Jahr
- 🔮 Automatische Hochrechnung & Prognose
- 📱 Responsive Design
- ⚡ Kein Backend nötig – läuft komplett im Browser
- 💾 24h Client-Side Caching

## Datenquelle

[Tourismusstatistik Vorarlberg – Open Government Data](https://www.data.gv.at/katalog/dataset/88472b80-92c8-452b-b2b4-b417e97349bb)

CSV-Rohdaten: `data.vorarlberg.gv.at/katalog/wirtschaft/wirfin_vbg_tour_ankuenfte_naechtigungen_hauptgliederung_monatlich.csv`

Gemeinde Mittelberg (GKZ 80228) = Kleinwalsertal

## Setup

### GitHub Pages

1. Repository erstellen
2. `index.html` hochladen
3. Settings → Pages → Source: "Deploy from a branch" → `main` / `root`
4. Custom Domain: `kleinwalsertal-statistik.at`

### Domain (nic.at)

DNS-Einstellungen bei deinem Domain-Registrar:

```
Typ     Name    Wert
A       @       185.199.108.153
A       @       185.199.109.153
A       @       185.199.110.153
A       @       185.199.111.153
CNAME   www     deinusername.github.io.
```

Dann in GitHub: Settings → Pages → Custom domain: `kleinwalsertal-statistik.at`

## Technik

- Reines HTML/CSS/JavaScript (kein Framework, kein Build)
- Fetcht CSV direkt von data.vorarlberg.gv.at
- Falls CORS blockiert: Fallback über öffentlichen CORS-Proxy
- Falls alles fehlschlägt: Eingebettete verifizierte Daten (Chronik Gemeinde Mittelberg)

## Datenverarbeitung

1. CSV wird geladen und nach GKZ 80228 gefiltert
2. Monatsdaten werden nach Jahr aggregiert
3. Unvollständige Jahre werden auf 12 Monate hochgerechnet
4. Prognose basiert auf Ø Wachstum der letzten 3 vollständigen Jahre

## Lizenz

Daten: [CC BY 4.0 – Land Vorarlberg](https://creativecommons.org/licenses/by/4.0/)

Code: MIT
