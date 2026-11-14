// Applies the saved theme before the first paint (no flash). Kept in its own file so the page needs no inline script.
(function () {
  try {
    var t = localStorage.getItem('rms.theme');
    if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: default theme */ }
})();
