(function () {
  const menuButton = document.querySelector('.menu-button');
  const menu = document.querySelector('.main-nav');

  if (menuButton && menu) {
    const menuLinks = Array.from(menu.querySelectorAll('a'));

    const closeMenu = (returnFocus = false) => {
      menu.classList.remove('is-open');
      document.body.classList.remove('menu-open');
      menuButton.setAttribute('aria-expanded', 'false');
      const label = menuButton.querySelector('.sr-only');
      if (label) label.textContent = 'Abrir menu';
      if (returnFocus) menuButton.focus();
    };

    menuButton.addEventListener('click', () => {
      const opening = !menu.classList.contains('is-open');
      menu.classList.toggle('is-open', opening);
      document.body.classList.toggle('menu-open', opening);
      menuButton.setAttribute('aria-expanded', String(opening));
      const label = menuButton.querySelector('.sr-only');
      if (label) label.textContent = opening ? 'Fechar menu' : 'Abrir menu';
      if (opening && menuLinks.length) requestAnimationFrame(() => menuLinks[0].focus());
    });

    menuLinks.forEach((link) => link.addEventListener('click', () => closeMenu(false)));
    window.addEventListener('resize', () => {
      if (window.innerWidth > 920) closeMenu(false);
    });
    document.addEventListener('keydown', (event) => {
      if (!menu.classList.contains('is-open')) return;
      if (event.key === 'Escape') {
        closeMenu(true);
        return;
      }
      if (event.key === 'Tab') {
        const focusable = [menuButton, ...menuLinks];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }

  document.querySelectorAll('[data-current-year]').forEach((item) => {
    item.textContent = String(new Date().getFullYear());
  });

  const portraitPanel = document.querySelector('.hero-photo-panel');
  const portraitToggle = document.querySelector('.portrait-toggle');

  if (portraitPanel && portraitToggle) {
    portraitToggle.addEventListener('click', () => {
      const paused = portraitPanel.classList.toggle('is-paused');
      portraitToggle.setAttribute('aria-pressed', String(paused));
      portraitToggle.textContent = paused ? 'Continuar imagens' : 'Pausar imagens';
    });
  }
})();
