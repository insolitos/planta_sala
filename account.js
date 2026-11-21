(function () {
  'use strict';
  const {clone,validateState,validateWorkspace,Cloud} = PlantaPersistence;
  const key = 'planta-sala-test:guest:v1';
  const fresh = () => ({students:[],desks:[],groups:[],roomWidth:900,roomHeight:650,roomName:'Nova turma',zoom:1,deskType:'pair',nextId:1});
  const wrap = s => { const id = crypto.randomUUID(); return {version:1,activeId:id,classes:[{id,state:clone(s)}]}; };
  let workspace = wrap(state), guest, cloud, user = null, revision = 0;
  let dirty = false, busy = false, blocked = false, localBlocked = false, authBusy = false;
  let last = '', timer, localUnsaved = false;
  const el = id => document.getElementById(id);
  const configured = Boolean(window.PLANTA_CONFIG?.url && window.PLANTA_CONFIG?.publishableKey && window.PLANTA_CONFIG?.authReady !== false);
  if (!configured) {
    for (const id of ['account-email','account-code','cloud-consent','send-code','verify-code']) el(id).disabled = true;
  } else if (el('cloud-unavailable')) el('cloud-unavailable').hidden = !window.PLANTA_CONFIG?.testMode;
  const status = text => { el('sync-status').textContent = text; };
  const active = () => workspace.classes.find(c => c.id === workspace.activeId);
  function download(value, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    a.download = name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  function list() {
    el('class-select').replaceChildren(...workspace.classes.map(c => {
      const o = document.createElement('option'); o.value = c.id; o.textContent = c.state.roomName || 'Sem nome'; return o;
    }));
    el('class-select').value = workspace.activeId;
  }
  function show() {
    state = clone(active().state);
    for (const id of ['bulk-students','new-student-name','new-group-name','roster-class-name','assign-search']) if (el(id)) el(id).value = '';
    if (typeof previewRoster === 'function') previewRoster();
    closeAssignModal(); closeGroupModal(); closeCtxMenu(); deskDragState = null;
    el('room-name').value = state.roomName;
    el('room-width').value = state.roomWidth; el('room-height').value = state.roomHeight;
    el('desk-count').value = state.desks.length; el('desk-type').value = state.deskType;
    updateRoomSize(); renderDesks(); renderStudents(); renderGroups(); applyZoom();
    last = JSON.stringify(state); list();
  }
  function saveLocal() {
    if (localBlocked) { localUnsaved = true; return; }
    try { localStorage.setItem(key,JSON.stringify(workspace)); localUnsaved = false; status('Sem conta · guardado neste navegador'); }
    catch { localUnsaved = true; status('Não foi possível guardar no navegador. Exporte uma cópia.'); }
  }
  function changed() {
    if (user) { dirty = true; status(blocked ? 'Conflito pendente · exporte a sua cópia' : 'Alterações por sincronizar'); clearTimeout(timer); timer = setTimeout(sync,1000); }
    else saveLocal();
    list();
  }
  function capture() {
    state.roomName = el('room-name').value;
    const text = JSON.stringify(state);
    if (text !== last) { active().state = clone(state); last = text; changed(); }
  }
  async function sync() {
    capture();
    if (!user || busy || blocked || authBusy) return;
    busy = true;
    try {
      if (dirty) {
        const snapshot = clone(workspace);
        revision = await cloud.save(snapshot,revision);
        capture(); dirty = JSON.stringify(workspace) !== JSON.stringify(snapshot);
        status(dirty ? 'Alterações por sincronizar' : 'Conta · sincronizado');
      } else {
        const remote = await cloud.load();
        capture();
        if (remote && remote.revision !== revision) {
          if (dirty) { blocked = true; status('Conflito: exporte a sua cópia antes de carregar a nuvem.'); }
          else { workspace = remote.workspace; revision = remote.revision; show(); status('Conta · atualizado da nuvem'); }
        } else if (!remote && revision > 0) { blocked = true; status('Dados removidos na nuvem. Exporte a sua cópia antes de continuar.'); }
      }
    } catch(e) { if (e.conflict) blocked = true; status(e.message + ' A cópia aberta mantém-se disponível para exportar.'); }
    finally { busy = false; }
  }
  async function guarded(fn) {
    if (authBusy || busy) return;
    authBusy = true; document.body.inert = true;
    try { await fn(); } catch(e) { status(e.message); } finally { authBusy = false; document.body.inert = false; }
  }
  el('class-select').onchange = () => { const selected = el('class-select').value; capture(); workspace.activeId = selected; show(); changed(); };
  el('new-class').onclick = () => {
    capture(); if (workspace.classes.length >= 100) return status('Limite de 100 turmas.');
    const name = prompt('Nome da nova turma:'); if (!name?.trim()) return;
    const c = {id:crypto.randomUUID(),state:{...fresh(),roomName:name.trim().slice(0,1000)}};
    workspace.classes.push(c); workspace.activeId = c.id; show(); changed();
  };
  el('delete-class').onclick = () => {
    if (!confirm('Apagar esta turma? Exporte uma cópia se precisar de a recuperar.')) return;
    workspace.classes = workspace.classes.filter(c=>c.id !== workspace.activeId);
    if (!workspace.classes.length) workspace = wrap(fresh());
    else workspace.activeId = workspace.classes[0].id;
    show(); changed();
  };
  el('backup-all').onclick = () => { capture(); download(workspace,'turmas-backup.json'); };
  el('restore-all').onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      if (file.size > 2000000) throw Error('Ficheiro demasiado grande (máximo 2 MB).');
      const value = JSON.parse(await file.text());
      const incoming = value.version === 1 ? validateWorkspace(value) : wrap(validateState(value));
      capture();
      if (workspace.classes.length + incoming.classes.length > 100) throw Error('Limite de 100 turmas.');
      const additions = incoming.classes.map(c=>({id:crypto.randomUUID(),state:c.state}));
      workspace.classes.push(...additions); workspace.activeId = additions[0].id; show(); changed();
    } catch(e) { status(e.message); }
  };
  el('send-code').onclick = () => guarded(async () => {
    if (!el('account-email').reportValidity()) return;
    if (!el('cloud-consent').checked) throw Error('Confirme a informação de privacidade antes de criar ou usar a conta.');
    if (!cloud) cloud = new Cloud(window.PLANTA_CONFIG);
    await cloud.sendCode(el('account-email').value.trim()); status('Consulte o seu email e introduza o código recebido.');
  });
  el('verify-code').onclick = () => guarded(async () => {
    if (!el('cloud-consent').checked) throw Error('Confirme a informação de privacidade.');
    if (!cloud) cloud = new Cloud(window.PLANTA_CONFIG);
    await cloud.verify(el('account-email').value.trim(),el('account-code').value.trim());
    // Do not replace the local view until both authentication and load succeed.
    const remote = await cloud.load(); capture(); guest = clone(workspace);
    user = cloud.session.user; workspace = remote?.workspace || wrap(fresh()); revision = remote?.revision || 0;
    dirty = false; blocked = false; show();
    el('account-login').hidden = true; el('account-actions').hidden = false;
    el('account-identity').textContent = user.email;
    el('account-code').value = ''; status('Conta · sincronização ativa');
  });
  el('copy-local').onclick = () => {
    if (!user || !confirm('Copiar as turmas locais para esta conta? Os dados serão enviados ao Supabase.')) return;
    capture(); if (workspace.classes.length + guest.classes.length > 100) return status('Limite de 100 turmas.');
    workspace.classes.push(...guest.classes.map(c=>({id:crypto.randomUUID(),state:clone(c.state)}))); changed();
  };
  el('sync-now').onclick = sync;
  el('load-cloud').onclick = () => guarded(async () => {
    capture();
    if (!confirm('Exportar uma cópia de segurança e carregar a versão da nuvem? A versão aberta será substituída.')) return;
    download(workspace,'antes-de-carregar-nuvem.json');
    const remote = await cloud.load(); workspace = remote?.workspace || wrap(fresh()); revision = remote?.revision || 0;
    dirty = false; blocked = false; show(); status('Versão da nuvem carregada.');
  });
  el('logout').onclick = () => guarded(async () => {
    capture(); if (dirty && !confirm('Existem alterações por sincronizar. Exportar cópia e sair?')) return;
    if (dirty) download(workspace,'alteracoes-nao-sincronizadas.json');
    clearTimeout(timer);
    let logoutFailed = false; try { await cloud.logout(); } catch { logoutFailed = true; }
    user = null; workspace = guest; guest = null; dirty = false; blocked = false; revision = 0;
    el('account-login').hidden = false; el('account-actions').hidden = true;
    el('account-identity').textContent = ''; el('account-email').value = ''; el('account-code').value = '';
    show(); status(logoutFailed ? 'Saiu neste dispositivo. Não foi possível revogar a sessão no servidor.' : 'Sem conta · turmas locais restauradas');
  });
  // Existing JSON import now adds a class and validates before rendering.
  importData = e => el('restore-all').onchange(e);
  try {
    const raw = localStorage.getItem(key);
    if (raw) workspace = validateWorkspace(JSON.parse(raw));
    show(); status('Sem conta · gravação automática neste navegador');
  } catch { localBlocked = true; status('A cópia local não pôde ser lida. Não será sobrescrita; exporte o trabalho e recupere a cópia antes de continuar.'); }
  document.addEventListener('input',()=>queueMicrotask(capture));
  document.addEventListener('change',()=>queueMicrotask(capture));
  document.addEventListener('click',()=>queueMicrotask(capture));
  document.addEventListener('mouseup',()=>queueMicrotask(capture));
  document.addEventListener('touchend',()=>queueMicrotask(capture));
  setInterval(capture,1000);
  setInterval(()=>{ if (!document.hidden) sync(); },15000);
  window.addEventListener('online',sync);
  window.addEventListener('beforeunload',e=>{ capture(); if ((user && dirty) || (!user && localUnsaved)) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('storage',e=>{
    if (e.key === key) { localBlocked = true; status('Outra janela alterou as turmas locais. Exporte esta cópia e recarregue para evitar sobreposição.'); }
  });
})();
