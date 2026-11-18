/* ========================================
   CORPUS ULTIMATE — Chart.js helpers
   ======================================== */

window.charts = (function () {
  const instances = {};

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

  function createLineChart(ctxId, labels, datasets, options = {}) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return null;
    if (instances[ctxId]) instances[ctxId].destroy();
    const cfg = {
      type: 'line',
      data: { labels, datasets },
      options: { ...commonOptions, ...options },
    };
    const Lib = chartLib();
    if (!Lib) return null;
    instances[ctxId] = new Lib(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  function createBarChart(ctxId, labels, datasets, options = {}) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return null;
    if (instances[ctxId]) instances[ctxId].destroy();
    const cfg = {
      type: 'bar',
      data: { labels, datasets },
      options: { ...commonOptions, ...options },
    };
    const Lib = chartLib();
    if (!Lib) return null;
    instances[ctxId] = new Lib(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  function updateChart(ctxId, labels, datasets, options = {}) {
    const inst = instances[ctxId];
    if (!inst) return;
    inst.data.labels = labels;
    inst.data.datasets = datasets;
    // Live metrics update frequently; skip the entry animation so a metric
    // stream cannot queue one full re-layout/draw per event on mobile.
    inst.update('none');
  }

  function destroyChart(ctxId) {
    if (instances[ctxId]) {
      instances[ctxId].destroy();
      delete instances[ctxId];
    }
  }

  function createDonutChart(ctxId, labels, data, options = {}) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return null;
    if (instances[ctxId]) instances[ctxId].destroy();
    const cfg = {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: ['#6750a4', '#7d5260', '#625b71', '#00b8a9'] }] },
      options: { ...commonOptions, ...options, cutout: '70%', plugins: { ...commonOptions.plugins, legend: { position: 'bottom', labels: { color: '#cac4d0' } } } },
    };
    const Lib = chartLib();
    if (!Lib) return null;
    instances[ctxId] = new Lib(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  function createProbabilityChart(ctxId, tokens, probabilities) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return null;
    if (instances[ctxId]) instances[ctxId].destroy();
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
      options: {
        ...commonOptions,
        indexAxis: 'y',
        scales: {
          x: { ...commonOptions.scales.x, min: 0, max: 1, ticks: { callback: v => (v * 100).toFixed(0) + '%' } },
          y: { ...commonOptions.scales.y, ticks: { color: '#cac4d0' } },
        },
        plugins: { ...commonOptions.plugins, legend: { display: false } },
      },
    };
    const Lib = chartLib();
    if (!Lib) return null;
    instances[ctxId] = new Lib(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  /** Live chart instances (diagnostics + leak checks). Returns a copy. */
  function instances_() {
    return Object.assign({}, instances);
  }

  function destroyAll() {
    Object.keys(instances).forEach((id) => destroyChart(id));
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
  };
})();