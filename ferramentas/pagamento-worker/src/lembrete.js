// Lembrete diário no celular (Web Push sem conteúdo: o texto fica no aviso.js do site, então nenhum dado do aluno passa pelo aviso).
// Banco: lembretes/{sha256 do endereço} { email, endereco, vez, idioma, criado } — só o servidor lê e grava.
// vez = bloco de 5 minutos do dia em UTC (0 a 287). O agendador do Cloudflare roda a cada 5 minutos e avisa quem é daquele bloco.
export const LIM = { porVez: 40, aparelhos: 5 }; // plano grátis do Cloudflare: até 50 chamadas por execução
// só os serviços de aviso dos navegadores (o servidor nunca chama um endereço inventado)
export function enderecoOk(e) {
  try { const u = new URL(String(e)), h = u.hostname; return String(e).length < 1000 && u.protocol === "https:" && !u.port && !u.username && (h === "fcm.googleapis.com" || h === "updates.push.services.mozilla.com" || h.endsWith(".push.apple.com") || h.endsWith(".notify.windows.com")); }
  catch { return false; }
}
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
export const idDe = async e => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e)));
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const deB64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const lerChave = txt => JSON.parse(String(txt).replace(/^﻿/, "").trim());
export function chavePublica(jwkTxt) { const k = lerChave(jwkTxt); return b64u(new Uint8Array([4, ...deB64u(k.x), ...deB64u(k.y)])); }
export async function assinar(jwkTxt, origem, agora = Date.now()) {
  const k = lerChave(jwkTxt), priv = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x, y: k.y, d: k.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const t = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const base = t({ typ: "JWT", alg: "ES256" }) + "." + t({ aud: origem, exp: Math.floor(agora / 1000) + 6 * 3600, sub: "https://hipocampo.web.app" });
  return base + "." + b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(base)));
}
export const vezDe = t => Math.floor(t / 300000) % 288;

export async function rotaLembrete(db, jwk, email, c, agora = Date.now()) {
  if (!jwk) return { erro: "lembretes ainda não configurados", codigo: "sem-chave" };
  if (c.acao === "chave") return { chave: chavePublica(jwk) };
  const meus = () => db.consultar("email", "EQUAL", email, 30, "lembretes");
  if (c.acao === "apagar-todos") { for (const x of await meus()) await db.gravar([{ caminho: "lembretes/" + x.id, apagar: true, versao: x.versao }]); return { ok: true }; }
  if (!enderecoOk(c.endereco)) return { erro: "este navegador não é compatível", codigo: "endereco" };
  const caminho = "lembretes/" + await idDe(c.endereco), atual = await db.ler(caminho);
  if (c.acao === "desligar") { if (atual && atual.dados.email === email) await db.gravar([{ caminho, apagar: true, versao: atual.versao }]); return { ok: true }; }
  if (c.acao !== "ligar") return { erro: "ação desconhecida" };
  let vez = Number(c.vez); if (!Number.isInteger(vez) || vez < 0 || vez > 287) return { erro: "horário inválido" };
  if ((await meus()).filter(x => "lembretes/" + x.id !== caminho).length >= LIM.aparelhos) return { erro: `limite de ${LIM.aparelhos} aparelhos`, codigo: "limite" };
  for (let i = 0; ; i++) { // horário cheio: usa o próximo bloco de 5 minutos
    const l = (await db.consultar("vez", "EQUAL", vez, LIM.porVez, "lembretes")).filter(x => "lembretes/" + x.id !== caminho);
    if (l.length < LIM.porVez) break;
    if (i >= 11) return { erro: "horário cheio, escolha outro", codigo: "cheio" };
    vez = (vez + 1) % 288;
  }
  await db.gravar([{ caminho, dados: { email, endereco: c.endereco, vez, idioma: c.idioma === "es" ? "es" : "pt", criado: agora }, versao: atual?.versao || null }]);
  return { ok: true, vez };
}
// Roda a cada 5 minutos. Assinatura uma vez por serviço (poupa processamento); endereço morto é apagado.
export async function enviarLembretes(db, jwk, quando, buscar = fetch) {
  if (!jwk) return { enviados: 0 };
  const lista = await db.consultar("vez", "EQUAL", vezDe(quando), LIM.porVez, "lembretes"), jwts = new Map(), pub = lista.length ? chavePublica(jwk) : "", mortos = []; let enviados = 0;
  for (const { dados: d } of lista) { const o = new URL(d.endereco).origin; if (!jwts.has(o)) jwts.set(o, await assinar(jwk, o, quando)); }
  await Promise.all(lista.map(async x => {
    if (!enderecoOk(x.dados.endereco)) return mortos.push(x);
    try {
      const r = await buscar(x.dados.endereco, { method: "POST", redirect: "manual", headers: { TTL: "3600", Urgency: "normal", Topic: "revisao", Authorization: `vapid t=${jwts.get(new URL(x.dados.endereco).origin)}, k=${pub}` } });
      if (r.status === 404 || r.status === 410) mortos.push(x); else if (r.ok) enviados++; else console.log("lembrete recusado", r.status);
    } catch (e) { console.log("lembrete", e.message); }
  }));
  if (mortos.length) await db.gravar(mortos.map(x => ({ caminho: "lembretes/" + x.id, apagar: true, versao: x.versao }))).catch(e => console.log("limpar lembretes", e.message));
  return { enviados, apagados: mortos.length };
}
