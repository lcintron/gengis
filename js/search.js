/* GenGIS - search: coordinates, Nominatim geocoding, Overpass points of interest */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  MB.defaultSearchSettings = {
    geocoderSearchUrl: 'https://nominatim.openstreetmap.org/search',
    geocoderReverseUrl: 'https://nominatim.openstreetmap.org/reverse',
    geocoderKeyParam: '', geocoderKey: '',
    overpassUrls: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
  };
  const cfg = k => (MB.settings && MB.settings.search && MB.settings.search[k]) || MB.defaultSearchSettings[k];
  const withKey = url => { const kp = cfg('geocoderKeyParam'), kv = cfg('geocoderKey'); if (kp && kv) url.searchParams.set(kp, kv); return url; };

  MB.poiCategories = [
    ['Restaurants', 'amenity', 'restaurant'], ['Cafés', 'amenity', 'cafe'], ['Bars & pubs', 'amenity', 'bar|pub'],
    ['Fast food', 'amenity', 'fast_food'], ['Supermarkets', 'shop', 'supermarket|convenience'], ['Any shop', 'shop', '*'],
    ['Hotels', 'tourism', 'hotel|motel|guest_house|hostel'], ['Attractions', 'tourism', 'attraction|viewpoint'],
    ['Museums', 'tourism', 'museum|gallery'], ['Parks', 'leisure', 'park|garden'], ['Playgrounds', 'leisure', 'playground'],
    ['Sports', 'leisure', 'sports_centre|pitch|stadium|fitness_centre'], ['Hospitals', 'amenity', 'hospital|clinic'],
    ['Pharmacies', 'amenity', 'pharmacy'], ['Schools', 'amenity', 'school|college|university|kindergarten'],
    ['Banks & ATMs', 'amenity', 'bank|atm'], ['Fuel stations', 'amenity', 'fuel'], ['EV charging', 'amenity', 'charging_station'],
    ['Parking', 'amenity', 'parking'], ['Places of worship', 'amenity', 'place_of_worship'], ['Police', 'amenity', 'police'],
    ['Fire stations', 'amenity', 'fire_station'], ['Toilets', 'amenity', 'toilets'], ['Post offices', 'amenity', 'post_office'],
    ['Libraries', 'amenity', 'library'], ['Train stations', 'railway', 'station|halt'], ['Bus stops', 'highway', 'bus_stop'],
    ['Airports', 'aeroway', 'aerodrome'], ['Peaks', 'natural', 'peak'], ['Water', 'natural', 'water']
  ];

  MB.search = {
    marker: null, lastResults: [],

    async geocode(q, opts) {
      opts = opts || {};
      const url = withKey(new URL(cfg('geocoderSearchUrl')));
      url.searchParams.set('q', q);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', String(opts.limit || 8));
      url.searchParams.set('addressdetails', '1');
      if (opts.viewbox) {
        const b = opts.viewbox;
        url.searchParams.set('viewbox', [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(','));
        url.searchParams.set('bounded', opts.bounded ? '1' : '0');
      }
      const r = await fetch(url.toString(), { headers: { 'Accept': 'application/json', 'Accept-Language': navigator.language || 'en' } });
      if (!r.ok) throw new Error('Geocoder error ' + r.status);
      return r.json();
    },

    async reverse(ll) {
      const url = withKey(new URL(cfg('geocoderReverseUrl')));
      url.searchParams.set('lat', ll.lat); url.searchParams.set('lon', ll.lng);
      url.searchParams.set('format', 'json');
      const r = await fetch(url.toString(), { headers: { 'Accept': 'application/json', 'Accept-Language': navigator.language || 'en' } });
      if (!r.ok) throw new Error('Reverse geocoder error ' + r.status);
      return r.json();
    },

    // Resolve free text: coordinates first, then the geocoder. Returns [{label, latlng, bounds?}]
    async resolve(q) {
      const ll = MB.parseCoords(q);
      if (ll) return [{ label: 'Coordinates ' + MB.formatLatLng(ll), latlng: ll, type: 'coordinates' }];
      const res = await this.geocode(q, { viewbox: MB.map.getBounds(), bounded: false });
      return res.map(r => ({
        label: r.display_name, type: (r.type || r.category || '').replace(/_/g, ' '),
        latlng: L.latLng(+r.lat, +r.lon),
        bounds: r.boundingbox ? L.latLngBounds([+r.boundingbox[0], +r.boundingbox[2]], [+r.boundingbox[1], +r.boundingbox[3]]) : null,
        raw: r
      }));
    },

    goTo(res, opts) {
      opts = opts || {};
      if (res.bounds && res.bounds.isValid() && res.type !== 'coordinates') {
        MB.map.fitBounds(res.bounds, { maxZoom: opts.maxZoom || 17, padding: [20, 20] });
      } else {
        MB.map.setView(res.latlng, opts.zoom || Math.max(MB.map.getZoom(), 16));
      }
      this.showMarker(res.latlng, res.label);
    },

    showMarker(latlng, label) {
      this.clearMarker();
      const m = L.marker(latlng, { icon: MB.pinIcon('#2f80ed'), pmIgnore: true, zIndexOffset: 1500 }).addTo(MB.map);
      const el = document.createElement('div');
      el.className = 'mb-popup';
      el.innerHTML = `<div class="mb-popup-title">${MB.escapeHtml(label)}</div>
        <div class="mb-popup-coords">${MB.formatLatLng(latlng)}</div>
        <div class="mb-popup-actions"><button class="btn small" data-act="add">Add marker to layer</button>
        <button class="btn small ghost" data-act="copy">Copy coords</button>
        <button class="btn small ghost" data-act="close">Dismiss</button></div>`;
      el.addEventListener('click', ev => {
        const act = ev.target.getAttribute('data-act');
        if (act === 'add') {
          const f = MB.restoreFeature({ type: 'marker', latlng: [latlng.lat, latlng.lng], name: label.split(',')[0], style: MB.newShapeStyle(true) });
          MB.commit('add search marker');
          this.clearMarker();
          if (f) MB.selectFeature(f);
        } else if (act === 'copy') {
          navigator.clipboard && navigator.clipboard.writeText(MB.formatLatLng(latlng, 6)).then(() => MB.toast('Coordinates copied'));
        } else if (act === 'close') this.clearMarker();
      });
      m.bindPopup(el, { maxWidth: 320, closeButton: false, autoPan: true }).openPopup();
      this.marker = m;
    },

    clearMarker() {
      if (this.marker) { MB.map.removeLayer(this.marker); this.marker = null; }
    },

    /* ----- Overpass points of interest ----- */

    async overpass(query) {
      let lastErr = null;
      for (const endpoint of cfg('overpassUrls')) {
        try {
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query)
          });
          if (r.ok) return r.json();
          lastErr = new Error('Overpass error ' + r.status + (r.status === 429 ? ' (rate limited)' : r.status >= 500 ? ' (server busy)' : ''));
          if (r.status >= 400 && r.status < 500 && r.status !== 429) break; // bad query: no point retrying elsewhere
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('Overpass unavailable');
    },

    // key/value: OSM tag; value '*' = any; multiple values separated by '|'. name: optional regex filter.
    async findPois(key, value, name, bounds, limit) {
      const b = bounds || MB.map.getBounds();
      const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(v => v.toFixed(5)).join(',');
      let filter = '';
      if (key) {
        const k = key.replace(/["\\]/g, '');
        if (!value || value === '*') filter += `["${k}"]`;
        else if (value.includes('|')) filter += `["${k}"~"^(${value.replace(/["\\]/g, '')})$"]`;
        else filter += `["${k}"="${value.replace(/["\\]/g, '')}"]`;
      }
      if (name) filter += `["name"~"${name.replace(/["\\]/g, '')}",i]`;
      if (!filter) throw new Error('Choose a category or type a name');
      const q = `[out:json][timeout:25];nwr${filter}(${bbox});out center ${limit || 100};`;
      const data = await this.overpass(q);
      return (data.elements || []).map(el => {
        const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
        const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
        if (lat == null) return null;
        const tags = el.tags || {};
        const kind = tags.amenity || tags.shop || tags.tourism || tags.leisure || tags.natural || tags.railway || tags.highway || tags.aeroway || key || '';
        return { id: el.type + '/' + el.id, name: tags.name || tags.brand || ('(unnamed ' + kind.replace(/_/g, ' ') + ')'), kind: kind.replace(/_/g, ' '), latlng: L.latLng(lat, lon), tags };
      }).filter(Boolean);
    }
  };

  /* ----- URL parameters: ?q=..., ?lat=..&lon=..&zoom=.., ?center=lat,lon, ?poi=cafe ----- */
  MB.applyUrlParams = async function () {
    const p = new URLSearchParams(location.search);
    const zoom = p.get('zoom') || p.get('z');
    let centered = false;
    if (p.get('center')) {
      const ll = MB.parseCoords(p.get('center'));
      if (ll) { MB.map.setView(ll, zoom ? +zoom : 15); centered = true; }
    } else if (p.get('lat') && (p.get('lon') || p.get('lng'))) {
      const ll = L.latLng(+p.get('lat'), +(p.get('lon') || p.get('lng')));
      MB.map.setView(ll, zoom ? +zoom : 15); centered = true;
    }
    if (p.get('q')) {
      try {
        const res = await MB.search.resolve(p.get('q'));
        if (res.length) MB.search.goTo(res[0]);
        else MB.toast('No results for "' + p.get('q') + '"');
      } catch (e) { MB.toast('Search failed: ' + e.message); }
    }
    if (p.get('poi')) {
      MB.emit('poi-request', p.get('poi'));
    }
    return centered;
  };
})(window.MB);
