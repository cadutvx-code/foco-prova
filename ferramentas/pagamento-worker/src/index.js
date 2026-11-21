// Hipocampo Study — pagamento automático do Pro (Pix pelo Mercado Pago, API de Orders)
// Rotas:  POST /criar   { idToken }            → cria um Pix de R$ PRECO para o e-mail da pessoa logada
//         POST /status  { idToken, id }        → confere no Mercado Pago; se pago, libera DIAS de Pro
//         POST /cartao  { idToken }            → cria um link do Checkout do Mercado Pago (cartão) para o e-mail logado
//         POST /status-cartao { idToken }      → procura pagamento aprovado desse e-mail feito pelo checkout; se achar, libera
//         POST /webhook (aviso do Mercado Pago) → confere o pedido e libera
// Segredos (wrangler secret put): MP_TOKEN (Access Token do Mercado Pago), SA_JSON (chave da conta de serviço do Firebase)

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
      const corpo = await req.json().catch(() => ({}));
      const email = await emailDoLogin(env, corpo.idToken);
      if (!email) return json(req, { erro: "faça login com o Google de novo" }, 401);
      if (rota === "/criar") return json(req, await criarPix(env, email));
      if (rota === "/status") return json(req, await conferir(env, corpo.id, email));
      if (rota === "/cartao") return json(req, await criarCheckout(env, email));
      if (rota === "/status-cartao") return json(req, await conferirCheckout(env, email));
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
  const id = bruto ? (/payment/i.test(tipo) || /^\d+$/.test(String(bruto)) ? "pay_" + bruto : String(bruto)) : null;
  if (id) { try { await conferir(env, id, null); } catch (e) { console.log("webhook", id, e.message); } }
  return new Response("ok", { status: 200 });
}

/* ---------- Firebase (Firestore pela API REST, com a conta de serviço) ---------- */
let tokenCache = { valor: "", ate: 0 };
async function tokenGoogle(env) {
  if (tokenCache.valor && Date.now() < tokenCache.ate) return tokenCache.valor;
  const sa = JSON.parse(env.SA_JSON);
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

async function liberar(env, email, pedidoId) {
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
    nota: txt("pago pelo Pix (automático)"), por: txt("pagamento automático"),
    pedidosPagos: { arrayValue: { values: [...pagos.slice(-30), pedidoId].map(txt) } }
  };
  const w = await fetch(url, { method: "PATCH", headers: H, body: JSON.stringify({ fields: campos }) });
  if (!w.ok) throw new Error("não consegui gravar o Pro: " + (await w.text()).slice(0, 150));
  await fetch(`${DOCS(env)}/solicitacoes/${encodeURIComponent(email)}`, { method: "DELETE", headers: H }).catch(() => {});
  return expira;
}
