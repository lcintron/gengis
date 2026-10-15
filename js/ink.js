/* GenGIS - the annotation tool: freehand ink drawn with a stylus, into the "Annotations" layer
 * - a pen only: fingers and the mouse keep moving and zooming the map (a resting palm draws nothing)
 * - a pen (solid) and a highlighter (wide, see-through, neon colors), each with its own color and size, and an eraser
 *   in four sizes that wipes what it passes over (a stroke it crosses is cut in two); the stylus's own eraser end
 *   erases too, whichever is chosen. Strokes drawn with the marker of 0.13.0 stay as they were drawn.
 * - its options sit where a tool's instructions go (the tool hint, top center of the map)
 * - a stroke is an object of type 'ink' (a line without vertex editing): selected, moved, scaled, restyled and
 *   deleted like the others; one undo step each (a stroke, or a wipe of the eraser)
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const LAYER = 'Annotations';
  const TIPS = {
    pen: { name: 'Pen', sizes: [1.5, 2.5, 4, 6], opacity: 1 },
    highlighter: { name: 'Highlighter', sizes: [10, 16, 24, 34], opacity: 0.45 },
    eraser: { name: 'Eraser', sizes: [10, 20, 36, 56], eraser: true } // its sizes: the diameter wiped, in screen pixels
  };
  const INKS = ['#111418', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];
  const NEON = ['#faff00', '#39ff14', '#00f0ff', '#ff3ef5', '#ff9f1c', '#b388ff'];
  const ICONS = {
    pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 7l3.5 3.5" stroke="currentColor" stroke-width="1.8"/></svg>',
    highlighter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 15l-2.5 2.5L4 17l1-3 6.5-6.5 5 5L10 19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M11.5 7.5L15 4l5 5-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 21h9" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".55"/></svg>',
    eraser: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 21L3.3 17.3a1 1 0 0 1 0-1.4L14.6 4.6a1 1 0 0 1 1.4 0l4.4 4.4a1 1 0 0 1 0 1.4L9.8 21z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 10.5l5 5M7 21h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };

  // The choices as stored: the tip in use, and each tip's color and size (an index into its sizes).
  function conf() {
    const c = MB.settings.ink || (MB.settings.ink = {}); // filled in where it is (what holds it sees the changes)
    if (!TIPS[c.tip]) c.tip = 'pen';
    c.tips = c.tips || {};
    Object.keys(TIPS).forEach(k => { c.tips[k] = Object.assign({ color: k === 'highlighter' ? NEON[0] : INKS[2], size: 1 }, c.tips[k]); }); // a red pen: seen on light and dark maps
    return c;
  }
  const save = () => MB.saveSettings();

  // The style a stroke gets now.
  function strokeStyle() {
    const c = conf(), tip = TIPS[c.tip], t = c.tips[c.tip];
    return { color: t.color, weight: tip.sizes[Math.max(0, Math.min(tip.sizes.length - 1, t.size))], opacity: tip.opacity, dash: 'solid', fill: false, ink: c.tip };
  }

  // How wide the eraser wipes now (screen pixels).
  const eraserSize = () => { const c = conf(); return TIPS.eraser.sizes[Math.max(0, Math.min(3, c.tips.eraser.size))]; };

  // A line's points with more in between, none further apart than step: what the eraser touches can be told point by
  // point however long a stroke's straight stretches are.
  function densify(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(a.distanceTo(b) / step));
      for (let k = 1; k <= n; k++) out.push(L.point(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n));
    }
    return out;
  }

  // The layer strokes go to: "Annotations", made (not activated) on the first stroke.
  const isInkLayer = l => l.name.trim().toLowerCase() === LAYER.toLowerCase();
  function inkLayer() {
    return MB.state.layers.find(isInkLayer) || MB.createLayer(LAYER, { activate: false });
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
      // the eraser's ring: gone once the pen leaves (lifted out of range, or onto the panel), or the page is hidden
      wrap.addEventListener('pointerleave', e => { if (!this.stroke && e.pointerType === 'pen' && (e.target === wrap || e.target === MB.map.getContainer())) this.hideCursor(); }, true); // (not each tile it crosses)
      document.addEventListener('visibilitychange', () => { if (document.hidden && !this.stroke) this.hideCursor(); });
    },

    start() {
      this.active = true;
      MB.map.getContainer().classList.add('mb-ink-tool');
    },
    stop() {
      this.cancel();
      this.hideCursor();
      this.active = false;
      MB.map.getContainer().classList.remove('mb-ink-tool');
    },

    /* ---------- drawing ---------- */
    onMap(e) { // over the map itself, not a control, the toolbar or the hint
      const t = e.target;
      return t && t.closest && t.closest('.leaflet-container') && !t.closest('.leaflet-control-container, .tool-hint, #toolbar, .mb-scale-box');
    },
    down(e) {
      if (this.stroke && e.pointerType !== 'pen') { e.preventDefault(); e.stopPropagation(); return; } // a palm on the glass while writing: nothing
      if (!this.active || e.pointerType !== 'pen' || this.stroke || !this.onMap(e)) return;
      const end = e.button === 5 || (e.buttons & 32); // the stylus turned over: its eraser end
      if (e.button !== 0 && !end) return; // the barrel button (2): nothing
      e.preventDefault(); e.stopPropagation();
      const target = MB.state.layers.find(isInkLayer), erase = end || conf().tip === 'eraser';
      if (erase && target && !target.visible) MB.toast('The Annotations layer is hidden: show it to erase its strokes');
      if (target && target.locked) { MB.toast('The Annotations layer is locked: unlock it to ' + (erase ? 'erase' : 'annotate')); return; }
      this.hold(true);
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* gone already */ }
      if (erase) {
        const p = this.point(e);
        this.stroke = { id: e.pointerId, erase: true, r: eraserSize() / 2, last: p, todo: [p], changed: false };
        this.showCursor(p);
        this.eraseAlong(this.stroke);
        return;
      }
      const style = strokeStyle(), ls = MB.toLeafletStyle(style);
      const p = this.point(e);
      this.stroke = {
        id: e.pointerId, style, pts: [p],
        preview: L.polyline([MB.map.containerPointToLatLng(p), MB.map.containerPointToLatLng(p)], Object.assign(ls, { fill: false, interactive: false, className: 'mb-ink mb-ink-' + style.ink })).addTo(MB.map)
      };
    },
    move(e) {
      const s = this.stroke;
      if (s && e.pointerType !== 'pen') { e.stopPropagation(); return; } // the palm again
      if (!s) { // the pen hovering: the eraser's ring follows it
        if (this.active && e.pointerType === 'pen' && conf().tip === 'eraser' && this.onMap(e)) this.showCursor(this.point(e));
        else this.hideCursor();
        return;
      }
      if (e.pointerId !== s.id) return;
      e.preventDefault(); e.stopPropagation();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (s.erase) {
        (evs.length ? evs : [e]).forEach(ev => s.todo.push(this.point(ev)));
        this.showCursor(s.todo[s.todo.length - 1]);
        if (!s.frame) s.frame = requestAnimationFrame(() => { s.frame = 0; if (this.stroke === s) this.eraseAlong(s); });
        return;
      }
      (evs.length ? evs : [e]).forEach(ev => {
        const p = this.point(ev), last = s.pts[s.pts.length - 1];
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 1) s.pts.push(p);
      });
      if (!s.frame) s.frame = requestAnimationFrame(() => { s.frame = 0; if (this.stroke === s) s.preview.setLatLngs(s.pts.map(q => MB.map.containerPointToLatLng(q))); });
    },
    up(e, cancelled) {
      const s = this.stroke;
      if (s && e.pointerType !== 'pen') { e.stopPropagation(); return; }
      if (!s || e.pointerId !== s.id) return;
      e.preventDefault(); e.stopPropagation();
      this.swallow = Date.now() + 400;
      if (s.erase) { this.endErase(s); return; }
      this.stroke = null;
      this.hold(false);
      if (s.frame) cancelAnimationFrame(s.frame);
      MB.map.removeLayer(s.preview);
      if (cancelled) return;
      this.add(s);
    },
    cancel() {
      const s = this.stroke;
      this.hideCursor();
      if (!s) return;
      if (s.erase) { this.endErase(s); return; } // what it wiped stays wiped (and is one undo step)
      this.stroke = null;
      this.hold(false);
      if (s.frame) cancelAnimationFrame(s.frame);
      MB.map.removeLayer(s.preview);
    },
    // While a stroke is drawn the map stays put: its drag and pinch are off (what Leaflet might start from a touch
    // that got through before the pen), back as they were after.
    hold(on) {
      const m = MB.map;
      if (on) { this.held = ['dragging', 'touchZoom'].filter(h => m[h] && m[h].enabled()); this.held.forEach(h => m[h].disable()); }
      else if (this.held) { this.held.forEach(h => m[h].enable()); this.held = null; }
    },
    point(e) {
      const r = MB.map.getContainer().getBoundingClientRect();
      return L.point(e.clientX - r.left, e.clientY - r.top);
    },

    /* ---------- erasing ---------- */
    // Wipe along the path the pen took since the last pass: every annotation stroke it touches loses what lies under
    // the eraser (a stroke crossed in the middle becomes two), and one wholly under it goes.
    eraseAlong(s) {
      const path = s.todo; s.todo = [];
      if (!path.length) return;
      const r = s.r, step = Math.max(1, r / 3), centers = densify([s.last].concat(path), step);
      s.last = path[path.length - 1];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      centers.forEach(c => { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y); });
      const map = MB.map, hit = [];
      Object.values(MB.featureLayers).forEach(f => {
        const m = f.mb;
        if (m.type !== 'ink' || !map.hasLayer(f) || MB.isFeatureLocked(f)) return;
        const reach = r + (+m.style.weight || 2) / 2, b = f.getBounds();
        const p0 = map.latLngToContainerPoint(b.getNorthWest()), p1 = map.latLngToContainerPoint(b.getSouthEast());
        if (p1.x < x0 - reach || p0.x > x1 + reach || p1.y < y0 - reach || p0.y > y1 + reach) return; // nowhere near
        const pts = densify(f.getLatLngs().map(ll => map.latLngToContainerPoint(ll)), step), r2 = reach * reach;
        const gone = pts.map(q => centers.some(c => (c.x - q.x) * (c.x - q.x) + (c.y - q.y) * (c.y - q.y) <= r2));
        if (!gone.some(Boolean)) return;
        const runs = []; let run = [];
        pts.forEach((q, i) => { if (gone[i]) { if (run.length > 1) runs.push(run); run = []; } else run.push(q); });
        if (run.length > 1) runs.push(run);
        hit.push({ f, runs });
      });
      if (!hit.length) return;
      s.changed = true;
      const order = Object.keys(MB.featureLayers), pieces = {};
      MB.batch(() => {
        hit.forEach(({ f, runs }) => {
          const d = MB.serializeFeature(f), id = f.mb.id;
          MB.removeFeature(id, { silent: true }); // (no history step of its own: the wipe is one, at the end)
          pieces[id] = runs.map(run => { // what is left of it: its own stroke, as it was drawn
            const left = Object.assign({}, d, { id: undefined, latlngs: L.LineUtil.simplify(run, 0.6).map(q => { const ll = map.containerPointToLatLng(q); return [ll.lat, ll.lng]; }) });
            const l = MB.restoreFeature(left);
            return l && l.mb.id;
          }).filter(Boolean);
        });
        // the pieces where the stroke was in the draw order (added, they would go on top of everything)
        const fl = MB.featureLayers, all = Object.assign({}, fl), seq = [];
        order.forEach(id => { if (pieces[id]) seq.push(...pieces[id]); else if (all[id]) seq.push(id); });
        Object.keys(all).forEach(id => { if (!seq.includes(id)) seq.push(id); });
        Object.keys(fl).forEach(id => { delete fl[id]; });
        seq.forEach(id => { fl[id] = all[id]; });
        MB.applyZOrderSoon();
        MB.emit('features');
      });
    },
    endErase(s) {
      if (s.frame) cancelAnimationFrame(s.frame);
      this.eraseAlong(s);
      this.stroke = null;
      this.hold(false);
      this.hideCursor();
      this.swallow = Date.now() + 400;
      if (s.changed) MB.commit('erase');
    },
    // The eraser's ring under the pen: what it is about to wipe.
    showCursor(p) {
      let el = this.cursor;
      if (!el) { el = this.cursor = document.createElement('div'); el.className = 'ink-eraser-ring'; el.setAttribute('aria-hidden', 'true'); }
      if (el.parentNode !== MB.map.getContainer()) MB.map.getContainer().appendChild(el);
      const d = this.stroke && this.stroke.erase ? this.stroke.r * 2 : eraserSize();
      Object.assign(el.style, { display: 'block', width: d + 'px', height: d + 'px', left: (p.x - d / 2) + 'px', top: (p.y - d / 2) + 'px' });
    },
    hideCursor() { if (this.cursor) this.cursor.style.display = 'none'; },

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
      const c = conf(), tip = TIPS[c.tip], t = c.tips[c.tip], colors = c.tip === 'highlighter' ? NEON : INKS, eraser = !!tip.eraser;
      const dot = w => (eraser ? Math.max(6, Math.min(22, w * 0.4)) : Math.max(4, Math.min(20, w * (c.tip === 'highlighter' ? 0.6 : 1.4))));
      const names = eraser ? ['Small', 'Medium', 'Large', 'Extra large'] : ['Fine', 'Medium', 'Broad', 'Extra broad'];
      hint.innerHTML = `<div class="ink-bar" role="toolbar" aria-label="Annotation options">
        <div class="ink-row">
          <div class="ink-group" role="radiogroup" aria-label="Tip">${Object.keys(TIPS).map(k => `<button type="button" role="radio" class="ink-tip${k === c.tip ? ' active' : ''}" aria-checked="${k === c.tip}" data-tip="${k}" title="${TIPS[k].name}">${ICONS[k]}<span>${TIPS[k].name}</span></button>`).join('')}</div>
          <span class="ink-sep" aria-hidden="true"></span>
          <div class="ink-group" role="radiogroup" aria-label="${eraser ? 'Eraser size' : 'Stroke width'}">${tip.sizes.map((w, i) => `<button type="button" role="radio" class="ink-size${i === t.size ? ' active' : ''}" aria-checked="${i === t.size}" data-size="${i}" title="${w} px" aria-label="${names[i]} (${w} px)"><i${eraser ? ' class="ring"' : ''} style="width:${dot(w)}px;height:${dot(w)}px;${eraser ? '' : `background:${esc(t.color)};opacity:${tip.opacity < 1 ? 0.7 : 1}`}"></i></button>`).join('')}</div>
        </div>
        ${eraser ? '' : `<div class="ink-row">
          <div class="ink-group ink-colors" role="radiogroup" aria-label="Color">${colors.map(col => `<button type="button" role="radio" class="ink-color${col === t.color ? ' active' : ''}" aria-checked="${col === t.color}" data-color="${col}" title="${col}" aria-label="Color ${col}"><i style="background:${col}"></i></button>`).join('')}
            <label class="ink-color ink-custom${colors.includes(t.color) ? '' : ' active'}" title="Another color"><input type="color" value="${esc(t.color)}" aria-label="Another color"><i style="background:${colors.includes(t.color) ? 'conic-gradient(#f44, #fd0, #4d4, #0cf, #44f, #f4f, #f44)' : esc(t.color)}"></i></label>
          </div>
        </div>`}
        <div class="ink-note">${eraser ? 'Wipe with the stylus: what it passes over goes.' : 'Draw with a stylus (its eraser end erases).'} Fingers<span class="ink-mouse"> and the mouse</span> move the map.</div>
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
      if (pick) { // (the eraser has no color)
        pick.addEventListener('input', () => { c.tips[c.tip].color = pick.value; save(); });
        pick.addEventListener('change', () => { this.renderBar(hint); refocus('.ink-custom input'); });
      }
      bar.addEventListener('keydown', e => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); }); // the app's letter shortcuts stay out
      MB.ui.radios(bar);
    }
  };
})(window.MB);
