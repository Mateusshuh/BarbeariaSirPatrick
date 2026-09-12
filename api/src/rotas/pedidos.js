// =============================================================================
// Rotas do cliente
// =============================================================================
// O endpoint mais delicado do sistema está aqui: POST /api/pedidos.
//
// Duas regras que valem para tudo neste arquivo:
//   - o horário final é calculado no servidor, a partir da duração do serviço.
//     O navegador manda só o início; se mandasse o fim, mandaria a duração.
//   - condição de corrida se resolve no WHERE do update, nunca lendo antes e
//     escrevendo depois.
// =============================================================================

import { Router } from "express";
import { z } from "zod";
import { q, uma, transacao, configuracoes } from "../db.js";
import { exigeCliente } from "../auth.js";

export const pedidos = Router();

const PedidoNovo = z.object({
  servico_id: z.string().uuid(),
  // Com deslocamento obrigatório: "2026-09-12T14:30:00-03:00". Data sem fuso é
  // ambígua, e ambiguidade aqui vira horário errado na agenda.
  inicio: z.string().datetime({ offset: true })
});

// -----------------------------------------------------------------------------
// Pedir um horário
// -----------------------------------------------------------------------------
pedidos.post("/pedidos", exigeCliente, async (req, res, next) => {
  try {
    const corpo = PedidoNovo.safeParse(req.body);
    if (!corpo.success) return res.status(400).json({ erro: "DADOS_INVALIDOS" });

    const { servico_id, inicio } = corpo.data;
    const quando = new Date(inicio);
    const cfg = await configuracoes();

    const servico = await uma(
      "select id, nome, duracao_min from servicos where id = $1 and ativo",
      [servico_id]
    );
    if (!servico) return res.status(400).json({ erro: "SERVICO_INVALIDO" });

    // E-mail não confirmado: a conta existe, mas não dá para avisar essa pessoa
    // de nada. Agendamento sem canal de resposta é horário que vira falta.
    if (String(cfg.exige_email_verificado || "sim").toLowerCase() === "sim"
        && !req.usuario.emailConfirmado) {
      return res.status(403).json({ erro: "EMAIL_NAO_CONFIRMADO" });
    }

    const antecedencia = Number(cfg.antecedencia_min_min || 60);
    const janela = Number(cfg.janela_dias || 30);

    if (quando.getTime() < Date.now() + antecedencia * 60_000) {
      return res.status(400).json({ erro: "ANTECEDENCIA", minutos: antecedencia });
    }
    if (quando.getTime() > Date.now() + janela * 86_400_000) {
      return res.status(400).json({ erro: "FORA_DA_JANELA", dias: janela });
    }

    // A palavra final sobre o que existe na grade é do banco: expediente,
    // almoço, bloqueios e colisões estão todos dentro desta função, e repetir
    // essa conta aqui seria manter duas versões da mesma regra.
    const existe = await uma(
      `select 1 from horarios_disponiveis(
                 ($2::timestamptz at time zone 'America/Sao_Paulo')::date, $1) h
        where h = $2::timestamptz`,
      [servico_id, inicio]
    );
    if (!existe) return res.status(409).json({ erro: "HORARIO_INDISPONIVEL" });

    // Nome e telefone são copiados do perfil no momento do pedido: o painel
    // lista a agenda sem junção, e o histórico não muda se o cliente editar o
    // cadastro depois.
    const linha = await uma(
      `insert into agendamentos (cliente_id, nome, telefone, servico_id, periodo)
       select p.id, p.nome, p.telefone, s.id,
              tstzrange($3::timestamptz,
                        $3::timestamptz + make_interval(mins => s.duracao_min), '[)')
         from perfis p, servicos s
        where p.id = $1 and s.id = $2
       returning id, status, lower(periodo) as inicio, upper(periodo) as fim`,
      [req.usuario.id, servico_id, inicio]
    );

    if (!linha) return res.status(400).json({ erro: "PERFIL_INCOMPLETO" });

    res.status(201).json({ ...linha, servico: servico.nome });
  } catch (erro) {
    // As duas travas do banco. O texto cru do Postgres não sai daqui: o front
    // transforma o código numa frase que diz o que fazer em seguida.
    if (erro.code === "23P01") return res.status(409).json({ erro: "HORARIO_OCUPADO" });
    if (erro.code === "23505") return res.status(409).json({ erro: "JA_TEM_NO_DIA" });
    next(erro);
  }
});

// -----------------------------------------------------------------------------
// Meus pedidos
// -----------------------------------------------------------------------------
pedidos.get("/meus-pedidos", exigeCliente, async (req, res, next) => {
  try {
    const { rows } = await q(
      `select a.id, a.status, a.motivo_recusa, a.criado_em,
              lower(a.periodo) as inicio, upper(a.periodo) as fim,
              s.nome as servico, s.preco_centavos
         from agendamentos a
         join servicos s on s.id = a.servico_id
        where a.cliente_id = $1
        order by lower(a.periodo) desc
        limit 60`,
      [req.usuario.id]
    );

    const agora = Date.now();
    const ativo = (p) => ["pendente", "confirmado"].includes(p.status);

    res.json({
      proximos: rows.filter((p) => ativo(p) && new Date(p.fim).getTime() > agora)
                    .sort((a, b) => new Date(a.inicio) - new Date(b.inicio)),
      historico: rows.filter((p) => !(ativo(p) && new Date(p.fim).getTime() > agora))
    });
  } catch (erro) { next(erro); }
});

// -----------------------------------------------------------------------------
// Cancelar
// -----------------------------------------------------------------------------
pedidos.post("/pedidos/:id/cancelar", exigeCliente, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ erro: "DADOS_INVALIDOS" });

    const cfg = await configuracoes();
    const prazo = Number(cfg.cancelamento_min || 120);
    const maximo = Number(cfg.max_cancelamentos_mes || 0);

    if (maximo > 0) {
      const { rows } = await q(
        `select count(*)::int as n from agendamentos
          where cliente_id = $1 and status = 'cancelado'
            and coalesce(respondido_em, criado_em) >= date_trunc('month', now())`,
        [req.usuario.id]
      );
      if (rows[0].n >= maximo) {
        return res.status(409).json({ erro: "LIMITE_CANCELAMENTOS", maximo });
      }
    }

    const resultado = await transacao(async (cliente) => {
      // A condição inteira vai no WHERE. Ler antes e escrever depois deixaria
      // uma fresta entre as duas coisas — e é nessa fresta que dois toques
      // seguidos viram dois cancelamentos, ou que um horário já confirmado pelo
      // Patrick é cancelado fora do prazo.
      //
      // Pendente pode ser retirado a qualquer momento: ninguém se organizou em
      // cima dele ainda, e segurá-lo só prende um horário que o Patrick daria a
      // outra pessoa. O prazo vale para o que já foi confirmado.
      const { rows } = await cliente.query(
        `update agendamentos
            set status = 'cancelado', respondido_em = now()
          where id = $1
            and cliente_id = $2
            and status in ('pendente','confirmado')
            and upper(periodo) > now()
            and (status = 'pendente'
                 or lower(periodo) > now() + make_interval(mins => $3))
          returning id, status, lower(periodo) as inicio,
                    (select nome from servicos where id = servico_id) as servico`,
        [id, req.usuario.id, prazo]
      );

      if (!rows[0]) return null;

      // O gatilho já avisou o cliente. Este aviso é o outro lado: um horário
      // confirmado que vagou é informação que muda o dia do Patrick.
      await cliente.query(
        `insert into notificacoes (tipo, agendamento_id, destino)
         values ('resposta', $1, 'patrick')`,
        [id]
      );

      return rows[0];
    });

    if (resultado) return res.json(resultado);

    // Não deu: descobrir por quê é uma leitura sem pressa, porque a decisão de
    // escrever já foi tomada (e recusada) lá em cima.
    const atual = await uma(
      `select status, lower(periodo) as inicio from agendamentos
        where id = $1 and cliente_id = $2`,
      [id, req.usuario.id]
    );

    if (!atual) return res.status(404).json({ erro: "NAO_ENCONTRADO" });
    if (!["pendente", "confirmado"].includes(atual.status)) {
      return res.status(409).json({ erro: "JA_RESPONDIDO", status: atual.status });
    }
    return res.status(409).json({ erro: "FORA_DO_PRAZO", minutos: prazo });
  } catch (erro) { next(erro); }
});
