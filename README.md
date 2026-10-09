# 🗺️ [GenGIS (G²)](https://g2.luiscintron.com)

[![GenGIS Live](https://img.shields.io/badge/Live-g2.luiscintron.com-success?style=for-the-badge&logo=githubpages&logoColor=white)](https://g2.luiscintron.com)
[![Latest release](https://img.shields.io/github/v/release/lcintron/gengis?style=for-the-badge&logo=github&label=Release)](https://github.com/lcintron/gengis/releases/latest)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9-199900?style=for-the-badge&logo=leaflet&logoColor=white)](https://leafletjs.com/)
[![PWA and Electron](https://img.shields.io/badge/PWA%20%2B%20Electron-Web%20%26%20Desktop-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://github.com/lcintron/gengis/releases/latest)

![GenGIS](branding/png/gengis-banner-1200x300.png)

A free map builder that runs in the browser (installable, works offline) or as a desktop app ([installers](https://github.com/lcintron/gengis/releases/latest) for Windows, macOS and Linux). Draw and measure on the map, organize your work in layers, and overlay live FAA airspace, LAANC ceilings and air traffic. No account or API key needed.

![GenGIS on the desktop: Tampa Bay with airspace and LAANC ceilings](docs/screenshots/desktop-map.jpg)

![One click lists your object and every airspace under it, and Properties describes the data feature](docs/screenshots/desktop-identify.jpg)

<p align="center">
  <img src="docs/screenshots/mobile-map.jpg" width="250" alt="GenGIS on a phone">
  <img src="docs/screenshots/mobile-menu.jpg" width="250" alt="The phone menu: units, base map and project">
  <img src="docs/screenshots/mobile-data.jpg" width="250" alt="Data sources on a phone">
</p>

## Features

- **Draw and edit** markers, text, lines, polygons, rectangles, circles and SVG images, with snapping, name labels and full styling. By default, each new object gets its own color. Texts take a font, a background opacity and an editable shadow.
- **Move and resize**: the Move tool drags objects and shows a box around what it moves; the Scale tool resizes from any corner or side (Shift keeps proportions, Alt resizes from the center).
- **Combine and reuse**: multi-select, join lines into shapes, join overlapping shapes into one polygon, duplicate, and copy a style to paste on other objects.
- **Measure** distances and areas in metric, imperial or nautical units, with a scale bar. A circle shows its radius while you draw it, and objects can show their length, perimeter, area, radius or position on the map.
- **Layers** with show/hide, lock and draw order, duplicate, and **groups**: a grouped layer's objects are selected, moved, resized and deleted together. Locked objects can still be selected and inspected. Undo/redo, right-click menus, presenter mode with full screen.
- **Projects** save automatically on the device as you work, with recent projects and earlier copies to restore; save/open as `.gengis.json`; GeoJSON import/export. In the desktop app each named project is also kept as a file (`Documents\GenGIS` by default).
- **Search** addresses, places and coordinates; find points of interest; center on **your location**.
- **FAA data**, live for the area in view: Class B–E airspace with floors and ceilings, special use airspace, LAANC ceilings, security flight restrictions, TFRs, airports (with radio frequencies) and more. Click anywhere to see everything under that point; the feature's source, geometry and attributes show in Properties. Country and state borders at every zoom. Any public ArcGIS layer can be added.
- **Live air traffic (ADS-B)** from your own dump1090 receiver or the adsb.fi and adsb.lol networks, with type icons colored by altitude and aircraft look-up.
- **Live vessel traffic (AIS)** from your own AIS-catcher receiver or the aisstream.io network, colored by ship type, with vessel details.
- **Place names**: countries, major cities, and oceans and seas, each toggled in Settings next to the borders.
- **Base maps**: Esri World Imagery (default), OpenStreetMap, OpenTopoMap, CyclOSM, CARTO, plus your own XYZ/WMS or keyed providers. Zoom in quarter steps.
- **Offline**: download map tiles and data for an area ahead of time.

Informational only: not for navigation or flight authorization.

## Run it yourself

```bash
node serve.js 8080      # web app at http://localhost:8080
npm install && npm start  # desktop app (Electron)
```

Any static web server works for the web app. Open it with a location: `?q=Eiffel+Tower`, `?lat=48.858&lon=2.294&zoom=16` or `?poi=cafe`.

### Live air and vessel traffic: where it works

Browsers only read another server's data when it allows them to (CORS), and block plain-HTTP requests from an HTTPS page. The desktop app has neither limit.

| Source | Desktop app | Web app over `http://` | Web app over HTTPS |
| --- | --- | --- | --- |
| dump1090 that sends CORS headers (dump1090-fa, tar1090) | yes | yes | only on `localhost` or over HTTPS |
| dump1090 without CORS headers | yes | no | no |
| adsb.fi, adsb.lol | yes | no | no |
| AIS-catcher (web viewer on, `-N 8100`) | yes | yes | only on `localhost` or over HTTPS |
| aisstream.io (free API key) | yes | no | no |

## Releasing

Releases run in CI on demand: **Actions → Release → Run workflow** on `main` (or `gh workflow run release.yml -f bump=auto`). By default, the version bump is derived from conventional commits (or choose one in the form). The workflow tags the release, builds Windows, macOS and Linux installers, publishes a GitHub Release, and deploys the site. **Dry run** only reports the version it would release. `make serve`, `make build` and `make release DRY=1` do the same locally.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| V / G / K | Select / Move / Scale |
| M / T / L / P / R / C / S | Marker, Text, Line, Polygon, Rectangle, Circle, SVG |
| D / A | Measure distance / area |
| F | Presenter mode |
| Esc / Delete | Cancel or deselect / delete |
| Ctrl/Cmd + Z / Y / D / S | Undo / redo / duplicate (a group: its layer) / save |
| / | Search |

## Data sources and fair use

Map tiles, [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) search and the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) are free public services with their own usage policies; attribution is shown on the map. FAA data comes from the [FAA UAS Data Delivery System](https://udds-faa.opendata.arcgis.com/), borders from the [Esri Living Atlas](https://livingatlas.arcgis.com/), and place names from [Natural Earth](https://www.naturalearthdata.com/) (public domain; rebuilt with `node scripts/build-places.js`). Air traffic from [adsb.fi](https://github.com/adsbfi/opendata) is for personal, non-commercial use and [adsb.lol](https://adsb.lol) is ODbL; the app polls no faster than each allows. Vessel traffic from [aisstream.io](https://aisstream.io) needs your own free key, kept on your device only. For heavy use, point the app at your own servers (Project → Map & search APIs).

## License

[MIT](LICENSE). Bundled Leaflet (BSD 2-Clause), Leaflet-Geoman (MIT) and polygon-clipping (MIT) keep their own licenses.
