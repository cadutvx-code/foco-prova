// Grupos por sala e matéria (rota POST /grupo). Só o servidor grava em grupos/*: o site apenas lê e manda os pontos da semana.
// Banco:  grupos/{id}                { nome, sala, salaChave, materia, admin, adminNome, membros:[uid], pessoas:{uid:{nome,desde}}, pendentes, criado }
//         grupos/{id}/privado/dados  { sal, hash, pedidos:{uid:{nome,quando}}, removidos:[uid], tent:{uid:{n,ini}}, tentGeral:{n,ini} }   ← ninguém lê pelo site
//         grupos/{id}/semanas/{semana}/pontos/{uid}  ← o próprio membro grava pelo site (regras do Firestore)
export const LIMITES = { membros: 100, gruposPorPessoa: 5, pedidos: 100, tentativas: 5, tentativasGrupo: 50, janela: 3600000 };
export class ErroGrupo extends Error { constructor(codigo, msg) { super(msg); this.codigo = codigo; } }

const semAcento = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const ROMANOS = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6" };
// "Fisiología II" e "fisiologia 2" viram a mesma chave
export const chaveDe = t => semAcento(t).replace(/[^a-z0-9]+/g, " ").trim().split(" ").map(p => ROMANOS[p] || p).join("-").slice(0, 60);
const limpo = (t, max) => String(t || "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const hashSenha = async (sal, senha) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sal + ":" + senha)))].map(b => b.toString(16).padStart(2, "0")).join("");
const novaSenha = async senha => { const sal = crypto.randomUUID(); return { sal, hash: await hashSenha(sal, senha) }; };
const senhaOk = s => /^[0-9]{4}$/.test(String(s ?? ""));

// db = { ler(caminho) → {dados, versao} | null, consultar(campo, op, valor, limite) → [{id, dados}], gravar([{ caminho, dados | apagar, versao }]) }
//   versao: null = só se ainda não existir; texto = só se ninguém mudou desde a leitura. Conflito → lança erro com conflito = true.
async function tentar(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (!e.conflito || i >= 5) throw e.conflito ? new ErroGrupo("ocupado", "Muita gente ao mesmo tempo. Tente de novo.") : e; await new Promise(r => setTimeout(r, 40 + Math.random() * 120 * (i + 1))); }
  }
}
async function abrir(db, id) {
  id = String(id || ""); if (!/^[a-z0-9-]{1,60}__[a-z0-9-]{1,60}$/.test(id)) throw new ErroGrupo("nao-existe", "Grupo não encontrado.");
  const [g, p] = await Promise.all([db.ler("grupos/" + id), db.ler(`grupos/${id}/privado/dados`)]);
  if (!g || !p) throw new ErroGrupo("nao-existe", "Grupo não encontrado.");
  return { id, g: g.dados, p: p.dados, vg: g.versao, vp: p.versao };
}
const salvar = (db, x) => db.gravar([{ caminho: "grupos/" + x.id, dados: { ...x.g, pendentes: Object.keys(x.p.pedidos).length }, versao: x.vg }, { caminho: `grupos/${x.id}/privado/dados`, dados: x.p, versao: x.vp }]);
const soAdmin = (x, u) => { if (x.g.admin !== u.uid) throw new ErroGrupo("sem-permissao", "Só quem administra o grupo pode fazer isso."); };
const resumo = (id, g, uid) => ({ id, nome: g.nome, sala: g.sala, materia: g.materia, adminNome: g.adminNome, membros: g.membros.length, souMembro: g.membros.includes(uid) });
async function caberMaisUm(db, u) {
  if ((await db.consultar("membros", "ARRAY_CONTAINS", u.uid, LIMITES.gruposPorPessoa + 1)).length >= LIMITES.gruposPorPessoa) throw new ErroGrupo("limite", `Cada pessoa pode estar em até ${LIMITES.gruposPorPessoa} grupos.`);
}
function incluir(x, uid, nome, agora) {
  if (x.g.membros.includes(uid)) return;
  if (x.g.membros.length >= LIMITES.membros) throw new ErroGrupo("cheio", `O grupo já tem ${LIMITES.membros} pessoas.`);
  x.g.membros.push(uid); x.g.pessoas[uid] = { nome, desde: agora };
}

const ACOES = {
  async buscar(db, u, c) {
    const sala = chaveDe(c.sala); if (!sala) throw new ErroGrupo("dados", "Escreva o código da sala.");
    return { grupos: (await db.consultar("salaChave", "EQUAL", sala, 30)).map(x => resumo(x.id, x.dados, u.uid)) };
  },
  async criar(db, u, c, agora) {
    const sala = limpo(c.sala, 40), materia = limpo(c.materia, 50), nome = limpo(c.nome, 50) || materia, ks = chaveDe(sala), km = chaveDe(materia);
    if (!ks || !km) throw new ErroGrupo("dados", "Escreva a sala e a matéria.");
    if (!senhaOk(c.senha)) throw new ErroGrupo("dados", "A senha precisa ter exatamente 4 números.");
    const id = ks + "__" + km, existe = await db.ler("grupos/" + id);
    if (existe) return { jaExiste: true, grupo: resumo(id, existe.dados, u.uid) };
    await caberMaisUm(db, u);
    const g = { nome, sala, salaChave: ks, materia, admin: u.uid, adminNome: u.nome, membros: [u.uid], pessoas: { [u.uid]: { nome: u.nome, desde: agora } }, pendentes: 0, criado: agora };
    try {
      await db.gravar([{ caminho: "grupos/" + id, dados: g, versao: null },
        { caminho: `grupos/${id}/privado/dados`, dados: { ...(await novaSenha(c.senha)), pedidos: {}, removidos: [], tent: {}, tentGeral: { n: 0, ini: agora } }, versao: null }]);
    } catch (e) { // duas pessoas criaram ao mesmo tempo: vale a primeira
      if (!e.conflito) throw e;
      const g2 = await db.ler("grupos/" + id); if (!g2) throw new ErroGrupo("ocupado", "Tente de novo.");
      return { jaExiste: true, grupo: resumo(id, g2.dados, u.uid) };
    }
    return { ok: true, id };
  },
  async entrar(db, u, c, agora) {
    if (!senhaOk(c.senha)) throw new ErroGrupo("dados", "A senha tem 4 números.");
    await caberMaisUm(db, u);
    const r = await tentar(async () => {
      const x = await abrir(db, c.id);
      if (x.g.membros.includes(u.uid)) return { ok: true, id: x.id };
      if (x.p.removidos.includes(u.uid)) throw new ErroGrupo("removido", "Você saiu deste grupo por decisão de quem administra. Envie um pedido de entrada.");
      const vale = t => t && agora - t.ini < LIMITES.janela ? t : { n: 0, ini: agora };
      const meu = vale(x.p.tent[u.uid]), geral = vale(x.p.tentGeral);
      if (meu.n >= LIMITES.tentativas || geral.n >= LIMITES.tentativasGrupo) throw new ErroGrupo("bloqueado", "Muitas tentativas erradas. Tente de novo em até 1 hora ou envie um pedido de entrada.");
      for (const k of Object.keys(x.p.tent)) if (agora - x.p.tent[k].ini >= LIMITES.janela) delete x.p.tent[k];
      const certa = (await hashSenha(x.p.sal, String(c.senha))) === x.p.hash;
      if (certa) { incluir(x, u.uid, u.nome, agora); delete x.p.pedidos[u.uid]; delete x.p.tent[u.uid]; }
      else { x.p.tent[u.uid] = { ...meu, n: meu.n + 1 }; x.p.tentGeral = { ...geral, n: geral.n + 1 }; }
      await salvar(db, x); // a tentativa errada é gravada ANTES de responder (pedidos simultâneos não burlam o limite)
      return certa ? { ok: true, id: x.id } : { errada: LIMITES.tentativas - meu.n - 1 };
    });
    if ("errada" in r) throw new ErroGrupo("senha", r.errada > 0 ? `Senha errada. Restam ${r.errada} tentativas.` : "Senha errada. Tente de novo em até 1 hora ou envie um pedido de entrada.");
    return r;
  },
  async pedir(db, u, c, agora) {
    await caberMaisUm(db, u);
    return tentar(async () => {
      const x = await abrir(db, c.id);
      if (x.g.membros.includes(u.uid)) return { ok: true, id: x.id, membro: true };
      if (!x.p.pedidos[u.uid] && Object.keys(x.p.pedidos).length >= LIMITES.pedidos) throw new ErroGrupo("cheio", "Este grupo já tem muitos pedidos esperando.");
      x.p.pedidos[u.uid] = { nome: u.nome, quando: agora }; await salvar(db, x); return { ok: true, pedido: true };
    });
  },
  async painel(db, u, c) {
    const x = await abrir(db, c.id); soAdmin(x, u);
    return { pedidos: Object.entries(x.p.pedidos).map(([uid, p]) => ({ uid, ...p })).sort((a, b) => a.quando - b.quando) };
  },
  async decidir(db, u, c, agora) {
    const alvo = String(c.alvo || "");
    return tentar(async () => {
      const x = await abrir(db, c.id); soAdmin(x, u);
      const p = Object.hasOwn(x.p.pedidos, alvo) ? x.p.pedidos[alvo] : null; if (!p) throw new ErroGrupo("nao-existe", "Esse pedido não existe mais.");
      if (c.aceitar === true) {
        if ((await db.consultar("membros", "ARRAY_CONTAINS", alvo, LIMITES.gruposPorPessoa + 1)).length >= LIMITES.gruposPorPessoa) throw new ErroGrupo("limite", `Essa pessoa já está em ${LIMITES.gruposPorPessoa} grupos.`);
        incluir(x, alvo, p.nome, agora); x.p.removidos = x.p.removidos.filter(r => r !== alvo);
      }
      delete x.p.pedidos[alvo]; await salvar(db, x); return { ok: true };
    });
  },
  async remover(db, u, c) {
    const alvo = String(c.alvo || "");
    return tentar(async () => {
      const x = await abrir(db, c.id); soAdmin(x, u);
      if (alvo === u.uid) throw new ErroGrupo("dados", "Passe a administração antes de sair.");
      if (!x.g.membros.includes(alvo)) return { ok: true };
      x.g.membros = x.g.membros.filter(m => m !== alvo); delete x.g.pessoas[alvo];
      x.p.removidos = [...x.p.removidos.filter(r => r !== alvo), alvo].slice(-200); await salvar(db, x); return { ok: true };
    });
  },
  async sair(db, u, c) {
    return tentar(async () => {
      const x = await abrir(db, c.id); if (!x.g.membros.includes(u.uid)) return { ok: true };
      if (x.g.admin === u.uid) throw new ErroGrupo("admin", "Passe a administração para outra pessoa ou apague o grupo antes de sair.");
      x.g.membros = x.g.membros.filter(m => m !== u.uid); delete x.g.pessoas[u.uid]; await salvar(db, x); return { ok: true };
    });
  },
  async senha(db, u, c, agora) {
    if (!senhaOk(c.senha)) throw new ErroGrupo("dados", "A senha precisa ter exatamente 4 números.");
    return tentar(async () => {
      const x = await abrir(db, c.id); soAdmin(x, u);
      x.p = { ...x.p, ...(await novaSenha(c.senha)), tent: {}, tentGeral: { n: 0, ini: agora } }; await salvar(db, x); return { ok: true };
    });
  },
  async passar(db, u, c) {
    const alvo = String(c.alvo || "");
    return tentar(async () => {
      const x = await abrir(db, c.id); soAdmin(x, u);
      if (!x.g.membros.includes(alvo)) throw new ErroGrupo("dados", "Essa pessoa não está no grupo.");
      x.g.admin = alvo; x.g.adminNome = x.g.pessoas[alvo]?.nome || "Alguém"; await salvar(db, x); return { ok: true };
    });
  },
  async apagar(db, u, c) {
    return tentar(async () => {
      const x = await abrir(db, c.id); soAdmin(x, u);
      await db.gravar([{ caminho: "grupos/" + x.id, apagar: true, versao: x.vg }, { caminho: `grupos/${x.id}/privado/dados`, apagar: true, versao: x.vp }]); return { ok: true };
    });
  }
};
// u = { uid, nome }: uid conferido com o Google; nome é só para mostrar
export async function rotaGrupo(db, u, corpo, agora = Date.now()) {
  const nome = limpo(corpo.nomePessoa || u.nome, 40) || "Alguém";
  if (!Object.hasOwn(ACOES, String(corpo.acao))) throw new ErroGrupo("dados", "Ação desconhecida.");
  return ACOES[corpo.acao](db, { uid: u.uid, nome }, corpo, agora);
}

/* ---------- banco de verdade (Firestore REST, com a conta de serviço) ---------- */
export function paraFS(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(paraFS) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, paraFS(x)])) } };
}
export function deFS(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(deFS);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, deFS(x)]));
  return null;
}
export function bancoFirestore(projeto, token, buscar = fetch) {
  const raiz = `projects/${projeto}/databases/(default)/documents`, API = "https://firestore.googleapis.com/v1/";
  const chamar = async (url, opc = {}) => buscar(API + url, { ...opc, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  const campos = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, deFS(v)]));
  return {
    async ler(caminho) {
      const r = await chamar(`${raiz}/${caminho}`); if (r.status === 404) return null;
      if (!r.ok) throw new Error("banco indisponível (" + r.status + ")");
      const d = await r.json(); return { dados: campos(d.fields), versao: d.updateTime };
    },
    async consultar(campo, op, valor, limite) {
      const r = await chamar(`${raiz}:runQuery`, { method: "POST", body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "grupos" }], where: { fieldFilter: { field: { fieldPath: campo }, op, value: paraFS(valor) } }, limit: limite } }) });
      if (!r.ok) throw new Error("banco indisponível (" + r.status + ")");
      return (await r.json()).filter(x => x.document).map(x => ({ id: x.document.name.split("/").pop(), dados: campos(x.document.fields) }));
    },
    async gravar(itens) {
      const writes = itens.map(i => ({ ...(i.apagar ? { delete: `${raiz}/${i.caminho}` } : { update: { name: `${raiz}/${i.caminho}`, fields: paraFS(i.dados).mapValue.fields } }), currentDocument: i.versao ? { updateTime: i.versao } : { exists: false } }));
      const r = await chamar(`${raiz}:commit`, { method: "POST", body: JSON.stringify({ writes }) });
      if (r.ok) return;
      const t = await r.text();
      if (r.status === 409 || /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS/.test(t)) throw Object.assign(new Error("conflito"), { conflito: true });
      throw new Error("banco indisponível (" + r.status + ")");
    }
  };
}
