(function () {
  'use strict';
  // Same-origin clinical annotation component; never serialize credentials or patient identifiers into its URL.
  const state = { root: null, frame: null, epoch: 0, pending: false, active: false, protocolId: null, protocolLabel: '', selectedPatientId: null, binding: null, contextSeq: 0, saving: false };
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
  function contextControls() {
    for (const name of ['recarregar', 'voltar']) {
      const node = state.root?.querySelector('[data-rosto3d-' + name + ']');
      if (node) { node.hidden = !state.protocolId; node.disabled = state.saving; }
    }
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
      '<div class="rosto3d-contexto"><p data-rosto3d-contexto>Nenhuma consulta vinculada.</p>' +
      '<div class="rosto3d-acoes"><button type="button" data-rosto3d-consultas>Abrir fotos e prontuários</button>' +
      '<button type="button" data-rosto3d-voltar hidden>Voltar a esta consulta</button>' +
      '<button type="button" data-rosto3d-recarregar hidden>Recarregar do prontuário</button></div></div>' +
      '<p role="status" aria-live="polite" data-rosto3d-status>Pronto para abrir após verificar sua sessão.</p>' +
      '<div data-rosto3d-frame></div></section>';
    root.querySelector('[data-rosto3d-abrir]').addEventListener('click', function () { void activate(true); });
    root.querySelector('[data-rosto3d-consultas]').addEventListener('click', function () { void window.AMJShell.navigate('prontuarios'); });
    root.querySelector('[data-rosto3d-recarregar]').addEventListener('click', function () { void reloadContext(); });
    root.querySelector('[data-rosto3d-voltar]').addEventListener('click', function () { void returnToProtocol(); });
  }
  function pause() {
    state.epoch += 1; state.pending = false; state.active = false;
    const api = viewer(); if (api) api.setActive(false);
  }
  function reset() {
    pause();state.contextSeq++;state.protocolId=null;state.protocolLabel='';state.selectedPatientId=null;state.binding=null;state.saving=false;contextControls();
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
        state.frame.remove(); state.frame = null; state.binding = null;
      }
      if (!state.frame) {
        const frame = document.createElement('iframe');
        frame.title = 'Estúdio 3D Ana Maria Jacob — rosto e musculatura';
        frame.className = 'rosto3d-frame'; frame.referrerPolicy = 'no-referrer';
        // Same-origin component; no login state is serialized or added to this URL.
        frame.src = './rosto3d/v2/index.html?v=20260906-3';
        state.frame = frame;
        state.root.querySelector('[data-rosto3d-frame]').appendChild(frame);
      } else {
        const api = viewer();
        if (api) api.setActive(!document.hidden);
        else if (state.frame.contentWindow.AMJRostoStart) void state.frame.contentWindow.AMJRostoStart();
      }
      if (state.protocolId) await loadContext();
      else status('Use Marcar ponto para adicionar, nomear e escrever. Abra uma consulta para salvar.');
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
    if(!response.ok||!body.ok){const error=Error(body.erro||'Não foi possível concluir.');error.code=body.codigo;error.status=response.status;throw error;}
    return body;
  }
  function checkedBinding(result,id) {
    const value=result?.binding;
    if(value?.patient_id!==state.selectedPatientId)throw Error('O paciente desta consulta mudou. Volte a Fotos e prontuários, atualize a consulta e abra novamente o 3D.');
    if(result?.protocolo_id!==id||value?.protocol_id!==id||!isUuid(value?.patient_id)||
        !Number.isInteger(value.protocol_version)||value.protocol_version<1) {
      throw Error('O vínculo da consulta não foi confirmado pelo servidor. Use Recarregar do prontuário antes de salvar.');
    }
    return Object.freeze({protocol_id:id,patient_id:value.patient_id,protocol_version:value.protocol_version});
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
      if(!state.active||!panelVisible()){contextLoads.delete(api);return false;}
      const binding=checkedBinding(result,id);
      if(api.hasChanges?.()&&!window.confirm('Você editou o estudo durante o carregamento. Substituir essas alterações pela versão salva no prontuário?')){
        contextLoads.delete(api);state.binding=null;status('Os pontos e textos da tela foram preservados, mas ainda não estão vinculados. Use Recarregar do prontuário quando puder substituir o rascunho.');return false;
      }
      api.loadStudy(result.study,state.protocolLabel);state.binding=binding;
      status(result.study?'Estudo salvo carregado — versão '+result.study.version+'. Você pode editar os pontos e salvar uma nova versão.':'Consulta vinculada. Marque os pontos e use Salvar no prontuário.');return true;
    }catch(e){if(contextLoads.get(api)===entry)contextLoads.delete(api);if(seq===state.contextSeq&&api===viewer()){state.binding=null;if(!api.hasChanges?.())api.unbind();status(e.message+' Use Abrir / tentar novamente.');}return false;}})();
    return entry.promise;
  }
  async function openProtocol(id,label,patientId) {
    if(!ownerAccess()||!isUuid(id)||!isUuid(patientId)){status('Abra a consulta atualizada em Fotos e prontuários para confirmar o paciente.');return false;}
    if(state.saving||viewer()?.isBusy?.()){status('Aguarde o salvamento em andamento.');return false;}
    if(viewer()?.hasChanges?.()&&!window.confirm('Trocar de consulta descarta as alterações não salvas. Continuar?'))return false;
    state.contextSeq++;state.protocolId=id;state.protocolLabel=String(label||'Consulta selecionada').slice(0,300);state.selectedPatientId=patientId;state.binding=null;contextControls();
    viewer()?.unbind?.();
    state.root.querySelector('[data-rosto3d-contexto]').textContent=state.protocolLabel;
    return activate();
  }
  async function reloadContext() {
    if(!ownerAccess()||!state.protocolId||!state.active)return false;
    if(state.saving||viewer()?.isBusy?.()){status('Aguarde o salvamento em andamento.');return false;}
    if(viewer()?.hasChanges?.()&&!window.confirm('Recarregar substitui os pontos e textos ainda não salvos pela última versão do prontuário. Continuar?'))return false;
    state.contextSeq++;state.binding=null;viewer()?.unbind?.();
    return loadContext();
  }
  async function returnToProtocol() {
    if(!ownerAccess()||!state.protocolId)return false;
    if(state.saving||viewer()?.isBusy?.()){status('Aguarde o salvamento em andamento.');return false;}
    if(viewer()?.hasChanges?.()&&!window.confirm('Há pontos ou textos não salvos. Voltar à consulta sem salvar agora?'))return false;
    const id=state.protocolId,seq=state.contextSeq;
    try {
      if(await window.AMJShell.navigate('prontuarios')!==true)return false;
      if(!ownerAccess()||seq!==state.contextSeq||id!==state.protocolId)return false;
      await window.AMJProntuario.abrirProtocolo(id);return true;
    }catch(_){status('Não foi possível abrir esta consulta. Tente novamente.');return false;}
  }
  function isUuid(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
  async function saveStudy(source,document,expectedVersion) {
    if(!frameAllowed(source)||!state.protocolId||!state.binding||state.saving)throw Error('Abra ou recarregue uma consulta antes de salvar.');
    const id=state.protocolId,seq=state.contextSeq,binding=state.binding;state.saving=true;contextControls();let proof;
    try {
      proof=await window.AMJProtecao.solicitarEdicaoRotineira({titulo:'Salvar pontos no prontuário',explicacao:'Confirme o registro em '+state.protocolLabel+'. A versão anterior será preservada.',motivo:'Registro de pontos e observações em modelo facial genérico'});
      if(!frameAllowed(source)||seq!==state.contextSeq||id!==state.protocolId)throw Error('Consulta ou sessão alterada. Não foi enviado.');
      const body=await request('salvar',{protocolo_id:id,document,expected_version:expectedVersion,expected_patient_id:binding.patient_id,expected_protocol_version:binding.protocol_version,operation_id:proof.operation_id,motivo:proof.motivo||'Registro de estudo facial genérico'},proof);
      state.binding=checkedBinding(body,id);
      status('Salvo no prontuário — versão '+body.study.version+'. Pontos e observações vinculados a esta consulta.');
      return body.study;
    }catch(e){
      if(seq===state.contextSeq&&id===state.protocolId&&ownerAccess()){
        if(e.status===409){state.binding=null;status('A consulta ou o estudo mudou em outro acesso. Seus pontos continuam na tela, sem sobrescrever o prontuário. Use Recarregar do prontuário para revisar a versão salva.');}
        else status('Não foi possível confirmar o salvamento. Os pontos continuam na tela. '+e.message);
      }
      throw e;
    }finally{if(seq===state.contextSeq){state.saving=false;contextControls();}if(proof&&typeof proof.encerrar==='function')await proof.encerrar();}
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
    reset, atualizarAcesso: updateAccess, frameAllowed, frameAttached, activity, abrirProtocolo: openProtocol, recarregar: reloadContext, voltarConsulta: returnToProtocol, saveStudy, frameReady,
    contract: Object.freeze({ genericOnly: true, patientStorage: true, externalAI: false, ownerMfa: true }) });
})();
