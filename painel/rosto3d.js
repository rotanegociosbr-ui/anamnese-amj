(function () {
  'use strict';
  // Same-origin clinical annotation component; never serialize credentials or patient identifiers into its URL.
  const state = { root: null, frame: null, epoch: 0, pending: false, active: false, protocolId: null, protocolLabel: '', contextSeq: 0, saving: false };
  const contextLoads = new WeakMap();
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
      'Para guardar os pontos, abra uma consulta em Fotos e prontuários e escolha Rosto 3D e pontos. Alterações exigem confirmação por senha.</p>' +
      '<p data-rosto3d-contexto>Nenhuma consulta vinculada.</p><button type="button" data-rosto3d-consultas>Abrir fotos e prontuários</button>' +
      '<p role="status" aria-live="polite" data-rosto3d-status>Pronto para abrir após verificar sua sessão.</p>' +
      '<div data-rosto3d-frame></div></section>';
    root.querySelector('[data-rosto3d-abrir]').addEventListener('click', function () { void activate(true); });
    root.querySelector('[data-rosto3d-consultas]').addEventListener('click', function () { void window.AMJShell.navigate('prontuarios'); });
  }
  function pause() {
    state.epoch += 1; state.pending = false; state.active = false;
    const api = viewer(); if (api) api.setActive(false);
  }
  function reset() {
    pause();state.contextSeq++;state.protocolId=null;state.protocolLabel='';state.saving=false;
    if(state.root?.querySelector('[data-rosto3d-contexto]'))state.root.querySelector('[data-rosto3d-contexto]').textContent='Nenhuma consulta vinculada.';
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
        if (retry !== true) { status('O visor foi interrompido. Use Abrir / tentar novamente; alterações não salvas serão descartadas somente após sua confirmação.'); return false; }
        if (current && current.hasChanges && current.hasChanges() &&
            !window.confirm('Reiniciar descarta alterações não salvas no prontuário. Reiniciar?')) return false;
        if (current) current.dispose();
        state.frame.remove(); state.frame = null;
      }
      if (!state.frame) {
        const frame = document.createElement('iframe');
        frame.title = 'Estúdio 3D Ana Maria Jacob — rosto e musculatura';
        frame.className = 'rosto3d-frame'; frame.referrerPolicy = 'no-referrer';
        // Same-origin component; no login state is serialized or added to this URL.
        frame.src = './rosto3d/v2/index.html';
        state.frame = frame;
        state.root.querySelector('[data-rosto3d-frame]').appendChild(frame);
      } else {
        const api = viewer();
        if (api) api.setActive(!document.hidden);
        else if (state.frame.contentWindow.AMJRostoStart) void state.frame.contentWindow.AMJRostoStart();
      }
      status('Use Marcar ponto para adicionar, nomear e escrever. Abra uma consulta para salvar.');
      return true;
    } catch (_) {
      if (epoch === state.epoch) { reset(); status('Não foi possível verificar a sessão. Use Abrir / tentar novamente.'); }
      return false;
    } finally { if (epoch === state.epoch) state.pending = false; }
  }

  async function request(action,payload,proof) {
    if(!ownerAccess())throw Error('Sessão encerrada.');
    const seq=state.contextSeq, user=authSession.user.id;
    const headers=await cabecalhosAcesso(true,proof);
    if(seq!==state.contextSeq||!ownerAccess()||authSession.user.id!==user)throw Error('Sessão alterada.');
    const response=await fetch('https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/rosto3d-fichas',{
      method:'POST',headers,cache:'no-store',referrerPolicy:'no-referrer',
      body:JSON.stringify(Object.assign({acao:action},payload))
    });
    const body=await response.json();
    if(seq!==state.contextSeq||!ownerAccess()||authSession.user.id!==user)throw Error('Sessão ou consulta alterada.');
    if(!response.ok||!body.ok)throw Error(body.erro||'Não foi possível salvar.');
    return body;
  }
  async function loadContext() {
    const api=viewer(),id=state.protocolId,seq=state.contextSeq;
    if(!api||api.ready?.()===false||!id||!ownerAccess()||!state.active)return;
    if(contextLoads.get(api)?.seq===seq)return contextLoads.get(api).promise;
    status('Carregando o estudo desta consulta…');
    const entry={seq,promise:null};
    contextLoads.set(api,entry);
    entry.promise=(async()=>{try {
      const result=await request('abrir',{protocolo_id:id});
      if(seq!==state.contextSeq||id!==state.protocolId||!ownerAccess()||api!==viewer())return;
      api.loadStudy(result.study,state.protocolLabel);status('Consulta vinculada. Marque os pontos e use Salvar no prontuário.');
    }catch(e){if(contextLoads.get(api)===entry)contextLoads.delete(api);if(seq===state.contextSeq&&api===viewer()){api.unbind();status(e.message);}}})();
    return entry.promise;
  }
  async function openProtocol(id,label) {
    if(!ownerAccess()||!isUuid(id))return false;
    if(state.saving||viewer()?.isBusy?.()){status('Aguarde o salvamento em andamento.');return false;}
    if(viewer()?.hasChanges?.()&&!window.confirm('Trocar de consulta descarta as alterações não salvas. Continuar?'))return false;
    state.contextSeq++;state.protocolId=id;state.protocolLabel=String(label||'Consulta selecionada').slice(0,300);
    viewer()?.unbind?.();
    state.root.querySelector('[data-rosto3d-contexto]').textContent=state.protocolLabel;
    await activate();await loadContext();return true;
  }
  function isUuid(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
  async function saveStudy(source,document,expectedVersion) {
    if(!frameAllowed(source)||!state.protocolId||state.saving)throw Error('Abra uma consulta antes de salvar.');
    const id=state.protocolId,seq=state.contextSeq;state.saving=true;let proof;
    try {
      proof=await window.AMJProtecao.solicitarSenhaRecente({titulo:'Salvar pontos no prontuário',explicacao:'Confirme o registro em '+state.protocolLabel+'. A versão anterior será preservada.',motivo:'Registro de pontos e observações em modelo facial genérico'});
      if(!frameAllowed(source)||seq!==state.contextSeq||id!==state.protocolId)throw Error('Consulta ou sessão alterada. Não foi enviado.');
      const body=await request('salvar',{protocolo_id:id,document,expected_version:expectedVersion,operation_id:proof.operation_id,motivo:proof.motivo||'Registro de estudo facial genérico'},proof);
      return body.study;
    }finally{state.saving=false;if(proof&&typeof proof.encerrar==='function')await proof.encerrar();}
  }
  function frameReady(source){if(frameAllowed(source))return loadContext();}

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
    reset, atualizarAcesso: updateAccess, frameAllowed, frameAttached, activity, abrirProtocolo: openProtocol, saveStudy, frameReady,
    contract: Object.freeze({ genericOnly: true, patientStorage: true, externalAI: false, ownerMfa: true }) });
})();
