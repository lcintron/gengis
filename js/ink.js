/* GenGIS - the annotation tool: freehand ink drawn with a stylus, into the "Annotations" layer
 * - a pen only: fingers and the mouse keep moving and zooming the map (a resting palm draws nothing)
 * - three tips: a pen (fine, solid), a marker (broad, solid) and a highlighter (wide, see-through, neon colors);
 *   each keeps its own color and size
 * - its options sit where a tool's instructions go (the tool hint, top center of the map)
 * - a stroke is an object of type 'ink' (a line without vertex editing): selected, moved, scaled, restyled and
 *   deleted like the others; one undo step each
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const LAYER = 'Annotations';
  const TIPS = {
    pen: { name: 'Pen', sizes: [1.5, 2.5, 4, 6], opacity: 1 },
    marker: { name: 'Marker', sizes: [4, 6, 9, 13], opacity: 0.95 },
    highlighter: { name: 'Highlighter', sizes: [10, 16, 24, 34], opacity: 0.45 }
  };
  const INKS = ['#111418', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];
  const NEON = ['#faff00', '#39ff14', '#00f0ff', '#ff3ef5', '#ff9f1c', '#b388ff'];
  const ICONS = {
    pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 7l3.5 3.5" stroke="currentColor" stroke-width="1.8"/></svg>',
    marker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19l2-6 8.5-8.5a2.1 2.1 0 0 1 3 3L10 16z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M7 13l4 4" stroke="currentColor" stroke-width="1.8"/><path d="M4 21h5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
    highlighter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 15l-2.5 2.5L4 17l1-3 6.5-6.5 5 5L10 19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M11.5 7.5L15 4l5 5-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 21h9" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".55"/></svg>'
  };

  // The choices as stored: the tip in use, and each tip's color and size (an index into its sizes).
  function conf() {
    const c = MB.settings.ink || (MB.settings.ink = {}); // filled in where it is (what holds it sees the changes)
    if (!TIPS[c.tip]) c.tip = 'pen';
    c.tips = c.tips || {};
    Object.keys(TIPS).forEach(k => { c.tips[k] = Object.assign({ color: k === 'highlighter' ? NEON[0] : k === 'marker' ? INKS[6] : INKS[2], size: 1 }, c.tips[k]); }); // red pen, blue marker: seen on light and dark maps
    return c;
  }
  const save = () => MB.saveSettings();

  // The style a stroke gets now.
  function strokeStyle() {
    const c = conf(), tip = TIPS[c.tip], t = c.tips[c.tip];
    return { color: t.color, weight: tip.sizes[Math.max(0, Math.min(tip.sizes.length - 1, t.size))], opacity: tip.opacity, dash: 'solid', fill: false, ink: c.tip };
  }

  // The layer strokes go to: "Annotations", made (not activated) on the first stroke.
  function inkLayer() {
    return MB.state.layers.find(l => l.name.trim().toLowerCase() === LAYER.toLowerCase()) || MB.createLayer(LAYER, { activate: false });
  }

  MB.ink = {
    active: false, stroke: null,

    init() {
      const wrap = document.getElementById('mapwrap');
      // the capture phase on the map's parent: the pen's events never reach Leaflet (no pan, no click on an object)
      wrap.addEventListener('pointerdown', e => this.down(e), true);
      wrap.addEventListener('pointermove', e => this.move(e), true);
      ['pointerup', 'pointercancel'].forEach(t => wrap.addEventListener(t, e => this.up(e, t === 'pointercancel'), true));
      wrap.addEventListener('click', e => { if (this.swallow && Date.now() < this.swallow && this.onMap(e)) { e.stopPropagation(); e.preventDefault(); } }, true); // the stroke's own click
      MB.map.on('zoomstart', () => this.cancel()); // a pinch while drawing: the stroke would land elsewhere
    },

    start() {
      this.active = true;
      MB.map.getContainer().classList.add('mb-ink-tool');
    },
    stop() {
      this.cancel();
      this.active = false;
      MB.map.getContainer().classList.remove('mb-ink-tool');
    },

    /* ---------- drawing ---------- */
    onMap(e) { // over the map itself, not a control, the toolbar or the hint
      const t = e.target;
      return t && t.closest && t.closest('.leaflet-container') && !t.closest('.leaflet-control-container, .tool-hint, #toolbar, .mb-scale-box');
    },
    down(e) {
      if (!this.active || e.pointerType !== 'pen' || this.stroke || !this.onMap(e)) return;
      if (e.button !== 0) return; // the barrel button (2) or the eraser end (5): not ink
      e.preventDefault(); e.stopPropagation();
      const style = strokeStyle(), ls = MB.toLeafletStyle(style);
      const p = this.point(e);
      this.stroke = {
        id: e.pointerId, style, pts: [p],
        preview: L.polyline([MB.map.containerPointToLatLng(p), MB.map.containerPointToLatLng(p)], Object.assign(ls, { fill: false, interactive: false, className: 'mb-ink mb-ink-' + style.ink })).addTo(MB.map)
      };
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* gone already */ }
    },
    move(e) {
      const s = this.stroke;
      if (!s || e.pointerId !== s.id) return;
      e.preventDefault(); e.stopPropagation();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      (evs.length ? evs : [e]).forEach(ev => {
        const p = this.point(ev), last = s.pts[s.pts.length - 1];
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 1) s.pts.push(p);
      });
      if (!s.frame) s.frame = requestAnimationFrame(() => { s.frame = 0; if (this.stroke === s) s.preview.setLatLngs(s.pts.map(q => MB.map.containerPointToLatLng(q))); });
    },
    up(e, cancelled) {
      const s = this.stroke;
      if (!s || e.pointerId !== s.id) return;
      e.preventDefault(); e.stopPropagation();
      this.swallow = Date.now() + 400;
      this.stroke = null;
      if (s.frame) cancelAnimationFrame(s.frame);
      MB.map.removeLayer(s.preview);
      if (cancelled) return;
      this.add(s);
    },
    cancel() {
      const s = this.stroke;
      if (!s) return;
      this.stroke = null;
      if (s.frame) cancelAnimationFrame(s.frame);
      MB.map.removeLayer(s.preview);
    },
    point(e) {
      const r = MB.map.getContainer().getBoundingClientRect();
      return L.point(e.clientX - r.left, e.clientY - r.top);
    },

    // The stroke as an object: its points thinned (what the eye cannot tell apart), a tap as a dot.
    add(s) {
      let pts = s.pts.length > 2 ? L.LineUtil.simplify(s.pts, 0.6) : s.pts.slice();
      if (pts.length === 1) pts = [pts[0], pts[0].add(L.point(0.5, 0))];
      const layer = inkLayer();
      if (!layer.visible) { MB.setLayerVisible(layer.id, true); MB.toast('The Annotations layer was hidden: it is shown again'); }
      const f = MB.restoreFeature({ type: 'ink', layerId: layer.id, style: s.style, latlngs: pts.map(p => { const ll = MB.map.containerPointToLatLng(p); return [ll.lat, ll.lng]; }) });
      if (f) MB.commit('annotate');
    },

    /* ---------- the options, in the tool hint ---------- */
    renderBar(hint) {
      const c = conf(), tip = TIPS[c.tip], t = c.tips[c.tip], colors = c.tip === 'highlighter' ? NEON : INKS;
      const dot = w => Math.max(4, Math.min(20, w * (c.tip === 'highlighter' ? 0.6 : 1.4)));
      hint.innerHTML = `<div class="ink-bar" role="toolbar" aria-label="Annotation options">
        <div class="ink-row">
          <div class="ink-group" role="radiogroup" aria-label="Tip">${Object.keys(TIPS).map(k => `<button type="button" role="radio" class="ink-tip${k === c.tip ? ' active' : ''}" aria-checked="${k === c.tip}" data-tip="${k}" title="${TIPS[k].name}">${ICONS[k]}<span>${TIPS[k].name}</span></button>`).join('')}</div>
          <span class="ink-sep" aria-hidden="true"></span>
          <div class="ink-group" role="radiogroup" aria-label="Stroke width">${tip.sizes.map((w, i) => `<button type="button" role="radio" class="ink-size${i === t.size ? ' active' : ''}" aria-checked="${i === t.size}" data-size="${i}" title="${w} px" aria-label="${['Fine', 'Medium', 'Broad', 'Extra broad'][i]} (${w} px)"><i style="width:${dot(w)}px;height:${dot(w)}px;background:${esc(t.color)};opacity:${tip.opacity < 1 ? 0.7 : 1}"></i></button>`).join('')}</div>
        </div>
        <div class="ink-row">
          <div class="ink-group ink-colors" role="radiogroup" aria-label="Color">${colors.map(col => `<button type="button" role="radio" class="ink-color${col === t.color ? ' active' : ''}" aria-checked="${col === t.color}" data-color="${col}" title="${col}" aria-label="Color ${col}"><i style="background:${col}"></i></button>`).join('')}
            <label class="ink-color ink-custom${colors.includes(t.color) ? '' : ' active'}" title="Another color"><input type="color" value="${esc(t.color)}" aria-label="Another color"><i style="background:${colors.includes(t.color) ? 'conic-gradient(#f44, #fd0, #4d4, #0cf, #44f, #f4f, #f44)' : esc(t.color)}"></i></label>
          </div>
        </div>
        <div class="ink-note">Draw with a stylus. Fingers<span class="ink-mouse"> and the mouse</span> move the map.</div>
      </div>`;
      const bar = hint.firstElementChild;
      const refocus = sel => { const b = hint.querySelector(sel); if (b) b.focus(); };
      bar.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.tip) { c.tip = b.dataset.tip; save(); this.renderBar(hint); refocus(`[data-tip="${c.tip}"]`); }
        else if (b.dataset.size) { c.tips[c.tip].size = +b.dataset.size; save(); this.renderBar(hint); refocus(`[data-size="${b.dataset.size}"]`); }
        else if (b.dataset.color) { c.tips[c.tip].color = b.dataset.color; save(); this.renderBar(hint); refocus(`[data-color="${b.dataset.color}"]`); }
      });
      const pick = bar.querySelector('input[type="color"]');
      pick.addEventListener('input', () => { c.tips[c.tip].color = pick.value; save(); });
      pick.addEventListener('change', () => { this.renderBar(hint); refocus('.ink-custom input'); });
      bar.addEventListener('keydown', e => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); }); // the app's letter shortcuts stay out
      MB.ui.radios(bar);
    }
  };
})(window.MB);
