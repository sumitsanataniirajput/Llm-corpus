/* ========================================
   CORPUS ULTIMATE — Chart.js helpers
   ========================================

   P2: every line chart is a real numeric chart, not a decorative sparkline.
   Numeric step/date labels get a linear x axis and {x, y} points; large metric
   series are downsampled without losing their minima/maxima; each chart gets a
   range readout, drag/ctrl-wheel zoom and an explicit Reset. The same helper is
   used by Dashboard, Statistics, Training and Intelligence, so zoom/reset
   behaviour cannot drift between pages.
*/
window.charts = (function () {
  const instances = {};
  const lineMeta = {};
  const MAX_POINTS = 240;

  // Chart.js is a deferred third-party script. If it failed to load (offline,
  // CDN blocked, corporate proxy) the page must still work, just without charts.
  function chartLib() {
    if (typeof Chart !== 'undefined' && Chart) return Chart;
    try {
      if (window.CORPUS_APP && typeof window.CORPUS_APP.logDiagnostic === 'function') {
        window.CORPUS_APP.logDiagnostic('charts: Chart.js is not available, skipping chart render');
      }
    } catch (e) { /* diagnostics are optional */ }
    return null;
  }

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { labels: { color: '#cac4d0', font: { family: 'Inter', size: 12 } } },
      title: { display: false },
    },
    scales: {
      x: { ticks: { color: '#cac4d0' }, grid: { color: '#4c4a58' } },
      y: { ticks: { color: '#cac4d0' }, grid: { color: '#4c4a58' } },
    },
  };

  function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (plainObject(value)) {
      const out = {};
      Object.keys(value).forEach((key) => { out[key] = clone(value[key]); });
      return out;
    }
    return value;
  }

  function deepMerge(base, extra) {
    const out = clone(base || {});
    if (!plainObject(extra)) return out;
    Object.keys(extra).forEach((key) => {
      const value = extra[key];
      out[key] = plainObject(value)
        ? deepMerge(plainObject(out[key]) ? out[key] : {}, value)
        : clone(value);
    });
    return out;
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function numericLabel(label) {
    if (typeof label === 'number' && Number.isFinite(label)) return label;
    if (typeof label !== 'string') return null;
    const raw = label.trim();
    if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    const step = raw.match(/^step\s+([+-]?\d+(?:\.\d+)?)$/i);
    if (step) return Number(step[1]);
    return null;
  }

  function yOf(point) {
    if (point && typeof point === 'object' && !Array.isArray(point)) {
      return Number(point.y != null ? point.y : point.value);
    }
    return Number(point);
  }

  function fmt(value) {
    if (typeof value === 'string') return value;
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    const abs = Math.abs(number);
    if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return number.toExponential(2);
    if (abs >= 1000) return number.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return String(Number(number.toPrecision(4)));
  }

  /**
   * Min/max-preserving downsampling. It is deliberately simple and honest:
   * each bucket keeps its extreme values plus endpoints, so a spike cannot be
   * hidden by a stride sample. The toolbar reports shown/total point counts.
   */
  function downsampleSeries(labels, datasets, limit) {
    const total = labels.length;
    const copyDatasets = (indices) => datasets.map((ds) => ({
      ...ds,
      data: indices.map((index) => (ds.data || [])[index]),
    }));
    if (total <= limit) {
      const all = labels.map((_, index) => index);
      return {
        labels: labels.slice(), datasets: copyDatasets(all),
        shown: total, total, downsampled: false, sourceIndices: all,
      };
    }
    const buckets = Math.max(1, Math.floor(limit / 2));
    const chosen = new Set([0, total - 1]);
    // Endpoints and every bucket extreme are critical: they are never removed
    // by the final stride pass, so a one-step loss spike cannot disappear.
    const critical = new Set([0, total - 1]);
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = Math.floor(bucket * total / buckets);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * total / buckets));
      let minIndex = -1;
      let maxIndex = -1;
      let min = Infinity;
      let max = -Infinity;
      for (let index = start; index < end && index < total; index += 1) {
        datasets.forEach((ds) => {
          const value = yOf((ds.data || [])[index]);
          if (!Number.isFinite(value)) return;
          if (value < min) { min = value; minIndex = index; }
          if (value > max) { max = value; maxIndex = index; }
        });
      }
      chosen.add(start);
      chosen.add(Math.min(end - 1, total - 1));
      if (minIndex >= 0) { chosen.add(minIndex); critical.add(minIndex); }
      if (maxIndex >= 0) { chosen.add(maxIndex); critical.add(maxIndex); }
    }
    let indices = Array.from(chosen).sort((a, b) => a - b);
    if (indices.length > limit) {
      let reserved = Array.from(critical).sort((a, b) => a - b);
      if (reserved.length > limit) {
        const first = reserved[0];
        const last = reserved[reserved.length - 1];
        const stride = Math.ceil(reserved.length / limit);
        const thinned = reserved.filter((_, index) => index % stride === 0);
        if (thinned[0] !== first) thinned.unshift(first);
        if (thinned[thinned.length - 1] !== last) thinned.push(last);
        reserved = thinned.slice(0, limit);
      }
      const reservedSet = new Set(reserved);
      const candidates = indices.filter((index) => !reservedSet.has(index));
      const slots = Math.max(0, limit - reserved.length);
      const stride = slots ? Math.ceil(candidates.length / slots) : 1;
      const filler = slots
        ? candidates.filter((_, index) => index % stride === 0).slice(0, slots)
        : [];
      indices = Array.from(new Set(reserved.concat(filler))).sort((a, b) => a - b);
    }
    return {
      labels: indices.map((index) => labels[index]),
      datasets: copyDatasets(indices),
      shown: indices.length,
      total,
      downsampled: true,
      sourceIndices: indices,
    };
  }

  function prepareLine(labels, datasets, options, previousView) {
    const safeLabels = Array.isArray(labels) ? labels : [];
    const safeDatasets = Array.isArray(datasets) ? datasets : [];
    const numeric = safeLabels.length > 0 && safeLabels.every((label) => numericLabel(label) !== null);
    const positions = numeric
      ? safeLabels.map(numericLabel)
      : safeLabels.map((_, index) => index);

    const converted = safeDatasets.map((ds) => {
      const data = Array.isArray(ds.data) ? ds.data : [];
      return {
        ...ds,
        data: data.map((point, index) => {
          const value = yOf(point);
          const y = Number.isFinite(value) ? value : null;
          if (numeric) {
            if (point && typeof point === 'object' && !Array.isArray(point)
                && Number.isFinite(Number(point.x))) {
              return { x: Number(point.x), y };
            }
            return { x: positions[index], y };
          }
          return y;
        }),
      };
    });

    const requestedLimit = Number(options && options.corpusMaxPoints);
    const limit = Number.isFinite(requestedLimit) && requestedLimit >= 8
      ? Math.floor(requestedLimit) : MAX_POINTS;
    const sample = downsampleSeries(safeLabels, converted, limit);
    const samplePositions = numeric
      ? sample.labels.map(numericLabel)
      : sample.labels.map((_, index) => index);

    const merged = deepMerge(commonOptions, options || {});
    delete merged.corpusMaxPoints;
    merged.scales = merged.scales || {};
    merged.scales.x = merged.scales.x || {};
    merged.scales.y = merged.scales.y || {};
    if (numeric) {
      merged.scales.x.type = 'linear';
      merged.scales.x.ticks = merged.scales.x.ticks || {};
      if (!merged.scales.x.ticks.callback) merged.scales.x.ticks.callback = (value) => fmt(value);
      // Leave Chart.js parsing enabled: live metric rows are not guaranteed to
      // arrive pre-sorted, and {x, y} points are handled correctly.
    } else {
      merged.scales.x.type = merged.scales.x.type || 'category';
    }
    merged.scales.y.type = 'linear';
    merged.scales.y.ticks = merged.scales.y.ticks || {};
    if (!merged.scales.y.ticks.callback) merged.scales.y.ticks.callback = (value) => fmt(value);
    merged.layout = merged.layout || {};
    merged.layout.padding = merged.layout.padding || {};
    merged.layout.padding.top = Math.max(Number(merged.layout.padding.top) || 0, 44);

    let view = previousView && Array.isArray(previousView)
      ? [clamp(Number(previousView[0]) || 0, 0, 1), clamp(Number(previousView[1]) || 1, 0, 1)]
      : [0, 1];
    if (view[1] - view[0] < 0.001) view = [0, 1];

    const meta = {
      labels: sample.labels,
      datasets: sample.datasets,
      positions: samplePositions,
      numeric,
      total: sample.total,
      shown: sample.shown,
      downsampled: sample.downsampled,
      view,
      toolbar: null,
      rangeEl: null,
      pointsEl: null,
      zoomInEl: null,
      zoomOutEl: null,
      resetEl: null,
      canvas: null,
      parent: null,
      parentInlinePosition: '',
      parentPositionChanged: false,
      listeners: [],
      dragStart: null,
    };
    return { labels: sample.labels, datasets: sample.datasets, options: merged, meta };
  }

  function viewIndices(meta) {
    const last = Math.max(0, meta.labels.length - 1);
    const start = Math.floor(meta.view[0] * last);
    const end = Math.max(start, Math.ceil(meta.view[1] * last));
    return { start: clamp(start, 0, last), end: clamp(end, 0, last), last };
  }

  function setScaleRange(options, meta) {
    if (!options || !options.scales) return;
    options.scales.x = options.scales.x || {};
    const { start, end, last } = viewIndices(meta);
    if (meta.labels.length === 0) {
      delete options.scales.x.min;
      delete options.scales.x.max;
      return;
    }
    if (meta.numeric) {
      const min = meta.positions[start];
      const max = meta.positions[end];
      options.scales.x.min = min;
      options.scales.x.max = max === min ? min + Math.max(1, Math.abs(min) * 0.001) : max;
    } else {
      options.scales.x.min = start;
      options.scales.x.max = last === 0 ? 0 : end;
    }
  }

  function detachControls(meta) {
    if (!meta) return;
    meta.listeners.forEach((entry) => {
      try { entry[0].removeEventListener(entry[1], entry[2], entry[3]); } catch (e) { /* detached */ }
    });
    meta.listeners = [];
    if (meta.toolbar && meta.toolbar.parentNode) {
      meta.toolbar.parentNode.removeChild(meta.toolbar);
    }
    if (meta.canvas) meta.canvas.removeAttribute('data-corpus-chart');
    if (meta.parent && meta.parentPositionChanged) {
      meta.parent.style.position = meta.parentInlinePosition;
    }
    meta.toolbar = null;
    meta.canvas = null;
    meta.parent = null;
  }

  function updateToolbar(meta) {
    if (!meta || !meta.toolbar) return;
    const { start, end, last } = viewIndices(meta);
    let min = Infinity;
    let max = -Infinity;
    for (let index = start; index <= end; index += 1) {
      meta.datasets.forEach((ds) => {
        const value = yOf((ds.data || [])[index]);
        if (!Number.isFinite(value)) return;
        min = Math.min(min, value);
        max = Math.max(max, value);
      });
    }
    const x0 = meta.numeric ? meta.positions[start] : meta.labels[start];
    const x1 = meta.numeric ? meta.positions[end] : meta.labels[end];
    const yText = min <= max ? ` · y ${fmt(min)}–${fmt(max)}` : ' · y —';
    meta.rangeEl.textContent = meta.labels.length
      ? `x ${fmt(x0)}–${fmt(x1)}${yText}`
      : 'No numeric range yet';
    meta.pointsEl.textContent = meta.downsampled
      ? `${meta.shown}/${meta.total} points · min/max kept`
      : `${meta.total} points`;
    const full = meta.view[0] <= 0.0001 && meta.view[1] >= 0.9999;
    const noZoom = last < 2 || end - start <= 1;
    meta.zoomInEl.disabled = noZoom;
    meta.zoomOutEl.disabled = full;
    meta.resetEl.disabled = full;
  }

  function applyView(ctxId, shouldUpdate) {
    const meta = lineMeta[ctxId];
    const inst = instances[ctxId];
    if (!meta || !inst) return;
    setScaleRange(inst.options, meta);
    if (inst.config) inst.config.options = inst.options;
    updateToolbar(meta);
    if (shouldUpdate !== false && typeof inst.update === 'function') inst.update('none');
  }

  function zoomChart(ctxId, factor, center) {
    const meta = lineMeta[ctxId];
    if (!meta || meta.labels.length < 3) return;
    const [s, e] = meta.view;
    const span = e - s;
    const minSpan = Math.min(1, 2 / (meta.labels.length - 1));
    const mid = typeof center === 'number' ? clamp(center, 0, 1) : (s + e) / 2;
    let nextSpan = clamp(span * factor, minSpan, 1);
    let start = mid - nextSpan / 2;
    let end = mid + nextSpan / 2;
    if (start < 0) { end -= start; start = 0; }
    if (end > 1) { start -= end - 1; end = 1; }
    start = clamp(start, 0, 1);
    end = clamp(end, 0, 1);
    if (end - start < minSpan) {
      end = clamp(start + minSpan, 0, 1);
      start = clamp(end - minSpan, 0, 1);
    }
    meta.view = [start, end];
    applyView(ctxId);
  }

  function resetChart(ctxId) {
    const meta = lineMeta[ctxId];
    if (!meta) return;
    meta.view = [0, 1];
    applyView(ctxId);
  }

  function localX(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return clamp((event.clientX || 0) - (rect.left || 0), 0, rect.width || 0);
  }

  function indexFromPixel(ctxId, pixel) {
    const meta = lineMeta[ctxId];
    const inst = instances[ctxId];
    if (!meta || !inst || !meta.labels.length) return 0;
    const last = meta.labels.length - 1;
    const scale = inst.scales && inst.scales.x;
    if (scale && typeof scale.getValueForPixel === 'function') {
      try {
        const value = scale.getValueForPixel(pixel);
        if (meta.numeric) {
          let best = 0;
          let distance = Infinity;
          meta.positions.forEach((position, index) => {
            const gap = Math.abs(position - value);
            if (gap < distance) { distance = gap; best = index; }
          });
          return best;
        }
        return clamp(Math.round(Number(value) || 0), 0, last);
      } catch (e) { /* fall through to geometry */ }
    }
    const rect = meta.canvas ? meta.canvas.getBoundingClientRect() : { width: 0 };
    const fraction = rect.width ? clamp(pixel / rect.width, 0, 1) : 0.5;
    return Math.round(fraction * last);
  }

  function attachControls(ctxId) {
    const meta = lineMeta[ctxId];
    const canvas = document.getElementById(ctxId);
    if (!meta || !canvas || !canvas.parentElement) return;
    const doc = canvas.ownerDocument;
    const parent = canvas.parentElement;
    const view = doc.defaultView;
    const computed = view && typeof view.getComputedStyle === 'function'
      ? view.getComputedStyle(parent).position : '';
    meta.parent = parent;
    meta.parentInlinePosition = parent.style.position;
    if (!computed || computed === 'static') {
      parent.style.position = 'relative';
      meta.parentPositionChanged = true;
    }
    meta.canvas = canvas;
    canvas.setAttribute('data-corpus-chart', 'line');

    const toolbar = doc.createElement('div');
    toolbar.className = 'corpus-chart-toolbar';
    toolbar.setAttribute('data-chart-id', ctxId);
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Chart range and zoom controls');
    toolbar.title = 'Drag to zoom · Ctrl/⌘ + wheel to zoom · double-click or Reset to restore';
    toolbar.innerHTML = '<span class="corpus-chart-range" aria-live="polite"></span>'
      + '<span class="corpus-chart-points"></span>'
      + '<span class="corpus-chart-actions">'
      + '<button type="button" class="corpus-chart-zoom-in" aria-label="Zoom in" title="Zoom in">+</button>'
      + '<button type="button" class="corpus-chart-zoom-out" aria-label="Zoom out" title="Zoom out">−</button>'
      + '<button type="button" class="corpus-chart-reset" aria-label="Reset zoom" title="Reset zoom">Reset</button>'
      + '</span>';
    parent.insertBefore(toolbar, canvas);
    meta.toolbar = toolbar;
    meta.rangeEl = toolbar.querySelector('.corpus-chart-range');
    meta.pointsEl = toolbar.querySelector('.corpus-chart-points');
    meta.zoomInEl = toolbar.querySelector('.corpus-chart-zoom-in');
    meta.zoomOutEl = toolbar.querySelector('.corpus-chart-zoom-out');
    meta.resetEl = toolbar.querySelector('.corpus-chart-reset');

    function on(target, type, handler, opts) {
      target.addEventListener(type, handler, opts);
      meta.listeners.push([target, type, handler, opts]);
    }
    on(meta.zoomInEl, 'click', (event) => { event.preventDefault(); zoomChart(ctxId, 0.6); });
    on(meta.zoomOutEl, 'click', (event) => { event.preventDefault(); zoomChart(ctxId, 1.7); });
    on(meta.resetEl, 'click', (event) => { event.preventDefault(); resetChart(ctxId); });
    on(canvas, 'wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const fraction = rect.width ? clamp(localX(event, canvas) / rect.width, 0, 1) : 0.5;
      const center = meta.view[0] + (meta.view[1] - meta.view[0]) * fraction;
      zoomChart(ctxId, event.deltaY < 0 ? 0.82 : 1.22, center);
    }, { passive: false });
    on(canvas, 'mousedown', (event) => {
      if (event.button !== 0 || meta.labels.length < 3) return;
      meta.dragStart = localX(event, canvas);
    });
    on(canvas, 'mousemove', (event) => {
      if (meta.dragStart === null) return;
      canvas.style.cursor = 'col-resize';
    });
    on(canvas, 'mouseup', (event) => {
      if (meta.dragStart === null) return;
      const from = meta.dragStart;
      const to = localX(event, canvas);
      meta.dragStart = null;
      canvas.style.cursor = '';
      if (Math.abs(to - from) < 12) return;
      const a = indexFromPixel(ctxId, Math.min(from, to));
      const b = indexFromPixel(ctxId, Math.max(from, to));
      const last = meta.labels.length - 1;
      if (last < 2 || (b - a) / last < 2 / last) return;
      meta.view = [a / last, b / last];
      applyView(ctxId);
    });
    on(canvas, 'mouseleave', () => { meta.dragStart = null; canvas.style.cursor = ''; });
    on(canvas, 'dblclick', (event) => { event.preventDefault(); resetChart(ctxId); });
  }

  function replaceOptions(inst, options) {
    const target = inst.options || (inst.options = {});
    try {
      Object.keys(target).forEach((key) => { delete target[key]; });
      Object.assign(target, clone(options));
    } catch (e) {
      inst.options = clone(options);
    }
    if (inst.config) inst.config.options = inst.options;
  }

  function destroyChart(ctxId) {
    detachControls(lineMeta[ctxId]);
    delete lineMeta[ctxId];
    if (instances[ctxId]) {
      try { instances[ctxId].destroy(); } catch (e) { /* already gone */ }
      delete instances[ctxId];
    }
  }

  function createLineChart(ctxId, labels, datasets, options = {}) {
    const canvas = document.getElementById(ctxId);
    if (!canvas) return null;
    const Lib = chartLib();
    if (!Lib) return null;
    const previousView = lineMeta[ctxId] ? lineMeta[ctxId].view.slice() : null;
    destroyChart(ctxId);
    const prepared = prepareLine(labels, datasets, options, previousView);
    setScaleRange(prepared.options, prepared.meta);
    const cfg = {
      type: 'line',
      data: { labels: prepared.labels, datasets: prepared.datasets },
      options: prepared.options,
    };
    instances[ctxId] = new Lib(canvas.getContext('2d'), cfg);
    lineMeta[ctxId] = prepared.meta;
    attachControls(ctxId);
    updateToolbar(prepared.meta);
    return instances[ctxId];
  }

  function updateChart(ctxId, labels, datasets, options = {}) {
    const inst = instances[ctxId];
    if (!inst) return;
    const oldMeta = lineMeta[ctxId];
    const previousView = oldMeta ? oldMeta.view.slice() : null;
    if (inst.config && inst.config.type === 'line') {
      const prepared = prepareLine(labels, datasets, options, previousView);
      detachControls(oldMeta);
      inst.data.labels = prepared.labels;
      inst.data.datasets = prepared.datasets;
      if (inst.config) inst.config.data = inst.data;
      replaceOptions(inst, prepared.options);
      lineMeta[ctxId] = prepared.meta;
      attachControls(ctxId);
      applyView(ctxId, false);
      // Live metrics update frequently; skip animation so a metric stream
      // cannot queue one full re-layout/draw per event on mobile.
      inst.update('none');
      return;
    }
    inst.data.labels = labels;
    inst.data.datasets = datasets;
    inst.update('none');
  }

  function createBarChart(ctxId, labels, datasets, options = {}) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return null;
    const Lib = chartLib();
    if (!Lib) return null;
    destroyChart(ctxId);
    const cfg = {
      type: 'bar',
      data: { labels, datasets },
      options: deepMerge(commonOptions, options),
    };
    instances[ctxId] = new Lib(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  function createDonutChart(ctxId, labels, data, options = {}) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return null;
    const Lib = chartLib();
    if (!Lib) return null;
    destroyChart(ctxId);
    const cfg = {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: ['#6750a4', '#7d5260', '#625b71', '#00b8a9'] }] },
      options: deepMerge(commonOptions, {
        ...options,
        cutout: '70%',
        plugins: { legend: { position: 'bottom', labels: { color: '#cac4d0' } } },
      }),
    };
    instances[ctxId] = new Lib(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  function createProbabilityChart(ctxId, tokens, probabilities) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return null;
    const Lib = chartLib();
    if (!Lib) return null;
    destroyChart(ctxId);
    const cfg = {
      type: 'bar',
      data: {
        labels: tokens,
        datasets: [{
          label: 'Probability',
          data: probabilities,
          backgroundColor: probabilities.map((p, i) => (i === 0 ? '#6750a4' : 'rgba(103, 80, 164, 0.4)')),
        }],
      },
      options: deepMerge(commonOptions, {
        indexAxis: 'y',
        scales: {
          x: { min: 0, max: 1, ticks: { callback: v => (v * 100).toFixed(0) + '%' } },
          y: { ticks: { color: '#cac4d0' } },
        },
        plugins: { legend: { display: false } },
      }),
    };
    instances[ctxId] = new Lib(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  function instances_() {
    return Object.assign({}, instances);
  }

  function destroyAll() {
    Object.keys(instances).forEach((id) => destroyChart(id));
  }

  function chartState(ctxId) {
    const meta = lineMeta[ctxId];
    const inst = instances[ctxId];
    if (!meta || !inst) return null;
    const scales = (inst.options && inst.options.scales) || {};
    return {
      numeric: meta.numeric,
      total: meta.total,
      shown: meta.shown,
      downsampled: meta.downsampled,
      view: meta.view.slice(),
      labels: meta.labels.slice(),
      positions: meta.positions.slice(),
      datasets: meta.datasets.map((ds) => ({ ...ds, data: (ds.data || []).slice() })),
      xType: scales.x && scales.x.type,
      yType: scales.y && scales.y.type,
      xMin: scales.x && scales.x.min,
      xMax: scales.x && scales.x.max,
      paddingTop: inst.options && inst.options.layout && inst.options.layout.padding
        ? inst.options.layout.padding.top : null,
    };
  }

  return {
    createLineChart,
    createBarChart,
    updateChart,
    destroyChart,
    destroyAll,
    instances: instances_,
    createDonutChart,
    createProbabilityChart,
    chartState,
    zoomChart,
    resetChart,
  };
})();
