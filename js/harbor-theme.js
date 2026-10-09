/* Keep navigation clear over scrolled content, while leaving the photo open at the top. */
(function () {
  'use strict';
  const header = document.querySelector('body > header:not(.portal-header)');
  if (!header) return;
  const update = () => {
    const scrolled = window.scrollY > 24;
    if (header.hasAttribute('data-harbor-scrolled') !== scrolled) {
      header.toggleAttribute('data-harbor-scrolled', scrolled);
    }
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('pageshow', update);
  update();
})();
