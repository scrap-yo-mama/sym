// SPDX-License-Identifier: AGPL-3.0-only
// Appliqué avant le premier rendu (06 § 1) : classe `dark` et attribut `lang` de <html>. Fichier externe et
// synchrone, car la CSP de la console interdit les scripts en ligne (08b § 2). Même logique que src/lib/theme.ts.
(function () {
  try {
    var theme = localStorage.getItem('runtime.theme') || 'system';
    var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    var stored = localStorage.getItem('runtime.locale');
    var guess = (navigator.language || 'en').slice(0, 2);
    document.documentElement.lang = stored === 'fr' || stored === 'en' ? stored : guess === 'fr' ? 'fr' : 'en';
  } catch (e) {
    /* stockage indisponible : thème et langue par défaut */
  }
})();
