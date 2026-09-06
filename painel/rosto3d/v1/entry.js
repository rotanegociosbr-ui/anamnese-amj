// Application gate only: the static generic meshes are public, never patient data.
let starting = false;
const parentApp = () => { try { return window.parent !== window && window.parent.location.origin === location.origin ? window.parent.AMJRosto3D : null; } catch (_) { return null; } };
window.AMJRostoStart = async function () {
  if (starting) return;
  const app = parentApp();
  if (!app || !app.frameAllowed(window)) return;
  starting = true;
  document.getElementById('entry-message').hidden = true;
  document.getElementById('studio-content').hidden = false;
  try { await import('./app-v3.js'); }
  catch (_) { window.AMJRostoFailed = true; document.getElementById('loading').textContent = 'Não foi possível iniciar. Use Abrir / tentar novamente no Fichas.'; }
};
let lastActivity = 0;
for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input']) {
  document.addEventListener(type, event => {
    if (!event.isTrusted || Date.now() - lastActivity < 5000) return;
    const app = parentApp(); if (app) { lastActivity = Date.now(); app.activity(window); }
  }, { passive: true, capture: true });
}
void window.AMJRostoStart();
