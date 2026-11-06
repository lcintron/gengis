/* GenGIS - the time on the map (Settings → Interface → Clock): a small widget at the map's bottom left, above the
 * coordinates. Local time (this device's time zone, or one chosen), UTC, or both. Off by default; while it is off
 * nothing is drawn and no timer runs. It ticks on each second and rests while the page is hidden.
 * The choices are this device's (MB.settings.clock: { show, mode: 'local' | 'utc' | 'both', zone: '' = the device's }). */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const MODES = ['local', 'utc', 'both'];
  const UTC_LINE = '\0utc'; // the UTC line's own formatter (24-hour, no zone name), apart from a local zone of 'UTC'
  const fmts = new Map(); // one formatter per zone ('' = the device's, UTC_LINE): made once, used every second

  function formatter(zone) {
    let f = fmts.get(zone);
    if (!f) {
      f = zone === UTC_LINE
        ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
        : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short', timeZone: zone || undefined });
      fmts.set(zone, f);
    }
    return f;
  }
  const validZone = z => {
    if (!z || typeof z !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch (e) { return false; }
  };
  // a zone's name as people read it: America/New_York -> America / New York
  const zoneTitle = z => String(z).replace(/_/g, ' ').replace(/\//g, ' / ');

  const C = MB.clock = {
    control: null, timer: 0,

    // the settings, made whole: off, local time and the device's zone unless chosen otherwise
    config() {
      const s = (MB.settings && MB.settings.clock) || {};
      return { show: s.show === true, mode: MODES.includes(s.mode) ? s.mode : 'local', zone: validZone(s.zone) ? s.zone : '' };
    },
    set(patch) {
      MB.settings.clock = Object.assign(C.config(), patch);
      MB.saveSettings();
      C.apply();
    },

    deviceZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } },
    zones() { try { return Intl.supportedValuesOf('timeZone'); } catch (e) { return []; } }, // (every zone, where the browser lists them)
    zoneTitle,

    // what the clock shows at `date`: one line for local time and/or one for UTC
    // { kind: 'local' | 'utc', time: '2:32:05 PM', zone: 'EDT' | 'UTC−4' | 'UTC', title }
    lines(date, cfg) {
      cfg = cfg || C.config();
      const out = [];
      if (cfg.mode !== 'utc') {
        const parts = formatter(cfg.zone).formatToParts(date);
        const time = parts.filter(p => p.type !== 'timeZoneName').map(p => p.value).join('').trim();
        const tz = parts.find(p => p.type === 'timeZoneName');
        // EDT where the language has a name for the zone; otherwise its offset (GMT-4 -> UTC−4, with a real minus)
        const zone = (tz ? tz.value : '').replace(/^GMT(?=[+\-−]\d)/, 'UTC').replace(/-/g, '−');
        out.push({ kind: 'local', time, zone, title: 'Local time: ' + zoneTitle(cfg.zone || C.deviceZone() || 'this device') });
      }
      if (cfg.mode !== 'local') out.push({ kind: 'utc', time: formatter(UTC_LINE).format(date), zone: 'UTC', title: 'Coordinated Universal Time (UTC)' });
      return out;
    },

    // shown or not, as the settings say
    apply() {
      const cfg = C.config();
      if (!cfg.show || !MB.map) {
        clearTimeout(C.timer); C.timer = 0;
        if (C.control) { C.control.remove(); C.control = null; }
        return;
      }
      if (!C.control) C.control = new (Clock())({ position: 'bottomleft' }).addTo(MB.map); // above the coordinates
      C.control.build(cfg);
      C.tick();
    },

    // the time now, and the next tick at the start of the next second (none while the page is hidden)
    tick() {
      clearTimeout(C.timer); C.timer = 0;
      if (!C.control || document.hidden) return;
      C.control.show(new Date());
      C.timer = setTimeout(C.tick, 1000 - (Date.now() % 1000) + 5);
    },

    init() {
      document.addEventListener('visibilitychange', () => {
        fmts.delete(''); // the device's zone read again on the way back (it may have changed: travel)
        if (C.control) C.tick(); // hidden: stops; back: on time at once
      });
      C.apply();
    }
  };

  // the widget: a clock icon, then each line's time and zone (only the text changes from one second to the next)
  let ClockControl = null;
  function Clock() {
    if (ClockControl) return ClockControl;
    ClockControl = L.Control.extend({
      onAdd() {
        const el = this._el = L.DomUtil.create('div', 'mb-clock');
        el.setAttribute('role', 'timer');
        L.DomEvent.disableClickPropagation(el);
        return el;
      },
      build(cfg) {
        this.cfg = cfg;
        const lines = C.lines(new Date(), cfg);
        this._el.innerHTML = MB.ICON.clock + lines.map(l => `<span class="mb-clock-line" data-kind="${l.kind}" title="${MB.escapeHtml(l.title)}"><span class="t"></span> <span class="z"></span></span>`).join('');
        this._spans = Array.from(this._el.querySelectorAll('.mb-clock-line')).map(s => ({ t: s.querySelector('.t'), z: s.querySelector('.z') }));
      },
      show(date) {
        C.lines(date, this.cfg).forEach((l, i) => {
          const s = this._spans[i];
          if (!s) return;
          if (s.t.textContent !== l.time) s.t.textContent = l.time;
          if (s.z.textContent !== l.zone) s.z.textContent = l.zone; // (it changes with daylight saving time)
        });
      }
    });
    return ClockControl;
  }
})(window.MB);
