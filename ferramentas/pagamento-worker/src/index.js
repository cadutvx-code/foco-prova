// Hipocampo Study — pagamento automático do Pro (Pix pelo Mercado Pago, API de Orders)
// Rotas:  POST /criar   { idToken }            → cria um Pix de R$ PRECO para o e-mail da pessoa logada
//         POST /status  { idToken, id }        → confere no Mercado Pago; se pago, libera DIAS de Pro
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
  if (!r.ok) throw new Error(`Mercado Pago ${r.status}: ${(d.message || d.errors?.[0]?.message || t).toString().slice(0, 200)}`);
  return d;
}

async function criarPix(env, email) {
  const preco = Number(env.PRECO || "9.99").toFixed(2);
  const pedido = await mp(env, "/v1/orders", {
    method: "POST",
    headers: { "X-Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      type: "online", processing_mode: "automatic", total_amount: preco,
      external_reference: email,
      description: "Hipocampo Study Pro - 30 dias",
      payer: { email },
      transactions: { payments: [{ amount: preco, payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: "PT30M" }] }
    })
  });
  const pg = pedido.transactions?.payments?.[0]?.payment_method || {};
  return { id: pedido.id, status: pedido.status, qr_code: pg.qr_code, qr_code_base64: pg.qr_code_base64, ticket_url: pg.ticket_url, valor: preco };
}

const pago = p => p?.status === "processed" || p?.status_detail === "accredited" || p?.transactions?.payments?.[0]?.status === "processed";

async function conferir(env, id, emailPedido) {
  if (!id || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error("pedido inválido");
  const pedido = await mp(env, "/v1/orders/" + encodeURIComponent(id));
  const email = String(pedido.external_reference || "").toLowerCase();
  if (emailPedido && email !== emailPedido) throw new Error("este pagamento é de outra conta");
  if (!pago(pedido)) return { pago: false, status: pedido.status, detalhe: pedido.status_detail };
  const expira = await liberar(env, email, pedido.id);
  return { pago: true, expira };
}

// Aviso do Mercado Pago: não confia no conteúdo, só no id — e confere direto na API com o nosso token
async function webhook(req, env) {
  const corpo = await req.json().catch(() => ({}));
  const url = new URL(req.url);
  const id = corpo?.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id");
  if (id) { try { await conferir(env, String(id), null); } catch (e) { console.log("webhook", id, e.message); } }
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
