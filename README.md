# GenGIS (G²)

![GenGIS](branding/png/gengis-banner-1200x300.png)

Version 0.0.1-Beta

A standalone map building tool built on web technologies. Runs as a **Progressive Web App** (installable, works offline for the app itself and tiles you have viewed) or as an **Electron** desktop app. No paid map APIs: it uses OpenStreetMap-based tiles, Nominatim for address search, the Overpass API for points of interest, and public FAA and Esri feature services. It works without any API key; optional free keys (for example CARTO) unlock extra base maps.

## Features

- **Draw** markers, text labels, lines, polygons, rectangles and circles on the map. A **Move** tool drags whole objects; the Select tool edits vertices.
- **Style** every object: border color, width, opacity and line style (solid, dashed, dotted, dash-dot, long dash), fill color and opacity. Text labels have color, size, background, bold / italic / underline / strikethrough, text alignment and horizontal + vertical anchoring.
- **Snapping and closed shapes**: vertices snap to other shapes while drawing and editing, with an indicator showing whether the point is on a line end, a vertex or an edge. A line that returns to its first point becomes a polygon. Lines and polygons convert both ways (right-click or Properties).
- **Multi-select and join**: shift-click objects (map or Layers list) to select several, then join touching lines into one line or, when they close, a polygon with an area; or create a fill-only polygon from the lines and keep them. Move or delete the whole selection at once.
- **Name labels**: markers, lines, polygons, rectangles, circles and SVG images can show their name on the map, positioned top / middle / bottom and left / center / right of the object, with text color, size and optional background.
- **Right-click menus** on objects (properties, center map, zoom to fit, copy coordinates, rename, duplicate, move to layer, copy/paste style, z-order, delete) and on the map (copy coordinates, add marker/text/SVG here, measure from here, what's here?).
- **Presenter mode** (F): hides every editing control and shows only the map with all layers, with optional full screen.
- **SVG images**: upload your own SVGs, then place them as fixed-size symbols ("fixed pixels") or anchored to the ground in real-world units ("scale with map"), with rotation and opacity.
- **Layers**: a tree of named layers with their objects. Layers and individual objects each have show/hide, lock, move up/down (draw order), rename and delete; layer-level actions apply to every object in the layer. Objects can be moved between layers.
- **Measurement**: distance and area tools with live readouts. Finished measurements are objects on the active layer (stylable, editable, movable between layers) with segment and total labels; optional length/area labels on every other shape too.
- **Metric, imperial or nautical** units everywhere: m/km and m²/km²; ft/mi and ft²/mi²; or nautical miles (with feet or meters for short distances) and ft²/mi². The measurement box also shows each value in the other systems.
- **Scale bar** always shown in the bottom-right corner: two blocks (0, half, full) in the selected unit system (m/km, ft/mi or ft/NM).
- **Search** by address, place name or coordinates (decimal `48.858, 2.294` or DMS `48°51'30"N 2°17'40"E`).
- **Points of interest** by category (cafés, hospitals, parking, ...) or any OpenStreetMap tag, within the current view; add them as markers.
- **URL parameters** to open the app centered on a location: `?q=Eiffel+Tower`, `?lat=48.858&lon=2.294&zoom=16`, `?center=48.858,2.294`, `?poi=cafe`.
- **Fast tiles and rendering**: cached tiles are shown instantly and re-fetched only after a week (the tile cache survives app updates), a ring of tiles around the view is kept so small pans never reload, neighbouring zoom levels are preloaded (off on volunteer-run servers unless enabled), and data layers draw on a single Canvas instead of thousands of SVG nodes.
- **Offline areas** (Settings tab): download the current view's map tiles for a zoom range (with tile count and size estimate, progress, cancel), optionally pre-loading the enabled FAA/boundary data for the area. Downloaded areas are listed with go-to, re-download and delete, are served by the service worker before the network, and are never evicted by the rolling tile cache. Volunteer-run tile servers (OpenStreetMap and friends) are capped at 3,000 tiles per area; use a keyed provider for larger areas.
- **Projects**: autosaved in the browser, save/open as `.mapproject.json`, export/import GeoJSON (styles preserved), undo/redo.
- 8 free base maps (OpenStreetMap, Humanitarian, OpenTopoMap, CyclOSM, CARTO light/dark/voyager, Esri imagery). CARTO needs a free key (Map & search APIs dialog), where you can also pick its label variant.
- **Country and state/province boundaries** (on by default, Settings tab → Map overlays): world country outlines and first-level administrative divisions from Esri's public Living Atlas services. Generalized when zoomed out, full detail when zoomed in, cached like the FAA data.
- **Data sources** (Data tab, with search and an enabled/disabled filter) — **FAA airspace & UAS data**: live layers from the FAA UAS Data Delivery System: FAA-Recognized Identification Areas, UAS Facility Map (LAANC ceilings, colored by altitude), Class B/C/D/E airspace, Special Use Airspace, Prohibited Areas, National Security UAS Flight Restrictions (full-time, part-time, pending), National Defense Airspace TFR areas, recreational fixed sites, stadiums and airports. Data is fetched for the visible area (0.5° cells, paged), cached in IndexedDB, and re-downloaded when the service's last-edit stamp changes (checked on a schedule you choose). Hover for labels, click for details. Airports and stadiums use chart-style icons (blue towered, magenta non-towered, grey private, H for heliports). Clicking an airport shows its radio frequencies (tower, ground, ATIS, CTAF, approach, departure) from the OurAirports republication of FAA NASR data, downloaded once and refreshed only when the source changes; towered airports are drawn in teal. Datasets with sub-elements (airspace classes, special-use types, LAANC ceiling altitudes, public/private airports, part-time NSUFR alert state) have per-element toggles. Any other public ArcGIS Feature Service layer can be added by URL.
- **Map & search APIs dialog** (Project menu): add tile providers that need an API key (presets for MapTiler, Thunderforest, Stadia, Mapbox, Geoapify), any XYZ tile server or WMS server, and point the geocoder at any Nominatim-compatible service (LocationIQ, geocode.maps.co, self-hosted) or your own Overpass endpoints. Keys stay in the browser's local storage.

## Run as a PWA

Any static web server works. With Node installed:

```bash
node serve.js 8080
```

Then open <http://localhost:8080/> and use your browser's "Install app" option (or the *Project → Install as app* menu item). Alternatives: `python -m http.server 8080`, or drop the folder on any static host (GitHub Pages, Netlify, an intranet server). The service worker needs `http://localhost` or `https://`.

## Run as an Electron app

```bash
npm install
npm start
```

Pass a location on the command line:

```bash
npm start -- --q="Golden Gate Bridge"
npm start -- --lat=37.8199 --lon=-122.4783 --zoom=15
npm start -- --center=37.8199,-122.4783 --poi=cafe
```

Build installers with `npm run dist` (electron-builder; produces NSIS/DMG/AppImage).

## Building, releasing and deploying

Releases are made on demand and run entirely in CI. Merging to `main` releases nothing; to cut a release, open **Actions, Release, Run workflow** (on `main`), choose the bump and press the button (or run `gh workflow run release.yml -f bump=auto`). The workflow then:

1. with bump `auto`, derives the semantic-version bump from the conventional commits since the last tag (`feat:` minor, `fix:`/`perf:` patch, `BREAKING CHANGE` major; only `chore:`/`docs:`/`ci:` commits mean nothing to release), or uses the bump chosen in the form,
2. updates the version everywhere it is shown (package.json, Settings/About, splash, README, service-worker cache name), commits `chore(release): vX.Y.Z`, tags and pushes,
3. builds the Windows (NSIS), macOS (DMG, zip) and Linux (AppImage, deb) installers on their own runners,
4. publishes a GitHub Release with the installers and generated notes,
5. deploys GitHub Pages from that tag, so the live site always matches a release.

The form also takes an optional pre-release label (e.g. `Beta`) and a **Dry run** box that only reports the version a run would release. The Pages source must be set to "GitHub Actions" once in the repository settings.

| Command | What it does |
| --- | --- |
| `make serve` | Run locally at <http://localhost:8080> |
| `make build` | Desktop installer for this machine's OS (`dist/`) |
| `make build-win` / `build-mac` / `build-linux` | One platform (macOS builds need a Mac) |
| `make release DRY=1` | Preview the bump the workflow would make |
| `make version` | Print the current version |

`make release` is what the workflow runs (with `CI=1`); running it locally also pushes `main`, so it is normally left to CI. Without `make`, the same commands exist as `npm run dist`, `npm run dist:win|mac|linux` and `npm run release`.

Installers are unsigned; macOS and Windows show a warning on first launch until signing certificates are added to the Release workflow.

## Mobile

The layout adapts to phones (tested at 375 to 430 px widths): the side panel becomes a bottom sheet with a close button, the toolbar shrinks, pinch zoom replaces the zoom buttons, and long-press opens the right-click menu.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| V / G / M / T / L / P / R / C / S | Select, Move, Marker, Text, Line, Polygon, Rectangle, Circle, SVG |
| F | Presenter mode (Esc to exit) |
| D / A | Measure distance / area |
| Esc | Cancel drawing, deselect |
| Delete | Delete selected object |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+D | Duplicate selected object |
| Ctrl+S | Save project to file |
| / | Focus the search box |

## Project layout

```
index.html            app shell
css/app.css           styles
js/util.js            units, geodesic math, coordinate parsing
js/store.js           state, layers, basemaps, undo/redo
js/features.js        shapes, styles, SVG placements, selection, serialization
js/tools.js           drawing (Leaflet-Geoman), measuring, SVG placement
js/geometry.js        multi-select, line/polygon conversion, joining lines, snap indicator
js/search.js          Nominatim, Overpass, URL parameters
js/storage.js         autosave, project files, GeoJSON, SVG library
js/scale.js           two-block scale bar control
js/settings.js        map provider / search service settings dialog
js/contextmenu.js     right-click menus
js/presenter.js       presenter mode
js/datalayers.js      FAA / ArcGIS feature-service data layers with IndexedDB cache
js/frequencies.js     airport radio frequencies (OurAirports / FAA NASR), cached with change detection
js/offline.js         offline areas: tile pre-download into a dedicated cache
js/tooltipdelay.js    hover-tooltip rest delay
js/ui.js              panels, toolbar, keyboard
js/app.js             bootstrap
sw.js                 service worker (offline shell + tile cache)
manifest.webmanifest  PWA manifest
electron/main.js      Electron entry point
vendor/               Leaflet 1.9.4, Leaflet-Geoman 2.20 (bundled, no CDN needed)
```

## Data sources and fair use

- Tiles: each provider has its own usage policy (OpenStreetMap's tile policy forbids heavy or bulk use). Attribution is shown on the map.
- Geocoding: [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) – max 1 request/second, no bulk geocoding. The app only queries when you press Enter.
- Points of interest: [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) public instance – light use only.

For heavy or commercial use, point `js/search.js` and `js/store.js` at your own Nominatim/Overpass/tile servers.

## Branding

`branding/` holds the identity assets:

- `svg/`: vector mark (`gengis-mark.svg`) and wordmarks (horizontal, stacked) in color, on-dark, white and black variants
- `png/`: transparent PNG marks and wordmarks, 1024 px app icon, social preview (1280×640) and README banner
- `splash/`: dark launch screens for desktop, iPhone and iPad sizes
- `source/`: the original artwork

`icons/` contains the files the app itself uses (favicons, PWA icons including maskable variants, Apple touch icon, Electron `.ico`).

## License

GenGIS is released under the [MIT License](LICENSE).

Bundled third-party libraries keep their own licenses: Leaflet (BSD 2-Clause, `vendor/leaflet/LICENSE`) and Leaflet-Geoman (MIT, `vendor/geoman/LICENSE`). Map tiles and data come from third-party services with their own terms (see "Data sources and fair use" above). Airspace, LAANC and boundary layers are informational and not for navigation or flight authorization.
