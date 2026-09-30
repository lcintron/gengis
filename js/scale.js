/* GenGIS - two-block scale bar (bottom-right), metric or imperial */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  function roundNum(num) {
    if (!(num > 0)) return 0;
    const pow10 = Math.pow(10, Math.floor(Math.log10(num)));
    let d = num / pow10;
    d = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
    return pow10 * d;
  }
  function fmt(n) {
    return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 0 : 2 });
  }

  MB.TwoBlockScale = L.Control.extend({
    options: { position: 'bottomright', maxWidth: 200 },

    onAdd(map) {
      this._map = map;
      this._el = L.DomUtil.create('div', 'mb-scale');
      L.DomEvent.disableClickPropagation(this._el);
      map.on('move zoom zoomend moveend resize', this.update, this);
      this.update();
      return this._el;
    },

    onRemove(map) { map.off('move zoom zoomend moveend resize', this.update, this); },

    update() {
      const map = this._map;
      if (!map || !this._el) return;
      const y = map.getSize().y / 2;
      const maxMeters = map.distance(map.containerPointToLatLng([0, y]), map.containerPointToLatLng([this.options.maxWidth, y]));
      if (!(maxMeters > 0)) return;
      const imperial = MB.state.units === 'imperial';
      const half = maxMeters / 2;
      let perMeter, unit;
      if (imperial) {
        if (half >= 1609.344) { perMeter = 1 / 1609.344; unit = 'mi'; } else { perMeter = 3.2808399; unit = 'ft'; }
      } else if (half >= 1000) { perMeter = 0.001; unit = 'km'; } else { perMeter = 1; unit = 'm'; }
      const block = roundNum(half * perMeter);
      const total = block * 2;
      const width = Math.round(this.options.maxWidth * total / (maxMeters * perMeter));
      this._el.style.width = width + 'px';
      this._el.innerHTML =
        '<div class="mb-scale-bar"><span></span><span></span></div>' +
        `<div class="mb-scale-labels"><span>0</span><span>${fmt(block)}</span><span>${fmt(total)} ${unit}</span></div>`;
    }
  });
})(window.MB);
