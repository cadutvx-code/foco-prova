// Hipocampo Study — pagamento automático do Pro (Pix pelo Mercado Pago, API de Orders)
// Rotas:  POST /criar   { idToken }            → cria um Pix de R$ PRECO para o e-mail da pessoa logada
//         POST /status  { idToken, id }        → confere no Mercado Pago; se pago, libera DIAS de Pro
//         POST /cartao  { idToken }            → cria um link do Checkout do Mercado Pago (cartão) para o e-mail logado
//         POST /status-cartao { idToken }      → procura pagamento aprovado desse e-mail feito pelo checkout; se achar, libera
//         POST /assinar { idToken }            → cria uma ASSINATURA mensal no cartão de crédito (Mercado Pago) e devolve o link
//         POST /assinatura { idToken }         → situação da assinatura; libera os meses já cobrados que ainda não foram somados
//         POST /cancelar-assinatura { idToken } → cancela a renovação (o Pro vai até o fim do que já foi pago)
//         POST /ia { idToken, system, prompt, json, maxTokens } → IA RESERVA (quando a cota grátis do Gemini acaba): Groq → Cloudflare → OpenRouter
//         POST /grupo { idToken, acao, ... } → grupos por sala e matéria (grupos.js)
//         POST /webhook (aviso do Mercado Pago) → confere o pedido e libera
// Segredos (wrangler secret put): MP_TOKEN (Access Token do Mercado Pago), SA_JSON (chave da conta de serviço do Firebase)

import { rotaGrupo, bancoFirestore } from "./grupos.js";

const ORIGENS = ["https://hipocampo.web.app", "https://hipocampo.firebaseapp.com", "https://focoprova.web.app", "https://focoprova.firebaseapp.com", "http://localhost:47821", "http://localhost:47822"];

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return { "Access-Control-Allow-Origin": ORIGENS.includes(o) ? o : ORIGENS[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
}
const json = (req, dados, status = 200) => new Response(JSON.stringify(dados), { status, headers: { "Content-Type": "application/json", ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const rota = new URL(req.url).pathname;
    try {
      if (rota === "/" ) return json(req, { ok: true, servico: "pagamento Hipocampo Study" });
      if (req.method !== "POST") return json(req, { erro: "método não permitido" }, 405);
      if (rota === "/webhook") return await webhook(req, env);
      if (rota === "/ia-saude") return json(req, await saudeIA(req, env)); // conferência das reservas (protegida por SAUDE_CHAVE)
      const corpo = await req.json().catch(() => ({}));
      const email = await emailDoLogin(env, corpo.idToken);
      if (!email) return json(req, { erro: "faça login com o Google de novo" }, 401);
      if (rota === "/grupo") return json(req, await grupo(env, corpo));
      if (rota === "/ia") return json(req, await iaReserva(env, corpo));
      if (rota === "/pdf-cota") return json(req, await cotaPDF(env, email, corpo.acao));
      if (rota === "/criar") return json(req, await criarPix(env, email));
      if (rota === "/status") return json(req, await conferir(env, corpo.id, email));
      if (rota === "/cartao") return json(req, await criarCheckout(env, email));
      if (rota === "/status-cartao") return json(req, await conferirCheckout(env, email));
      if (rota === "/assinar") return json(req, await criarAssinatura(env, email));
      if (rota === "/assinatura") return json(req, await situacaoAssinatura(env, email));
      if (rota === "/cancelar-assinatura") return json(req, await cancelarAssinatura(env, email));
      return json(req, { erro: "rota desconhecida" }, 404);
    } catch (e) {
      return json(req, { erro: String(e?.message || e).slice(0, 300) }, 500);
    }
  }
};

// Confere com o Google quem está logado (o e-mail não pode ser falsificado pelo site)
async function emailDoLogin(env, idToken) {
  if (!idToken) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FB_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
  if (!r.ok) return null;
  const u = (await r.json()).users?.[0];
  return u?.email && u.emailVerified ? u.email.toLowerCase() : null;
}

// Grupos por sala e matéria: confere o uid no Google e chama a lógica de grupos.js (erros esperados voltam com código)
async function grupo(env, corpo) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FB_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: corpo.idToken }) });
  const u = r.ok ? (await r.json()).users?.[0] : null;
  if (!u?.localId) return { erro: "faça login com o Google de novo", codigo: "login" };
  try { return await rotaGrupo(bancoFirestore(env.FB_PROJETO, await tokenGoogle(env)), { uid: u.localId, nome: u.displayName || "" }, corpo); }
  catch (e) { if (!e.codigo) { console.log("grupo", corpo.acao, e.message); return { erro: "Não consegui falar com o servidor agora.", codigo: "servidor" }; } return { erro: e.message, codigo: e.codigo }; }
}

async function mp(env, caminho, opcoes = {}) {
  const r = await fetch("https://api.mercadopago.com" + caminho, { ...opcoes, headers: { "Authorization": `Bearer ${env.MP_TOKEN}`, "Content-Type": "application/json", ...(opcoes.headers || {}) } });
  const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {}
  if (!r.ok) {
    console.log("Mercado Pago", r.status, caminho, t.slice(0, 1500));
    const motivo = [d.message, ...(d.errors || []).map(x => [x.code, x.message, ...(x.details || [])].filter(Boolean).join(" - ")), d.cause?.[0]?.description].filter(Boolean).join(" | ") || t || "(sem detalhe)";
    throw new Error(`Mercado Pago ${r.status}: ${motivo.slice(0, 300)}`);
  }
  return d;
}

const refDe = email => btoa(unescape(encodeURIComponent(email))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function emailDaRef(ref) {
  ref = String(ref || "");
  if (ref.includes("@")) return ref.toLowerCase();
  try { const b = ref.replace(/-/g, "+").replace(/_/g, "/"); return decodeURIComponent(escape(atob(b + "===".slice((b.length + 3) % 4)))).toLowerCase(); } catch { return ""; }
}
// Credencial de TESTE gera QR falso (o banco diz "chave não existe"): nesse caso nem tenta, e o site usa o Pix comum
let contaCache = { teste: null, ate: 0 };
async function contaDeTeste(env) {
  if (String(env.MP_TOKEN || "").startsWith("TEST-")) return true;
  if (contaCache.teste !== null && Date.now() < contaCache.ate) return contaCache.teste;
  const u = await mp(env, "/users/me");
  contaCache = { teste: (u.tags || []).includes("test_user"), ate: Date.now() + 10 * 60000 };
  return contaCache.teste;
}
async function criarPix(env, email) {
  if (await contaDeTeste(env)) { console.log("MP_TOKEN é de conta de TESTE: troque pela credencial de produção"); throw new Error("pagamento automático em manutenção"); }
  try { return await criarPixOrders(env, email); }
  catch (e) { console.log("Orders recusou, tentando Pagamentos:", e.message); return await criarPixPagamento(env, email); }
}
async function criarPixPagamento(env, email) {
  const preco = Math.round(Number(env.PRECO || "9.99") * 100) / 100;
  const vence = new Date(Date.now() + 30 * 60000).toISOString().replace("Z", "-00:00");
  const p = await mp(env, "/v1/payments", {
    method: "POST",
    headers: { "X-Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: preco, description: "Hipocampo Study Pro - 30 dias", payment_method_id: "pix",
      external_reference: email, date_of_expiration: vence, payer: { email }, metadata: { origem: "pix-pagamento" }
    })
  });
  const td = p.point_of_interaction?.transaction_data || {};
  return { id: "pay_" + p.id, status: p.status, qr_code: td.qr_code, qr_code_base64: td.qr_code_base64, ticket_url: td.ticket_url, valor: preco.toFixed(2) };
}
async function criarPixOrders(env, email) {
  const preco = Number(env.PRECO || "9.99").toFixed(2);
  const pedido = await mp(env, "/v1/orders", {
    method: "POST",
    headers: { "X-Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      type: "online", processing_mode: "automatic", total_amount: preco,
      external_reference: refDe(email),
      payer: { email },
      transactions: { payments: [{ amount: preco, payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: "PT30M" }] }
    })
  });
  const pg = pedido.transactions?.payments?.[0]?.payment_method || {};
  return { id: pedido.id, status: pedido.status, qr_code: pg.qr_code, qr_code_base64: pg.qr_code_base64, ticket_url: pg.ticket_url, valor: preco };
}

// Cartão: página oficial do Mercado Pago (o número do cartão nunca passa pelo site)
const SITE = "https://hipocampo.web.app";
async function criarCheckout(env, email) {
  if (await contaDeTeste(env)) throw new Error("pagamento automático em manutenção");
  const preco = Math.round(Number(env.PRECO || "9.99") * 100) / 100;
  const pref = await mp(env, "/checkout/preferences", {
    method: "POST",
    body: JSON.stringify({
      items: [{ id: "pro-30", title: "Hipocampo Study Pro - 30 dias", quantity: 1, unit_price: preco, currency_id: "BRL" }],
      payer: { email },
      external_reference: refDe(email),
      metadata: { origem: "checkout" },
      payment_methods: { excluded_payment_types: [{ id: "ticket" }], installments: 1 },
      back_urls: { success: SITE + "/?pago=cartao", pending: SITE + "/?pago=cartao", failure: SITE + "/?pago=falhou" },
      auto_return: "approved",
      notification_url: "https://hipocampo-pagamento.pagamento-worker.workers.dev/webhook",
      statement_descriptor: "HIPOCAMPO",
      expires: true, expiration_date_to: new Date(Date.now() + 24 * 3600000).toISOString()
    })
  });
  return { url: pref.init_point };
}
async function conferirCheckout(env, email) {
  const r = await mp(env, `/v1/payments/search?external_reference=${encodeURIComponent(refDe(email))}&sort=date_created&criteria=desc&limit=20`);
  // libera cada pagamento aprovado ainda não contado (o liberar() ignora os que já foram somados)
  const aprovados = (r.results || []).filter(x => x.status === "approved" && x.metadata?.origem === "checkout").reverse();
  if (!aprovados.length) return { pago: false };
  let expira = 0;
  for (const x of aprovados) expira = await liberar(env, email, "pay_" + x.id);
  return { pago: true, expira };
}

const pago = p => p?.status === "processed" || p?.status_detail === "accredited" || p?.transactions?.payments?.[0]?.status === "processed";

async function conferir(env, id, emailPedido) {
  if (!id || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error("pedido inválido");
  let email, ok, status, ref = id;
  if (id.startsWith("pay_")) {
    const p = await mp(env, "/v1/payments/" + encodeURIComponent(id.slice(4)));
    if (!["checkout", "pix-pagamento"].includes(p.metadata?.origem)) return { pago: false, status: "contado pelo pedido" };
    email = emailDaRef(p.external_reference); ok = p.status === "approved"; status = p.status;
  } else {
    const pedido = await mp(env, "/v1/orders/" + encodeURIComponent(id));
    email = emailDaRef(pedido.external_reference); ok = pago(pedido); status = pedido.status; ref = pedido.id;
  }
  if (emailPedido && email !== emailPedido) throw new Error("este pagamento é de outra conta");
  if (!ok) return { pago: false, status };
  const expira = await liberar(env, email, ref);
  return { pago: true, expira };
}

// Aviso do Mercado Pago: não confia no conteúdo, só no id — e confere direto na API com o nosso token
async function webhook(req, env) {
  const corpo = await req.json().catch(() => ({}));
  const url = new URL(req.url);
  const bruto = corpo?.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id");
  const tipo = corpo?.type || url.searchParams.get("type") || url.searchParams.get("topic") || "";
  if (/subscription|preapproval/i.test(tipo)) {
    try { if (bruto) await avisoAssinatura(env, tipo, String(bruto)); } catch (e) { console.log("webhook assinatura", tipo, bruto, e.message); }
    return new Response("ok", { status: 200 });
  }
  const id = bruto ? (/payment/i.test(tipo) || /^\d+$/.test(String(bruto)) ? "pay_" + bruto : String(bruto)) : null;
  if (id) { try { await conferir(env, id, null); } catch (e) { console.log("webhook", id, e.message); } }
  return new Response("ok", { status: 200 });
}

/* ---------- Firebase (Firestore pela API REST, com a conta de serviço) ---------- */
let tokenCache = { valor: "", ate: 0 };
async function tokenGoogle(env) {
  if (tokenCache.valor && Date.now() < tokenCache.ate) return tokenCache.valor;
  const sa = JSON.parse(String(env.SA_JSON).replace(/^﻿/, "").trim()); // a chave pode vir com BOM (caractere invisível) do PowerShell
  const b64 = o => btoa(typeof o === "string" ? o : JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const agora = Math.floor(Date.now() / 1000);
  const base = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600 });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const chave = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(base)));
  const jwt = base + "." + btoa(String.fromCharCode(...assinatura)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt });
  const d = await r.json();
  if (!d.access_token) throw new Error("Firebase recusou a chave: " + JSON.stringify(d).slice(0, 150));
  tokenCache = { valor: d.access_token, ate: Date.now() + 50 * 60000 };
  return d.access_token;
}
const DOCS = env => `https://firestore.googleapis.com/v1/projects/${env.FB_PROJETO}/databases/(default)/documents`;
const int = v => ({ integerValue: String(Math.round(v)) });
const txt = v => ({ stringValue: String(v) });

async function liberar(env, email, pedidoId, nota = "pago pelo Pix (automático)") {
  const tok = await tokenGoogle(env), H = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
  const url = `${DOCS(env)}/liberados/${encodeURIComponent(email)}`;
  const r = await fetch(url, { headers: H });
  const atual = r.ok ? (await r.json()).fields || {} : {};
  const pagos = (atual.pedidosPagos?.arrayValue?.values || []).map(v => v.stringValue);
  const expiraAtual = Number(atual.expira?.integerValue || 0);
  if (pagos.includes(pedidoId)) return expiraAtual; // esse pagamento já foi contado
  const agora = Date.now(), dias = Number(env.DIAS || 30);
  const expira = Math.max(agora, expiraAtual) + dias * 86400000;
  const campos = {
    inicio: atual.inicio || int(Number(atual.data?.integerValue) || agora), data: int(agora), expira: int(expira),
    renovacoes: int(Number(atual.renovacoes?.integerValue || 0) + (r.ok ? 1 : 0)),
    nota: txt(nota), por: txt("pagamento automático"),
    precoFundador: atual.precoFundador || { doubleValue: Number(env.PRECO || "9.99") }, fundadorDesde: atual.fundadorDesde || int(agora),
    pedidosPagos: { arrayValue: { values: [...pagos.slice(-30), pedidoId].map(txt) } }
  };
  const w = await fetch(url, { method: "PATCH", headers: H, body: JSON.stringify({ fields: campos }) });
  if (!w.ok) throw new Error("não consegui gravar o Pro: " + (await w.text()).slice(0, 150));
  await fetch(`${DOCS(env)}/solicitacoes/${encodeURIComponent(email)}`, { method: "DELETE", headers: H }).catch(() => {});
  return expira;
}

/* ---------- Assinatura mensal no cartão de crédito (API de assinaturas do Mercado Pago) ---------- */
// Os ids das assinaturas de cada e-mail ficam em assinaturas/{email} (só o servidor lê e grava)
async function idsAssinatura(env, email) {
  const tok = await tokenGoogle(env);
  const r = await fetch(`${DOCS(env)}/assinaturas/${encodeURIComponent(email)}`, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) return [];
  return ((await r.json()).fields?.ids?.arrayValue?.values || []).map(v => v.stringValue);
}
async function guardarIdAssinatura(env, email, id) {
  const ids = [...(await idsAssinatura(env, email)).filter(x => x !== id), id].slice(-10);
  const tok = await tokenGoogle(env);
  await fetch(`${DOCS(env)}/assinaturas/${encodeURIComponent(email)}`, { method: "PATCH", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { ids: { arrayValue: { values: ids.map(txt) } }, atualizado: int(Date.now()) } }) });
}
async function criarAssinatura(env, email) {
  if (await contaDeTeste(env)) throw new Error("pagamento automático em manutenção");
  // se já tem uma ativa, não cria outra (evita cobrar 2 vezes por mês)
  const sit = await situacaoAssinatura(env, email);
  if (sit.ativa) return { jaAtiva: true, ...sit };
  const preco = Math.round(Number(env.PRECO || "9.99") * 100) / 100;
  const a = await mp(env, "/preapproval", {
    method: "POST",
    body: JSON.stringify({
      reason: "Hipocampo Study Pro (mensal)",
      external_reference: refDe(email),
      payer_email: email,
      back_url: SITE + "/?pago=assinatura",
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: preco, currency_id: "BRL" },
      status: "pending"
    })
  });
  await guardarIdAssinatura(env, email, a.id);
  return { url: a.init_point, id: a.id };
}
// Libera cada cobrança aprovada da assinatura (o liberar() ignora as que já foram somadas)
async function liberarCobrancas(env, email, preId) {
  let expira = 0;
  const r = await mp(env, `/authorized_payments/search?preapproval_id=${encodeURIComponent(preId)}&limit=50`).catch(() => ({ results: [] }));
  const pagos = (r.results || []).filter(x => x.payment?.status === "approved" && x.payment?.id).reverse();
  for (const x of pagos) expira = await liberar(env, email, "pay_" + x.payment.id, "assinatura no cartão");
  return expira;
}
async function situacaoAssinatura(env, email) {
  const ids = await idsAssinatura(env, email);
  let ativa = null, expira = 0;
  for (const id of ids) {
    const a = await mp(env, "/preapproval/" + encodeURIComponent(id)).catch(() => null);
    if (!a || emailDaRef(a.external_reference) !== email) continue;
    const e = await liberarCobrancas(env, email, id); if (e) expira = e;
    if (a.status === "authorized") ativa = { id, proxima: a.next_payment_date || null, valor: a.auto_recurring?.transaction_amount };
  }
  return { ativa: !!ativa, ...(ativa || {}), pago: !!expira, expira };
}
async function cancelarAssinatura(env, email) {
  let n = 0;
  for (const id of await idsAssinatura(env, email)) {
    const a = await mp(env, "/preapproval/" + encodeURIComponent(id)).catch(() => null);
    if (!a || emailDaRef(a.external_reference) !== email || !["authorized", "paused", "pending"].includes(a.status)) continue;
    await mp(env, "/preapproval/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
    n++;
  }
  return { cancelada: n > 0 };
}
// Aviso do Mercado Pago sobre assinatura: confere tudo direto na API (não confia no conteúdo do aviso)
async function avisoAssinatura(env, tipo, id) {
  let preId = id;
  if (/authorized_payment/i.test(tipo)) { const ap = await mp(env, "/authorized_payments/" + encodeURIComponent(id)); preId = ap.preapproval_id; }
  if (!preId) return;
  const a = await mp(env, "/preapproval/" + encodeURIComponent(preId));
  const email = emailDaRef(a.external_reference);
  if (!email || !email.includes("@")) return;
  await guardarIdAssinatura(env, email, preId);
  await liberarCobrancas(env, email, preId);
}

// ================= IA reserva =================
// Só para quem está logado (o e-mail é conferido acima). Tenta, em ordem: Groq (se GROQ_KEY), a IA do próprio Cloudflare
// (grátis, sem cadastro) e OpenRouter (se OPENROUTER_KEY). Modelos grandes, temperatura baixa (menos invenção).
// testados em 23/11/2026 (todos acertaram a pergunta de teste; o DeepSeek dá 403 nesta conta)
// ordem pedida pelo usuário: GPT primeiro, Llama por último
const MODELOS_CF = ["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b", "@cf/qwen/qwen3.8-27b", "@cf/google/gemma-4-26b-a4b-it", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
async function iaReserva(env, { system = "", prompt = "", json: querJSON = false, maxTokens = 2500 }) {
  system = String(system).slice(0, 16000); prompt = String(prompt).slice(0, 9000);
  const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
  const max = Math.min(4000, Math.max(200, Number(maxTokens) || 2500)), erros = [];
  let ultUso = null; const usoDe = u => u && (u.prompt_tokens || u.completion_tokens) ? { promptTokenCount: u.prompt_tokens || 0, candidatesTokenCount: u.completion_tokens || 0 } : null;
  const openai = async (url, chave, model) => {
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, max_tokens: max, temperature: 0.3, ...(querJSON ? { response_format: { type: "json_object" } } : {}) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error?.message || "HTTP " + r.status).slice(0, 120));
    ultUso = usoDe(d.usage);
    return d.choices?.[0]?.message?.content || "";
  };
  if (env.GROQ_KEY) for (const m of String(env.GROQ_MODELOS || "openai/gpt-oss-120b,openai/gpt-oss-20b").split(",")) {
    try { const t = await openai("https://api.groq.com/openai/v1/chat/completions", env.GROQ_KEY, m.trim()); if (t) return { texto: t, via: "groq " + m.trim(), uso: ultUso }; } catch (e) { erros.push("groq " + m + ": " + e.message); }
  }
  if (env.AI) for (const m of MODELOS_CF) {
    try {
      const r = await env.AI.run(m, { messages, max_tokens: max, temperature: 0.3 });
      let t = typeof r?.response === "string" ? r.response : r?.response ? JSON.stringify(r.response) : r?.choices?.[0]?.message?.content || r?.output_text || "";
      t = String(t).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (t) return { texto: t, via: "cloudflare " + m.split("/").pop(), uso: usoDe(r?.usage) };
    } catch (e) { erros.push(m + ": " + String(e?.message || e).slice(0, 120)); }
  }
  if (env.OPENROUTER_KEY) for (const m of String(env.OPENROUTER_MODELOS || "nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free,nvidia/nemotron-3.5-super-vl:free").split(",")) {
    try { const t = await openai("https://openrouter.ai/api/v1/chat/completions", env.OPENROUTER_KEY, m.trim()); if (t) return { texto: t, via: "openrouter " + m.trim(), uso: ultUso }; } catch (e) { erros.push("openrouter " + m + ": " + e.message); }
  }
  console.log("IA reserva falhou:", erros.join(" | "));
  throw new Error("reservas indisponíveis agora");
}

// testa cada IA reserva com uma pergunta curta (só com o cabeçalho x-saude = SAUDE_CHAVE)
async function saudeIA(req, env) {
  const sc = String(env.SAUDE_CHAVE || "").replace(/^﻿/, "").trim();
  if (!sc || String(req.headers.get("x-saude") || "").trim() !== sc) return { erro: "proibido" };
  const pergunta = [{ role: "user", content: 'Onde são produzidos os glóbulos vermelhos no adulto? 0) coração 1) fígado 2) medula óssea 3) pulmões. Responda só JSON {"correta": índice}' }];
  const out = [];
  const testar = async (nome, url, chave, model) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: pergunta, max_tokens: 300, temperature: 0 }) });
      const d = await r.json().catch(() => ({}));
      out.push({ ia: nome + " " + model, ok: r.ok, ms: Date.now() - t0, resposta: r.ok ? String(d.choices?.[0]?.message?.content || "").slice(0, 60) : String(d.error?.message || r.status).slice(0, 120) });
    } catch (e) { out.push({ ia: nome + " " + model, ok: false, resposta: String(e.message).slice(0, 120) }); }
  };
  if (env.GROQ_KEY) for (const m of String(env.GROQ_MODELOS || "openai/gpt-oss-120b,openai/gpt-oss-20b").split(",")) await testar("groq", "https://api.groq.com/openai/v1/chat/completions", env.GROQ_KEY, m.trim());
  if (env.OPENROUTER_KEY) for (const m of String(env.OPENROUTER_MODELOS || "nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free,nvidia/nemotron-3.5-super-vl:free").split(",")) await testar("openrouter", "https://openrouter.ai/api/v1/chat/completions", env.OPENROUTER_KEY, m.trim());
  return { resultados: out };
}

/* ---------- Limite do Resumo em PDF ----------
   Conta os PEDIDOS à IA (inclusive tentativas) no site todo e por aluno. O dia é o da cota do Gemini (meia-noite da Califórnia).
   Guardado em pdfcota/{dia} e pdfcota/{dia}/alunos/{email} (só o servidor lê e grava). */
const PDF_SITE = 80, PDF_GRATIS = 1, PDF_PRO = 3, PDF_TENTATIVAS = 5; // 80 pedidos = 40 a 80 PDFs, dos 500 pedidos diários
const ADMIN_EMAIL = "cadutvx@gmail.com";
async function cotaPDF(env, email, acao) {
  const tok = await tokenGoogle(env), H = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
  const dia = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const docDia = `pdfcota/${dia}`, docAluno = `${docDia}/alunos/${email}`; // no commit o nome vai sem codificar
  const ler = async d => {
    const r = await fetch(`${DOCS(env)}/${d.split("/").map(encodeURIComponent).join("/")}`, { headers: H });
    if (r.status === 404) return {};
    if (!r.ok) throw new Error("não consegui ler o limite");
    return (await r.json()).fields || {};
  };
  // soma atômica: devolve os valores novos, então dois pedidos ao mesmo tempo não furam o limite
  const raiz = DOCS(env).replace("https://firestore.googleapis.com/v1/", "");
  const somar = async itens => {
    const r = await fetch(`${DOCS(env)}:commit`, { method: "POST", headers: H, body: JSON.stringify({ writes: itens.map(([d, campo]) => ({ transform: { document: `${raiz}/${d}`, fieldTransforms: [{ fieldPath: campo, increment: int(1) }] } })) }) });
    if (!r.ok) throw new Error("não consegui contar o limite: " + (await r.text()).slice(0, 120));
    return (await r.json()).writeResults.map(w => Number(w.transformResults?.[0]?.integerValue || 0));
  };
  const n = v => Number(v?.integerValue || 0);
  if (acao === "pronto") { await somar([[docAluno, "pdfs"]]); return { ok: true }; }
  if (acao !== "pedir") return { ok: false, motivo: "erro" };
  let limite = PDF_GRATIS;
  if (email === ADMIN_EMAIL) limite = PDF_PRO;
  else { const l = await ler(`liberados/${email}`); if (Object.keys(l).length && (!l.expira || n(l.expira) > Date.now())) limite = PDF_PRO; }
  const [a, d] = await Promise.all([ler(docAluno), ler(docDia)]);
  if (n(a.pdfs) >= limite) return { ok: false, motivo: "aluno" };
  if (n(a.pedidos) >= limite * PDF_TENTATIVAS) return { ok: false, motivo: "tentativas" };
  if (n(d.pedidos) >= PDF_SITE) return { ok: false, motivo: "site" };
  const [pa, pd] = await somar([[docAluno, "pedidos"], [docDia, "pedidos"]]);
  if (pa > limite * PDF_TENTATIVAS) return { ok: false, motivo: "tentativas" };
  if (pd > PDF_SITE) return { ok: false, motivo: "site" };
  return { ok: true, usados: pd, total: PDF_SITE };
}
