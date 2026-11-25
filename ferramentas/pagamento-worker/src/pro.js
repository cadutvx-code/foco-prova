// Regras do Pro (liberar, reembolso, preço de fundador e limite da IA reserva). Sem rede aqui dentro: recebe o banco pronto, para dar para testar.
const DIA = 86400000;
export const LIMITE_IA = { gratis: 60, pro: 250 }; // pedidos à IA reserva por pessoa e por dia (1 lote de perguntas = 2 pedidos: criar + conferir)

// Lê, calcula e grava só se ninguém mudou no meio do caminho. Falha de leitura = erro (NUNCA trata como cadastro novo).
async function mudar(db, caminho, fn) {
  for (let i = 0; ; i++) {
    const x = await db.ler(caminho);
    const r = fn(x?.dados || null);
    if (!r.campos) return r.valor;
    try { await db.gravar([{ caminho, dados: r.campos, campos: Object.keys(r.campos), versao: x?.versao || null }]); return r.valor; }
    catch (e) { if (!e.conflito || i >= 5) throw e; await new Promise(ok => setTimeout(ok, 30 + Math.random() * 120)); }
  }
}
const fimDe = d => d ? Number(d.expira) || (Number(d.data) ? Number(d.data) + 30 * DIA : 0) : 0;

export function liberarPro(db, email, pedidoId, { nota, dias = 30, preco = 9.99, agora = Date.now() }) {
  return mudar(db, "liberados/" + email, d => {
    const pagos = d?.pedidosPagos || [], fim = fimDe(d);
    if (pagos.includes(pedidoId)) return { valor: fim }; // esse pagamento já foi contado
    const expira = Math.max(agora, fim) + dias * DIA;
    return { valor: expira, campos: {
      inicio: d?.inicio || d?.data || agora, data: agora, expira, renovacoes: (d?.renovacoes || 0) + (d ? 1 : 0), nota, por: "pagamento automático",
      precoFundador: d?.precoFundador || preco, fundadorDesde: d?.fundadorDesde || agora, pedidosPagos: [...pagos.slice(-199), pedidoId]
    } };
  });
}
// Pagamento devolvido: tira os dias dele, uma vez só. Pagamento que nunca foi contado não muda nada.
export function estornarPro(db, email, pedidoId, { dias = 30, agora = Date.now() } = {}) {
  return mudar(db, "liberados/" + email, d => {
    if (!d || !(d.pedidosPagos || []).includes(pedidoId) || (d.estornados || []).includes(pedidoId)) return { valor: false };
    return { valor: true, campos: { expira: fimDe(d) - dias * DIA, estornados: [...(d.estornados || []).slice(-199), pedidoId], ultimoEstorno: agora } };
  });
}
// Quem já pagou continua no preço de quando entrou (nunca paga mais que o preço atual)
export async function precoDe(db, email, preco) {
  const f = Number((await db.ler("liberados/" + email))?.dados.precoFundador) || 0;
  return Math.round((f > 0 && f < preco ? f : preco) * 100) / 100;
}
// Conta o pedido e diz se a pessoa ainda pode usar a IA reserva hoje
export async function podeIA(db, email, admin, agora = Date.now()) {
  if (admin) return true;
  const n = await db.somar(`iareserva/${new Date(agora).toISOString().slice(0, 10)}/alunos/${email}`, "n");
  if (n <= LIMITE_IA.gratis) return true;
  if (n > LIMITE_IA.pro) return false;
  return fimDe((await db.ler("liberados/" + email))?.dados) > agora;
}
