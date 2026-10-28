# [GenGIS (G²)](https://g2.luiscintron.com)

![GenGIS](branding/png/gengis-banner-1200x300.png)

[![GenGIS Live](https://img.shields.io/badge/Live-g2.luiscintron.com-success?style=for-the-badge&logo=githubpages&logoColor=white)](https://g2.luiscintron.com)
[![Latest release](https://img.shields.io/github/v/release/lcintron/gengis?style=for-the-badge&logo=github&label=Release)](https://github.com/lcintron/gengis/releases/latest)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9-199900?style=for-the-badge&logo=leaflet&logoColor=white)](https://leafletjs.com/)
[![PWA and Electron](https://img.shields.io/badge/PWA%20%2B%20Electron-Web%20%26%20Desktop-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://github.com/lcintron/gengis/releases/latest)

Offline-first geospatial intelligence app: map, measure and annotate, overlay live or static data, and export your maps. Use built-in map services or bring your own, including ATAK/MOBAC map sources. Browser and desktop, with OneDrive and Google Drive sync.

**Use it now** at [g2.luiscintron.com](https://g2.luiscintron.com) (installable, works offline), or get the desktop app for [Windows, macOS or Linux](https://github.com/lcintron/gengis/releases/latest). No account or API key needed.

![GenGIS on the desktop: Tampa Bay with airspace and LAANC ceilings](docs/screenshots/desktop-map.jpg)

<p align="center">
  <img src="docs/screenshots/mobile-map.jpg" width="250" alt="GenGIS on a phone">
  <img src="docs/screenshots/mobile-menu.jpg" width="250" alt="The phone menu: units, base map and project">
  <img src="docs/screenshots/mobile-data.jpg" width="250" alt="Data sources on a phone">
</p>

## Features

**Map and annotate**
- Draw markers, text, lines, polygons, circles and preset shapes, with snapping, labels, colors, fill patterns and fonts.
- Place pictures, SVGs and 1,600+ [Lucide](https://lucide.dev) icons.
- Draw freehand with a stylus (its eraser end erases), or Shift + drag with a mouse.
- Move, resize, join and duplicate objects; copy a style onto others.
- Organize your work in layers and groups, with show/hide, lock and undo/redo.

**Measure and locate**
- Distances and areas in metric, imperial or nautical units.
- Latitude/longitude and MGRS grids; coordinates in decimal degrees, DM or DMS.
- Search addresses, places, coordinates and MGRS references, or find points of interest.
- Your location, with the direction the device points.
- Magnetic declination from the World Magnetic Model.

**Overlay data**
- **FAA data**, live for the area in view: airspace classes, special use airspace, LAANC ceilings, TFRs, airports and more. Click anywhere to see everything under that point.
- **Any public ArcGIS layer**, plus borders and place names.
- **Live air traffic (ADS-B)** from your own receiver or the adsb.fi and adsb.lol networks.
- **Live vessel traffic (AIS)** from your own AIS-catcher or aisstream.io.
- **Live drones (MAVLink)** from a [mavp2p](https://github.com/bluenviron/mavp2p) server. Read only: GenGIS never sends a vehicle a command.

**Base maps**
- Esri World Imagery, OpenStreetMap, OpenTopoMap and CyclOSM built in, and CARTO with a free key.
- Add your own XYZ or WMS sources, or import MOBAC map sources (as used by ATAK, such as the [ATAK-Maps](https://github.com/joshuafuller/ATAK-Maps) set).
- Download tiles and data for an area to use offline.

**Projects and sharing**
- Projects save automatically as you work, with recent projects and earlier copies to restore.
- Save and open `.gengis.json` files; import and export GeoJSON.
- Export the map as PNG, JPEG or PDF, at up to 4× resolution.
- **Cloud sync** to your own OneDrive (personal or Microsoft 365) or Google Drive. Files go straight between your device and your account, with no GenGIS server in between. A project edited in two places is never overwritten: you choose which version to keep. See the [privacy policy](https://g2.luiscintron.com/privacy.html).
- Presenter mode, and casting to a TV.

Informational only: not for navigation or flight authorization.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| V / G / K | Select / Move / Scale |
| M / T / L / P / R / C / S | Marker / Text / Line / Polygon / Shape / Circle / Image |
| N | Freehand annotation |
| I | Icons |
| D / A | Measure distance / area (Enter finishes) |
| F | Presenter mode |
| / | Search (also Ctrl/Cmd + F in the desktop app) |
| Esc / Delete or Backspace | Cancel or deselect / delete |
| Ctrl/Cmd + Z / Y / D / S | Undo / redo / duplicate / save |

## Connecting live data

Browsers only read another server's data when that server allows it (CORS), and an HTTPS page can't load plain `http://` data. The desktop app has neither limit.

| Source | Desktop app | Web app over `http://` | Web app over HTTPS |
| --- | --- | --- | --- |
| dump1090-fa, tar1090 (send CORS headers) | yes | yes | only on `localhost` or over HTTPS |
| Other dump1090 builds | yes | no | no |
| adsb.fi, adsb.lol | yes | no | no |
| AIS-catcher (web viewer on, `-N 8100`) | yes | yes | only on `localhost` or over HTTPS |
| aisstream.io (free API key) | yes | no | no |

**MAVLink:** the desktop app connects to mavp2p directly over TCP or UDP. A web page can't, so the web app connects through a WebSocket bridge.

| Connect | mavp2p endpoint | Address in GenGIS | Works in |
| --- | --- | --- | --- |
| TCP | `tcps:0.0.0.0:5760` | `192.168.1.20` | desktop app |
| UDP | `udps:0.0.0.0:14550` | `192.168.1.20` | desktop app |
| UDP, listen here | `udpc:<this computer>:14550` | `14550` | desktop app |
| WebSocket | `tcps:0.0.0.0:5760` + `websockify 5761 localhost:5760` | `192.168.1.20:5761` | desktop app; web app over `http://`, on `localhost` or with `wss://` |

For example: `mavp2p serial:/dev/ttyUSB0:57600 tcps:0.0.0.0:5760`.

## Links

Open the web app at a place: `?q=Eiffel+Tower`, `?lat=48.858&lon=2.294&zoom=16`, `?center=48.858,2.294` or `?poi=cafe`.

The installed desktop app opens `gengis://open?…` links with the same parameters, in the window already open. `gengis://open?file=<path>` opens a project file the app has opened or saved before.

## Android app

GenGIS is also a native Android app (package `com.luiscintron.gengis`). It reads what a web page can't: the adsb.fi and adsb.lol networks, aircraft look-ups, and receivers on your network over plain HTTP. Saving a project or exporting a map opens Android's share sheet, and the back button closes dialogs and panels first.

Not in the Android app yet: the aisstream.io stream, MAVLink over TCP or UDP (the WebSocket bridge works), and cloud sync.

## Data sources and fair use

| Data | Source |
| --- | --- |
| Map tiles | Each provider's own terms (attribution shown on the map) |
| Search and points of interest | [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) and the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) |
| FAA data | [FAA UAS Data Delivery System](https://udds-faa.opendata.arcgis.com/) |
| Borders | [Esri Living Atlas](https://livingatlas.arcgis.com/) |
| Place names | [Natural Earth](https://www.naturalearthdata.com/) (public domain) |
| Magnetic declination | NOAA's [World Magnetic Model](https://www.ncei.noaa.gov/products/world-magnetic-model) (public domain) |
| Air traffic | [adsb.fi](https://github.com/adsbfi/opendata) (personal, non-commercial use) and [adsb.lol](https://adsb.lol) (ODbL) |
| Vessel traffic | [aisstream.io](https://aisstream.io), with your own free key, kept on your device |

These are free public services, polled no faster than each allows. For heavy use, point GenGIS at your own servers (Project → Map & search APIs).

## License

GenGIS is **free for noncommercial use** under the [PolyForm Strict License 1.0.0](LICENSE). That covers personal use, hobby projects, study and research, and noncommercial organizations such as charities, schools, public research, public safety, health, environmental and government organizations. See the license for the exact terms.

**Commercial use, changes and redistribution need a commercial license.** Get in touch through [github.com/lcintron](https://github.com/lcintron).

Versions up to and including 0.16.2 were released under the MIT License and stay available under it. Bundled Leaflet (BSD 2-Clause), Leaflet-Geoman (MIT), polygon-clipping (MIT), html-to-image (MIT) and the Lucide icons (ISC) keep their own licenses. Live data services have their own terms of use, which apply to whoever uses them.

## For developers

```bash
node serve.js 8080        # web app at http://localhost:8080 (any static web server works)
npm install && npm start  # desktop app (Electron)
npm test                  # automated tests, no installs needed
```

`make` runs the same tasks (`make serve`, `make build`, `make release DRY=1`).

- **Tests** cover cloud sign-in and sync against a fake Microsoft and a fake Google, the desktop app's sign-in, load and stress runs, and checks of the page itself. They run on every pull request.
- **Releases** run in CI: Actions → Release → Run workflow on `main`, or `gh workflow run release.yml -f bump=auto`. The version bump follows conventional commits. The workflow tags the release, builds the Windows, macOS and Linux installers, publishes a GitHub Release and deploys the site. A dry run only reports the version.
- **Android** builds in CI: Actions → Android → Run workflow, or any pull request that touches the app.
  - It makes a debug APK for testing.
  - Once the signing secrets are set, it also makes a signed `.aab` for Google Play and a signed `.apk`.
  - Locally: `npm install`, `npx cap add android` (once), `npm run android:sync`, then open `android/` in Android Studio.
- **Android signing** (once):
  - Create an upload key: `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`.
  - Add the repository secrets `ANDROID_KEYSTORE_BASE64` (the file, base64-encoded), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
  - Keep the key safe: Google Play only accepts updates signed with it.

<details>
<summary><b>Setting up cloud sync</b> (once, for whoever hosts GenGIS)</summary>

Each provider stays hidden until GenGIS has its app registration. The consent screens use `privacy.html`, `terms.html` and the logos in `branding/store/`: 120 px for Google, 215 px for Microsoft.

**OneDrive** (Microsoft Entra app registration)

1. [entra.microsoft.com](https://entra.microsoft.com) → App registrations → New registration: name **GenGIS**, supported accounts **any Entra ID tenant and personal Microsoft accounts**.
2. Authentication → Add a platform:
   - **Single-page application**, redirect URIs `https://g2.luiscintron.com/` and `http://localhost:8080/`. No client secret.
   - **Mobile and desktop applications**, redirect URI `http://localhost`, for the desktop app. Microsoft accepts any port with it.
3. API permissions → Microsoft Graph, delegated: `Files.ReadWrite.AppFolder`, `offline_access`, `openid`, `profile`, `email`. Users consent for themselves.
4. Branding & properties:
   - logo `branding/store/gengis-logo-215.png`;
   - home page, terms and privacy URLs;
   - publisher domain `g2.luiscintron.com`, verified by `.well-known/microsoft-identity-association.json`;
   - then publisher verification, which lets more Microsoft 365 organizations allow the app.
5. Put the Application (client) ID in `CLIENT_ID` in `js/cloud-onedrive.js`. Use this one registration everywhere (web, desktop, Android), adding platforms to it. A second registration would get a folder of its own.

A web sign-in lasts 24 hours, and GenGIS renews it on start-up, usually without asking. The desktop app stays signed in, its sign-in kept encrypted by the operating system.

**Google Drive** (Google Cloud project)

1. [console.cloud.google.com](https://console.cloud.google.com) → new project **GenGIS** → enable the **Google Drive API**.
2. Google Auth Platform:
   - **Branding**: name **GenGIS**, logo `branding/store/gengis-logo-120.png`, home page, privacy and terms URLs, authorized domain `luiscintron.com`.
   - **Audience**: External.
   - **Data access**: `openid`, `email`, `profile` and `.../auth/drive.file`, which reaches only files GenGIS creates.
3. Clients → **Web application**, with JavaScript origins `https://g2.luiscintron.com` and `http://localhost:8080`. Put its ID in `WEB_CLIENT_ID` in `js/cloud-gdrive.js`.
4. Clients → **Desktop app**. Put its ID in `PROVIDERS.gdrive` in `electron/cloudauth.js`. Keep its secret out of the repository:
   - add it as the repository secret `GOOGLE_DESKTOP_CLIENT_SECRET`;
   - for development, put `{"googleDesktopSecret": "…"}` in `electron/cloud-secrets.json` (ignored by git).
5. Keep both clients in this one project, so each can see the files the other created.
6. Publish the app (Audience → Publish) and submit the branding for verification.

A web sign-in lasts one hour; after that, a tap on **Sign in** reconnects, and nothing is lost meanwhile. The desktop app stays signed in.

</details>
