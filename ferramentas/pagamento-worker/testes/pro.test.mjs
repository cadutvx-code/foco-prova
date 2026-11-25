// node --test testes/   (banco de mentira; não toca em dados reais)
import test from "node:test"; import assert from "node:assert/strict";
import { liberarPro, estornarPro, precoDe, podeIA, LIMITE_IA } from "../src/pro.js"; import { bancoFirestore } from "../src/grupos.js";
const D = 86400000, E = "a@b.com", C = "liberados/" + E;
function banco(ini) {
  const docs = new Map(ini ? [[C, { dados: ini, versao: "v0" }]] : []); let n = 0; const p = () => new Promise(r => setTimeout(r, Math.random() * 4));
  return { docs, falha: false,
    async ler(c) { await p(); if (this.falha) throw new Error("banco indisponível (429)"); const d = docs.get(c); return d ? structuredClone(d) : null; },
    async gravar(l) { await p(); for (const i of l) { const d = docs.get(i.caminho); if (i.versao ? d?.versao !== i.versao : d) throw Object.assign(new Error("c"), { conflito: true }); docs.set(i.caminho, { dados: { ...(d?.dados || {}), ...i.dados }, versao: "v" + ++n }); } },
    async somar(c, k) { const d = docs.get(c)?.dados || {}; d[k] = (d[k] || 0) + 1; docs.set(c, { dados: d }); return d[k]; } };
}
const lib = (b, id, o = {}) => liberarPro(b, E, id, { nota: "x", agora: 1000 * D, ...o }), doc = b => b.docs.get(C).dados;
test("primeiro pagamento dá 30 dias e guarda o preço", async () => { const b = banco(); assert.equal(await lib(b, "p1"), 1030 * D); assert.equal(doc(b).precoFundador, 9.99); });
test("o mesmo pagamento não conta duas vezes, nem simultâneo", async () => { const b = banco(); await Promise.all([1, 2, 3].map(() => lib(b, "p1"))); assert.equal(doc(b).expira, 1030 * D); });
test("dois pagamentos simultâneos contam os dois", async () => { const b = banco(); await Promise.all([lib(b, "p1"), lib(b, "p2")]); assert.equal(doc(b).expira, 1060 * D); assert.equal(doc(b).pedidosPagos.length, 2); });
test("banco falhando na leitura não apaga nada", async () => { const ini = { expira: 1200 * D, precoFundador: 5, pedidosPagos: ["z"] }, b = banco({ ...ini }); b.falha = true; await assert.rejects(lib(b, "p1")); assert.deepEqual(doc(b), ini); });
test("mantém campos que não conhece e o preço antigo", async () => { const b = banco({ expira: 1200 * D, precoFundador: 5, extra: 1 }); await lib(b, "p1", { preco: 20 }); assert.equal(doc(b).extra, 1); assert.equal(doc(b).precoFundador, 5); assert.equal(doc(b).expira, 1230 * D); });
test("cadastro antigo sem data final", async () => { assert.equal(await lib(banco({ data: 990 * D }), "p1"), 1050 * D); });
test("reembolso tira os dias uma vez e não volta", async () => { const b = banco(); await lib(b, "p1"); await lib(b, "p2"); assert.equal(await estornarPro(b, E, "p1"), true); assert.equal(await estornarPro(b, E, "p1"), false); await lib(b, "p1"); assert.equal(doc(b).expira, 1030 * D); });
test("reembolso de pagamento desconhecido não muda nada", async () => { assert.equal(await estornarPro(banco({ expira: 5 }), E, "zz"), false); assert.equal(await estornarPro(banco(), E, "zz"), false); });
test("preço de fundador", async () => { assert.equal(await precoDe(banco({ precoFundador: 9.99 }), E, 19.9), 9.99); assert.equal(await precoDe(banco(), E, 19.9), 19.9); assert.equal(await precoDe(banco({ precoFundador: 30 }), E, 19.9), 19.9); });
test("limite da IA reserva: grátis, Pro, vencido e administrador", async () => {
  const usar = async (b, adm) => { let ok = 0; for (let i = 0; i < 300; i++) ok += await podeIA(b, E, adm, 1000 * D) ? 1 : 0; return ok; };
  assert.equal(await usar(banco()), LIMITE_IA.gratis); assert.equal(await usar(banco({ expira: 1001 * D })), LIMITE_IA.pro); assert.equal(await usar(banco({ expira: 999 * D })), LIMITE_IA.gratis); assert.equal(await usar(banco(), true), 300);
});
test("gravação manda só os campos mudados; e-mail codificado na leitura", async () => {
  const ch = [], b = bancoFirestore("p", "t", async (u, o) => { ch.push([u, o]); return new Response(JSON.stringify(u.includes("commit") ? {} : { fields: {}, updateTime: "v" })); });
  await b.ler("liberados/a+b@c.com"); assert.match(ch[0][0], /a%2Bb%40c\.com$/);
  await b.gravar([{ caminho: C, dados: { x: 1 }, campos: ["x"], versao: "v" }]); assert.deepEqual(JSON.parse(ch[1][1].body).writes[0].updateMask, { fieldPaths: ["x"] });
});
