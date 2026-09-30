/* GenGIS - hover tooltips open only after the pointer has rested for a while.
 * Patches Leaflet's per-layer tooltip handlers: permanent tooltips (measurement labels) are untouched,
 * click / keyboard-focus openings stay immediate, hover openings wait `MB.tooltipDelay()` ms and any
 * pointer movement restarts the wait (and hides an already open hover tooltip).
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  MB.tooltipDelay = function () {
    const v = MB.settings && MB.settings.tooltipDelayMs;
    return v == null ? 2000 : +v;
  };

  const proto = L.Layer.prototype;
  const origOpen = proto._openTooltip;
  const origMove = proto._moveTooltip;
  const origClose = proto.closeTooltip;
  const MOVE_TOLERANCE = 4; // px of jitter allowed while "resting"

  const pending = new Set();   // layers waiting for the pointer to rest
  const openHover = new Set(); // layers whose hover tooltip is currently open

  function cancel(layer) {
    if (layer._mbTipTimer) { clearTimeout(layer._mbTipTimer); layer._mbTipTimer = null; }
    layer._mbPendingTip = null;
    pending.delete(layer);
    openHover.delete(layer);
  }

  function schedule(layer, e) {
    const delay = MB.tooltipDelay();
    if (layer._mbTipTimer) clearTimeout(layer._mbTipTimer);
    layer._mbPendingTip = e;
    layer._mbRestPoint = e && e.containerPoint ? e.containerPoint : null;
    pending.add(layer);
    if (delay <= 0) { layer._mbTipTimer = null; pending.delete(layer); origOpen.call(layer, e); return; }
    layer._mbTipTimer = setTimeout(() => {
      layer._mbTipTimer = null;
      pending.delete(layer);
      const ev = layer._mbPendingTip;
      layer._mbPendingTip = null;
      layer._mbLastOpenEvent = ev;
      if (ev && layer._tooltip && layer._map) {
        origOpen.call(layer, ev);
        layer._mbOpenPoint = layer._mbRestPoint;
        openHover.add(layer);
      }
    }, delay);
  }

  proto._openTooltip = function (e) {
    if (!this._tooltip || !this._map) return;
    const hover = e && (e.type === 'mouseover' || e.type === 'mousemove');
    if (this._tooltip.options.permanent || !hover) { cancel(this); return origOpen.call(this, e); }
    schedule(this, e);
  };

  proto._moveTooltip = function (e) {
    if (this._tooltip && !this._tooltip.options.permanent) {
      const pt = e && e.containerPoint;
      if (this._mbTipTimer) {
        // still waiting: movement beyond the jitter tolerance restarts the wait
        if (!this._mbRestPoint || !pt || pt.distanceTo(this._mbRestPoint) > MOVE_TOLERANCE) schedule(this, e);
        else this._mbPendingTip = e;
        return;
      }
      if (this.isTooltipOpen() && this._mbOpenPoint && pt && pt.distanceTo(this._mbOpenPoint) > MOVE_TOLERANCE) {
        // moved after it opened: hide and wait again
        origClose.call(this);
        schedule(this, e);
        return;
      }
    }
    return origMove.call(this, e);
  };

  proto.closeTooltip = function () {
    cancel(this);
    return origClose.call(this);
  };

  // Non-sticky tooltips (markers) receive no mousemove from Leaflet; watch the map so movement still resets them.
  MB.initTooltipDelay = function (map) {
    map.on('mousemove', e => {
      pending.forEach(layer => {
        if (layer._mbRestPoint && e.containerPoint.distanceTo(layer._mbRestPoint) > MOVE_TOLERANCE) schedule(layer, Object.assign({}, layer._mbPendingTip, { containerPoint: e.containerPoint, latlng: layer._mbPendingTip && layer._mbPendingTip.latlng }));
      });
      openHover.forEach(layer => {
        if (layer._mbOpenPoint && e.containerPoint.distanceTo(layer._mbOpenPoint) > MOVE_TOLERANCE) {
          const ev = Object.assign({}, layer._mbLastOpenEvent || {}, { containerPoint: e.containerPoint });
          origClose.call(layer);
          openHover.delete(layer);
          schedule(layer, ev); // reopen after the pointer rests again (mouseout cancels)
        }
      });
    });
    map.on('mouseout movestart', () => { pending.forEach(cancel); });
  };
})(window.MB);
