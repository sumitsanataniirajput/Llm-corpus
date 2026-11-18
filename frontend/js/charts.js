/* ========================================
   CORPUS ULTIMATE — Chart.js helpers
   ======================================== */

window.charts = (function () {
  const instances = {};

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
    instances[ctxId] = new Chart(ctx.getContext('2d'), cfg);
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
    instances[ctxId] = new Chart(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  function updateChart(ctxId, labels, datasets) {
    const inst = instances[ctxId];
    if (!inst) return;
    inst.data.labels = labels;
    inst.data.datasets = datasets;
    // Live metrics update frequently; skip animation to avoid repeated
    // animation queues and main-thread work on mobile devices.
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
    instances[ctxId] = new Chart(ctx.getContext('2d'), cfg);
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
    instances[ctxId] = new Chart(ctx.getContext('2d'), cfg);
    return instances[ctxId];
  }

  return {
    createLineChart,
    createBarChart,
    updateChart,
    destroyChart,
    createDonutChart,
    createProbabilityChart,
  };
})();