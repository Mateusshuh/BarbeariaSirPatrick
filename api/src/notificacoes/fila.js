// =============================================================================
// O trabalhador da fila
// =============================================================================
// A cada 30 segundos: pega até 20 avisos pendentes, tenta enviar, marca
// enviada — ou soma uma tentativa e guarda o erro. Depois de 5 tentativas,
// marca falhou e para de insistir.
//
// DEPENDÊNCIA NÃO ÓBVIA: este laço só roda com o serviço acordado. O plano
// gratuito do Render dorme depois de 15 minutos sem tráfego, e é o ping externo
// em /api/saude (a cada 10 minutos, descrito no DEPLOY.md) que mantém tudo de
// pé. Sem o ping, o aviso do pedido fica na fila até alguém abrir o site.
// =============================================================================

import { transacao, q, descreverErro } from "../db.js";
import { enviarPush, enviarEmail } from "./envio.js";
import { pushPatrick, pushCliente, emailCliente } from "./textos.js";

const INTERVALO_MS = 30_000;
const LOTE = 20;
const MAX_TENTATIVAS = 5;

let rodando = false;

export function iniciarFila() {
  if (process.env.FILA_DESLIGADA === "1") {
    console.log("[fila] desligada por variável de ambiente");
    return;
  }

  console.log("[fila] ligada, a cada 30s");
  // Uma passada logo no arranque: quando o Render reinicia o serviço, pode
  // haver aviso esperando desde antes.
  setTimeout(() => rodar().catch(registrar), 3_000);
  setInterval(() => rodar().catch(registrar), INTERVALO_MS).unref();
}

const registrar = (erro) => console.error("[fila]", descreverErro(erro));

async function rodar() {
  // Trava simples de reentrada: se uma passada demorar mais que o intervalo, a
  // próxima espera em vez de disputar as mesmas linhas.
  if (rodando) return;
  rodando = true;

  try {
    await transacao(async (cliente) => {
      // for update skip locked: se um dia existirem duas instâncias, cada uma
      // pega um lote diferente em vez de as duas mandarem o mesmo aviso.
      const { rows: fila } = await cliente.query(
        `select id, tipo, destino, tentativas, agendamento_id
           from notificacoes
          where status = 'pendente'
          order by criado_em
          limit ${LOTE}
          for update skip locked`
      );

      if (!fila.length) return;
      console.log(`[fila] ${fila.length} aviso(s) para enviar`);

      for (const aviso of fila) {
        try {
          await entregar(cliente, aviso);
          await cliente.query(
            "update notificacoes set status='enviada', enviada_em=now(), erro=null where id=$1",
            [aviso.id]
          );
        } catch (erro) {
          const tentativas = aviso.tentativas + 1;
          const desistiu = tentativas >= MAX_TENTATIVAS;

          await cliente.query(
            `update notificacoes
                set tentativas = $2, erro = $3, status = $4
              where id = $1`,
            [aviso.id, tentativas, descreverErro(erro).slice(0, 400),
             desistiu ? "falhou" : "pendente"]
          );

          console.error(`[fila] aviso ${aviso.id} falhou (${tentativas}/${MAX_TENTATIVAS}):`, descreverErro(erro));
        }
      }
    });
  } finally {
    rodando = false;
  }
}

// -----------------------------------------------------------------------------
// Entrega de um aviso
// -----------------------------------------------------------------------------
async function entregar(cliente, aviso) {
  const { rows } = await cliente.query(
    `select a.id, a.nome, a.telefone, a.status, a.motivo_recusa, a.cliente_id,
            lower(a.periodo) as inicio, s.nome as servico
       from agendamentos a
       join servicos s on s.id = a.servico_id
      where a.id = $1`,
    [aviso.agendamento_id]
  );

  const agendamento = rows[0];
  if (!agendamento) throw new Error("agendamento sumiu");

  if (aviso.destino === "patrick") return entregarAoPatrick(cliente, aviso, agendamento);
  return entregarAoCliente(cliente, agendamento);
}

async function entregarAoPatrick(cliente, aviso, agendamento) {
  const { rows: admins } = await cliente.query("select id from perfis where papel = 'admin'");
  if (!admins.length) throw new Error("nenhum admin cadastrado");

  const entregues = await enviarPush(admins.map((a) => a.id), pushPatrick(aviso.tipo, agendamento));

  // Zero aparelhos é um estado de verdade, não um erro de rede: ou ele ainda
  // não autorizou, ou está no iPhone sem o painel na tela de início. Repetir
  // não resolve — o registro fica na tabela dizendo o que aconteceu.
  if (entregues === 0) throw new Error("nenhum aparelho assinado para o Patrick");
}

async function entregarAoCliente(cliente, agendamento) {
  if (!agendamento.cliente_id) return;          // encaixe não tem conta

  const modelo = emailCliente(agendamento);
  if (!modelo) return;                          // status que não merece aviso

  // O e-mail vem de auth.users: a API conecta como dona do banco e lê o schema
  // do Auth direto, sem precisar da API administrativa do Supabase.
  const { rows } = await cliente.query("select email from auth.users where id = $1",
    [agendamento.cliente_id]);
  const email = rows[0]?.email;

  let entregou = false;

  if (email) {
    await enviarEmail(email, modelo);
    entregou = true;
  }

  // Push é bônus: se falhar, não invalida o aviso que já saiu por e-mail.
  try {
    await enviarPush([agendamento.cliente_id], pushCliente(agendamento));
  } catch (erro) {
    console.error("[fila] push do cliente falhou (e-mail já saiu):", erro.message);
  }

  if (!entregou) throw new Error("cliente sem e-mail cadastrado");
}

/** Usado pelo /api/saude em modo detalhado e por depuração manual. */
export async function resumoDaFila() {
  const { rows } = await q(
    `select status, count(*)::int as n from notificacoes group by status`
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
