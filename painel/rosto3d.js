(function () {
  'use strict';
  // Generic educational assets only. Never pass a session, patient, or token to the frame.
  const state = { root: null, frame: null, epoch: 0, pending: false, active: false };
  function ownerAccess() {
    try {
      return modoAcesso === 'auth' && aplicativoLiberado === true &&
        Boolean(authSession && authSession.access_token) &&
        String(identidadeBackend && identidadeBackend.role || '').toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function panelVisible() {
    const panel = document.getElementById('aba-rosto3d');
    return Boolean(panel && !panel.hidden && !panel.classList.contains('oculto'));
  }
  function status(message) {
    const node = state.root && state.root.querySelector('[data-rosto3d-status]');
    if (node) node.textContent = message;
  }
  function viewer() {
    try { return state.frame && state.frame.contentWindow.AMJRostoViewer; }
    catch (_) { return null; }
  }
  function mount(root) {
    state.root = root;
    if (!root || root.firstElementChild) return;
    // Mount is deliberately inert: the lazy loader may finish after navigation/logout.
    root.innerHTML = '<section class="rosto3d-shell" aria-labelledby="rosto3d-titulo">' +
      '<header><div><h2 id="rosto3d-titulo">Estúdio do rosto 3D</h2>' +
      '<p>Gire o rosto, toque nos músculos para identificar, marque pontos e escreva observações.</p></div>' +
      '<button type="button" data-rosto3d-abrir>Abrir / tentar novamente</button></header>' +
      '<p class="rosto3d-nota">Estudo genérico e ilustrativo. Não representa uma paciente nem prevê resultados. ' +
      'Exporte o estudo para guardar: não há salvamento no prontuário ou no Supabase. Não inclua dados de pacientes.</p>' +
      '<p role="status" aria-live="polite" data-rosto3d-status>Pronto para abrir após verificar sua sessão.</p>' +
      '<div data-rosto3d-frame></div></section>';
    root.querySelector('[data-rosto3d-abrir]').addEventListener('click', function () { void activate(true); });
  }
  function pause() {
    state.epoch += 1; state.pending = false; state.active = false;
    const api = viewer(); if (api) api.setActive(false);
  }
  function reset() {
    pause();
    const api = viewer(); if (api) api.dispose();
    if (state.frame) state.frame.remove();
    state.frame = null;
    status('Sessão encerrada. Entre novamente para abrir um novo estudo.');
  }
  function updateAccess() { if (!ownerAccess()) reset(); }
  async function activate(retry) {
    if (!state.root || !ownerAccess() || !panelVisible() || state.pending) return false;
    const epoch = ++state.epoch;
    state.pending = true;
    status('Verificando sua sessão com autenticação em duas etapas…');
    try {
      const next = await authController.getNextStep();
      if (epoch !== state.epoch || !ownerAccess() || !panelVisible()) return false;
      if (next.step !== 'ready' || !next.session || !next.session.access_token ||
          !next.aal || next.aal.currentLevel !== 'aal2' ||
          next.session.user.id !== authSession.user.id) {
        reset(); status('Confirme novamente o login e a autenticação em duas etapas para abrir o 3D.'); return false;
      }
      state.active = true;
      const current = viewer();
      const failed = state.frame && (state.frame.contentWindow.AMJRostoFailed || (current && current.failed && current.failed()));
      if (failed) {
        if (retry !== true) { status('O visor foi interrompido. Exporte as alterações disponíveis e use Abrir / tentar novamente.'); return false; }
        if (current && current.hasChanges && current.hasChanges() &&
            !window.confirm('Reiniciar descarta o estudo não exportado. Cancele e use Exportar estudo para guardar primeiro. Reiniciar?')) return false;
        if (current) current.dispose();
        state.frame.remove(); state.frame = null;
      }
      if (!state.frame) {
        const frame = document.createElement('iframe');
        frame.title = 'Estúdio 3D Ana Maria Jacob — rosto e musculatura';
        frame.className = 'rosto3d-frame'; frame.referrerPolicy = 'no-referrer';
        // Same-origin component; no login state is serialized or added to this URL.
        frame.src = './rosto3d/v1/studio.html';
        state.frame = frame;
        state.root.querySelector('[data-rosto3d-frame]').appendChild(frame);
      } else {
        const api = viewer();
        if (api) api.setActive(!document.hidden);
        else if (state.frame.contentWindow.AMJRostoStart) void state.frame.contentWindow.AMJRostoStart();
      }
      status('Explore Aparência do rosto ou Musculatura. Toque no músculo para ver seu nome.');
      return true;
    } catch (_) {
      if (epoch === state.epoch) { reset(); status('Não foi possível verificar a sessão. Use Abrir / tentar novamente.'); }
      return false;
    } finally { if (epoch === state.epoch) state.pending = false; }
  }
  function belongs(source) { return Boolean(state.frame && source === state.frame.contentWindow); }
  function frameAttached(source) { return belongs(source) && ownerAccess(); }
  function frameAllowed(source) { return belongs(source) && state.active && ownerAccess() && panelVisible(); }
  function activity(source) {
    if (frameAllowed(source) && typeof registrarAtividadeSessao === 'function') registrarAtividadeSessao(false);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { const api = viewer(); if (api) api.setActive(false); }
    else if (panelVisible()) void activate();
  });
  window.AMJRosto3D = Object.freeze({ montar: mount, ativar: activate, pausar: pause,
    reset, atualizarAcesso: updateAccess, frameAllowed, frameAttached, activity,
    contract: Object.freeze({ genericOnly: true, patientStorage: false, externalAI: false, ownerMfa: true }) });
})();
