/* No external scripts, analytics or dependencies. */
(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function validateState(input) {
    const s = clone(input);
    const fail = () => { throw new Error('Planta inválida ou incompatível. O original não foi alterado.'); };
    const id = n => Number.isSafeInteger(n) && n > 0;
    const ref = n => n === null || id(n);
    const name = n => typeof n === 'string' && n.length <= 1000;
    if (!s || !Array.isArray(s.students) || !Array.isArray(s.desks) || !Array.isArray(s.groups)) fail();
    if (s.students.length > 2000 || s.desks.length > 2000 || s.groups.length > 2000) fail();
    if (!name(s.roomName) || !['single','pair'].includes(s.deskType) || !id(s.nextId)) fail();
    if (![s.roomWidth,s.roomHeight].every(n => Number.isFinite(n) && n >= 100 && n <= 10000)) fail();
    if (!Number.isFinite(s.zoom) || s.zoom < 0.1 || s.zoom > 5) fail();
    const ids = new Set();
    for (const item of [...s.students,...s.desks,...s.groups]) {
      if (!id(item.id) || ids.has(item.id) || item.id >= s.nextId) fail();
      ids.add(item.id);
    }
    for (const g of s.groups) if (!name(g.name) || !/^#[0-9a-f]{6}$/i.test(g.color)) fail();
    for (const d of s.desks) {
      if (!id(d.number) || !['single','pair'].includes(d.type) || ![d.x,d.y].every(Number.isFinite)) fail();
      if (!Array.isArray(d.students) || d.students.length !== (d.type === 'pair' ? 2 : 1) || !d.students.every(ref)) fail();
      d.students.forEach((sid, i) => {
        if (sid !== null && !s.students.some(st => st.id === sid && st.deskId === d.id && st.seatIndex === i)) fail();
      });
    }
    for (const st of s.students) {
      if (!name(st.name) || !ref(st.deskId) || !ref(st.groupId)) fail();
      if (st.groupId !== null && !s.groups.some(g => g.id === st.groupId)) fail();
      if (st.deskId === null ? st.seatIndex !== null : !s.desks.some(d => d.id === st.deskId && d.students[st.seatIndex] === st.id)) fail();
    }
    // Reconstruct the allowed shape, discarding unknown properties.
    return {students:s.students.map(({id,name,deskId,seatIndex,groupId})=>({id,name,deskId,seatIndex,groupId})),
      desks:s.desks.map(({id,number,x,y,type,students})=>({id,number,x,y,type,students})),
      groups:s.groups.map(({id,name,color})=>({id,name,color})), roomName:s.roomName,
      roomWidth:s.roomWidth,roomHeight:s.roomHeight,zoom:s.zoom,deskType:s.deskType,nextId:s.nextId};
  }
  function validateWorkspace(w) {
    if (!w || w.version !== 1 || !Array.isArray(w.classes) || w.classes.length < 1 || w.classes.length > 100) throw Error('Cópia de turmas inválida.');
    const ids = new Set();
    const classes = w.classes.map(c => {
      if (typeof c.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(c.id) || ids.has(c.id)) throw Error('Identificador de turma inválido.');
      ids.add(c.id); return {id:c.id,state:validateState(c.state)};
    });
    if (!ids.has(w.activeId)) throw Error('Turma ativa inválida.');
    return {version:1,activeId:w.activeId,classes};
  }
  class Cloud {
    constructor(config, fetcher = root.fetch.bind(root)) {
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url) || !/^sb_publishable_[\w-]+$/.test(config.publishableKey)) throw Error('Configurar URL e chave pública do projeto Supabase de teste.');
      this.config = config; this.fetcher = fetcher; this.session = null;
    }
    async request(path, body, authenticated = true, method = 'POST') {
      const headers = {apikey:this.config.publishableKey,'Content-Type':'application/json'};
      if (authenticated) {
        if (!this.session) throw Error('Inicie sessão.');
        headers.Authorization = 'Bearer ' + this.session.access_token;
      }
      const response = await this.fetcher(this.config.url + path, {method,headers,body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const value = await response.text();
      let data; try { data = value ? JSON.parse(value) : null; } catch { throw Error('Resposta inválida do servidor.'); }
      if (!response.ok) {
        const error = Error(response.status === 401 ? 'Sessão expirada. Exporte as alterações e volte a entrar.' : data?.code === '40001' ? 'Conflito: existem alterações noutro dispositivo.' : 'Pedido recusado ou serviço indisponível. Tente novamente.');
        error.conflict = data?.code === '40001'; throw error;
      }
      return data;
    }
    sendCode(email) { return this.request('/auth/v1/otp',{email,create_user:true},false); }
    async verify(email,token) {
      const session = await this.request('/auth/v1/verify',{email,token,type:'email'},false);
      if (!session?.user?.id || !session.access_token) throw Error('Não foi possível iniciar sessão.');
      this.session = session;
      return session.user;
    }
    async load() {
      const rows = await this.request('/rest/v1/planta_workspaces?select=payload,revision&user_id=eq.' + encodeURIComponent(this.session.user.id),undefined,true,'GET');
      if (!Array.isArray(rows) || rows.length > 1) throw Error('Resposta inválida.');
      return rows.length ? {workspace:validateWorkspace(rows[0].payload),revision:rows[0].revision} : null;
    }
    save(workspace, revision) { return this.request('/rest/v1/rpc/planta_save',{expected_revision:revision,document:validateWorkspace(workspace)}); }
    async logout() { try { await this.request('/auth/v1/logout',undefined); } finally { this.session = null; } }
  }
  root.PlantaPersistence = {validateState,validateWorkspace,Cloud,clone};
})(globalThis);
