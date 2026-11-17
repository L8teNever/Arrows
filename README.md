# Arrows

Pfeil-Puzzle im Material-3-Look (Android 15) mit unendlich vielen Leveln. Tipp einen Pfeil an, damit er in seine Richtung rausfliegt. Ist ihm ein anderer Pfeil im Weg, kostet das ein Leben. Lange drücken zeigt, wohin ein Pfeil fliegt und ob ihm etwas im Weg ist. Jedes Level ist garantiert lösbar.

Zwischendurch gibt es Abwechslung: große Felder mit langen Pfeilen und Level in Form von Herz, Kreis, Ring, Raute, Kreuz, Dreieck oder Sanduhr. Am Handy liegt das Feld hochkant, am Tablet quer (Formen bleiben aufrecht).

## Starten

```bash
docker compose up -d
```

Das Image baut GitHub Actions bei jedem Push auf `main` nach `ghcr.io/l8tenever/arrows`. Danach läuft das Spiel auf http://localhost:8080, live unter https://arrow.kulbarts.com. Am Handy kannst du es über „Zum Startbildschirm hinzufügen“ als App installieren.

## Konten und Statistik

- Angemeldet wird nur über Cloudflare Zero Trust (siehe unten). Das Konto kommt aus der Mail, einen Namen tippt niemand ein. Frühere Links wie `/Simon` leiten auf `/` um.
- Der Fortschritt liegt auf dem Server, man spielt auf jedem Gerät weiter.
- `/dashboard` führt zur eigenen Statistik (Level, Spielzeit, Ø pro Level, Tempo im Vergleich, Fehler, alle Level), darunter der Vergleich mit allen. `/Name/dashboard` zeigt die Statistik eines anderen Spielers, `/dashboard?alle` die Übersicht, `?level=12` die Rangliste eines Levels.
- Gezählt wird nur aktive Spielzeit (App sichtbar). Daten in SQLite unter `/data/arrows.db` (Docker-Volume).

## Sparsam am Handy

- Keine externen Schriften oder Bibliotheken; die Icons sind ein kleines SVG im HTML.
- Service Worker: App und gespielte Level bleiben auf dem Gerät, danach geht es offline. Das nächste Level wird einmal im Leerlauf mitgeladen.
- Level-Antworten sind gzip-komprimiert und bleiben im Service Worker pro Generator-Version gespeichert (gleiche Nummer = gleiches Level). Die Seite selbst fragt beim Öffnen kurz beim Server nach (meist nur ein 304).
- Keine Dauerschleifen oder Timer: gezeichnet wird nur, solange ein Pfeil fliegt.
- Spielfeld: ein Belegungsraster statt Neuberechnung, ein Klick-Listener, Punkteraster als SVG-Muster.
- „Weniger Bewegung“ im System kürzt alle Animationen.

## Entwicklung

- `generator.py` erzeugt die Level, `app.py` ist der Flask-Server, `static/` das Frontend.
- Versionen laufen automatisch: Der Server bildet sie aus dem Inhalt der Dateien (`BUILD`, `GEN` in `app.py`) und setzt sie in `sw.js` und die Adressen von CSS/JS ein. Nach einem Deploy holt sich jedes Gerät die neue Version von selbst, niemand muss Cache oder Cookies löschen.
- Icons neu erzeugen: `python icons.py`

## Login über Cloudflare Zero Trust

Liegt die Seite hinter einer Cloudflare-Access-Application, liest der Server die Mail aus
`Cf-Access-Authenticated-User-Email` und legt daraus automatisch das Konto an (Name = Teil vor dem @,
z. B. `l8tenever@gmail.com` → `l8tenever`). Ohne Login spielt man nur lokal auf dem Gerät, ohne Konto und Statistik.
Lokal testen: `ARROWS_DEV_EMAIL=ich@example.com` setzt eine feste Mail.

Optional prüft der Server zusätzlich das signierte Access-Token, damit der Header nicht gefälscht werden kann:

```yaml
environment:
  ARROWS_ACCESS_TEAM: kulbarts          # kulbarts.cloudflareaccess.com
  ARROWS_ACCESS_AUD: <Application Audience Tag>
```
