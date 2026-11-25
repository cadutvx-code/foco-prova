// node --test ferramentas/testes/   — dois aparelhos de mentira usando o código REAL de sincronização do index.html
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";
const src = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const codigo = src.slice(src.indexOf("const caminhoUser = () =>"), src.indexOf("/* ================= novo caderno"));
let relogio = 1000; Date.now = () => ++relogio;
const copia = x => JSON.parse(JSON.stringify(x));
function nuvem() { return new Map(); }
function aparelho(docs) {
  const ctl = { falhar: null };
  const snap = p => ({ id: p.split("/").pop(), ref: p, exists: () => docs.has(p), data: () => copia(docs.get(p)) });
  const F = { doc: (_, p) => p, collection: (_, p) => p, getDoc: async p => snap(p), deleteDoc: async p => { docs.delete(p); },
    getDocs: async p => ({ docs: [...docs.keys()].filter(k => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).map(snap) }),
    setDoc: async (p, v) => { if (ctl.falhar && p.includes(ctl.falhar)) throw new Error("rede"); docs.set(p, copia(v)); } };
  const S = { cadernos: [] }, NUVEM = { F, db: 1, user: { uid: "u" }, pendentes: new Set(), ocupada: false };
  const ls = {}, f = new Function("NUVEM", "S", "dbPut", "dbDel", "render", "estadoNuvem", "toast", "lsGet", "lsSet", "fecharVoz", "console", "setTimeout", "clearTimeout", "navigator",
    codigo + "\nreturn { sincronizarTudo, enviarPendentes, juntarCadernos, cadernoLeve };");
  const api = f(NUVEM, S, async () => {}, async () => {}, () => {}, t => { ctl.estado = t; }, () => {}, (k, d) => ls[k] ?? d, (k, v) => { ls[k] = v; }, () => {}, { warn() {} }, () => 0, () => {}, { onLine: true });
  return { S, ctl, NUVEM, ...api, c: () => S.cadernos[0], mudar(fn, c = S.cadernos[0]) { fn(c); c.atualizado = Date.now(); NUVEM.pendentes.add(c.id); } };
}
const caderno = (id = "k") => ({ id, nome: "Fisio", atualizado: Date.now(), materiais: [{ id: "m1", nome: "a", texto: "texto a" }], decks: [{ id: "d0" }], quizzes: [], chat: [] });
async function dois() { const n = nuvem(), A = aparelho(n), B = aparelho(n); A.S.cadernos.push(caderno()); await A.sincronizarTudo(); await B.sincronizarTudo(); return { n, A, B }; }
const ids = l => l.map(x => x.id).sort().join();

test("caminho normal: sobe, baixa e não fica em laço", async () => { const { n, A, B } = await dois(); assert.equal(B.c().materiais[0].texto, "texto a"); const antes = n.get("users/u/cadernos/k").atualizado; await A.sincronizarTudo(); await B.sincronizarTudo(); assert.equal(n.get("users/u/cadernos/k").atualizado, antes); });
test("os dois mudam: o app aberto não grava por cima do outro", async () => { const { A, B } = await dois(); A.mudar(c => c.decks.push({ id: "dA" })); B.mudar(c => c.decks.push({ id: "dB" })); await A.enviarPendentes(); await B.enviarPendentes(); await A.sincronizarTudo(); for (const x of [A, B]) assert.equal(ids(x.c().decks), "d0,dA,dB"); });
test("mudança sem internet não some quando a nuvem é mais nova", async () => { const { A, B } = await dois(); B.mudar(c => c.quizzes.push({ id: "qB" })); A.mudar(c => c.decks.push({ id: "dA" })); await A.enviarPendentes(); await B.sincronizarTudo(); await A.sincronizarTudo(); for (const x of [A, B]) { assert.equal(ids(x.c().decks), "d0,dA"); assert.equal(ids(x.c().quizzes), "qB"); } });
test("materiais novos dos dois lados ficam, com texto", async () => { const { A, B } = await dois(); A.mudar(c => c.materiais.push({ id: "mA", texto: "tA" })); B.mudar(c => c.materiais.push({ id: "mB", texto: "tB" })); await A.enviarPendentes(); await B.enviarPendentes(); await A.sincronizarTudo(); for (const x of [A, B]) { assert.equal(ids(x.c().materiais), "m1,mA,mB"); assert.equal(x.c().materiais.map(m => m.texto).sort().join(), "tA,tB,texto a"); } });
test("material apagado num aparelho não volta", async () => { const { A, B } = await dois(); A.mudar(c => { c.materiais = []; }); B.mudar(c => c.decks.push({ id: "dB" })); await A.enviarPendentes(); await B.enviarPendentes(); await A.sincronizarTudo(); for (const x of [A, B]) { assert.equal(x.c().materiais.length, 0); assert.equal(ids(x.c().decks), "d0,dB"); } });
test("material apagado aqui enquanto o outro muda outra coisa", async () => { const { A, B } = await dois(); A.mudar(c => c.decks.push({ id: "dA" })); B.mudar(c => { c.materiais = []; }); await A.enviarPendentes(); await B.enviarPendentes(); await A.sincronizarTudo(); for (const x of [A, B]) assert.equal(x.c().materiais.length, 0); });
test("progresso: domínio, XP e histórico não diminuem", async () => { const { A, B } = await dois(); A.mudar(c => { c.dominio = { x: { tentativas: 9 } }; c.inteligente = { xp: 90, historico: ["p1", "p2"] }; }); B.mudar(c => { c.dominio = { x: { tentativas: 2 }, y: { tentativas: 1 } }; c.inteligente = { xp: 20, historico: ["p3"] }; }); await A.enviarPendentes(); await B.enviarPendentes(); const c = B.c(); assert.equal(c.dominio.x.tentativas, 9); assert.equal(c.dominio.y.tentativas, 1); assert.equal(c.inteligente.xp, 90); assert.equal(c.inteligente.historico.length, 3); });
test("um caderno com erro não trava os outros e continua na fila", async () => { const { n, A } = await dois(); const k2 = caderno("k2"); A.S.cadernos.push(k2); A.mudar(c => c.nome = "novo"); A.mudar(() => {}, k2); A.ctl.falhar = "cadernos/k2"; await A.enviarPendentes(); assert.ok(A.NUVEM.pendentes.has("k2")); assert.match(n.get("users/u/cadernos/k").dados, /novo/); A.ctl.falhar = null; await A.enviarPendentes(); assert.ok(n.has("users/u/cadernos/k2")); });
test("caderno antigo, de antes desta versão, sincroniza normal", async () => { const { A, B } = await dois(); for (const x of [A, B]) delete x.c()._nuvem; A.mudar(c => c.nome = "X"); await A.enviarPendentes(); await B.sincronizarTudo(); assert.equal(B.c().nome, "X"); assert.ok(!/_nuvem/.test(A.cadernoLeve(A.c()))); });
test("caderno apagado no outro aparelho continua apagado", async () => { const { n, A, B } = await dois(); n.set("users/u/cadernos/k", { apagado: true, atualizado: Date.now(), dados: "" }); await B.sincronizarTudo(); assert.equal(B.S.cadernos.length, 0); assert.equal(A.S.cadernos.length, 1); });
test("as telas abertas continuam com o mesmo caderno na memória", async () => { const { A, B } = await dois(); const ref = B.c(), intel = { xp: 1 }; A.mudar(c => c.nome = "Y"); await A.enviarPendentes(); B.mudar(c => { c.inteligente = intel; }); await B.enviarPendentes(); assert.equal(B.c(), ref); assert.equal(ref.inteligente, intel); });
