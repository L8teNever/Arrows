# Arrows

Pfeil-Puzzle im Material-3-Look (Android 15) mit unendlich vielen Leveln. Tipp einen Pfeil an, damit er in seine Richtung rausfliegt. Ist ihm ein anderer Pfeil im Weg, kostet das ein Leben. Jedes Level ist garantiert lösbar.

## Starten

```bash
docker compose up -d
```

Das Image baut GitHub Actions bei jedem Push auf `main` nach `ghcr.io/l8tenever/arrows`. Danach läuft das Spiel auf http://localhost:8080, live unter https://arrow.kulbarts.com. Am Handy kannst du es über „Zum Startbildschirm hinzufügen“ als App installieren.

## Sparsam am Handy

- Keine externen Schriften oder Bibliotheken; die Icons sind ein kleines SVG im HTML.
- Service Worker: App und gespielte Level bleiben auf dem Gerät, danach geht es offline. Das nächste Level wird einmal im Leerlauf mitgeladen.
- Level-Antworten sind gzip-komprimiert und für immer cachebar (gleiche Nummer = gleiches Level).
- Keine Dauerschleifen oder Timer: gezeichnet wird nur, solange ein Pfeil fliegt.
- Spielfeld: ein Belegungsraster statt Neuberechnung, ein Klick-Listener, Punkteraster als SVG-Muster.
- „Weniger Bewegung“ im System kürzt alle Animationen.

## Entwicklung

- `generator.py` erzeugt die Level, `app.py` ist der Flask-Server, `static/` das Frontend.
- Nach Änderungen an HTML/CSS/JS `VERSION` in `static/sw.js` hochzählen, sonst bleibt am Handy die alte Version im Cache.
- Icons neu erzeugen: `python icons.py`
