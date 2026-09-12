// =============================================================================
// Rotas do Patrick
// =============================================================================
// Tudo aqui passa por exigeAdmin, que lê o papel da tabela perfis a cada
// chamada. Nenhum campo vindo do navegador decide isso.
//
// Confirmar, recusar, concluir e cancelar seguem sempre o mesmo formato: a
// condição vai no WHERE do update e o resultado é medido pelas linhas
// devolvidas. Zero linha significa que outra pessoa (ou a rotina de expiração)
// chegou primeiro — e aí a resposta é 409, não um erro genérico.
// =============================================================================

import { Router } from "express";
import { z } from "zod";
import { q, uma, configuracoes } from "../db.js";
import { exigeAdmin } from "../auth.js";

export const admin = Router();
admin.use(exigeAdmin);

const CAMPOS = `a.id, a.nome, a.telefone, a.status, a.origem, a.motivo_recusa,
                a.observacao, a.criado_em, a.respondido_em,
                lower(a.periodo) as inicio, upper(a.periodo) as fim,
                s.nome as servico, s.duracao_min, s.preco_centavos`;

// -----------------------------------------------------------------------------
// Listas
// -----------------------------------------------------------------------------
admin.get("/pedidos", async (req, res, next) => {
  try {
    const status = String(req.query.status || "pendente");
    const { rows } = await q(
      `select ${CAMPOS} from agendamentos a
         join servicos s on s.id = a.servico_id
        where a.status = $1
        order by lower(a.periodo)`,
      [status]
    );
    res.json(rows);
  } catch (erro) { next(erro); }
});

admin.get("/dia", async (req, res, next) => {
  try {
    const data = String(req.query.data || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ erro: "DATA_INVALIDA" });

    const [agenda, bloqueios] = await Promise.all([
      q(`select ${CAMPOS} from agendamentos a
           join servicos s on s.id = a.servico_id
          where a.dia = $1 order by lower(a.periodo)`, [data]),
      q(`select id, inicio, fim, motivo from bloqueios
          where inicio < ($1::date + 1) and fim > $1::date order by inicio`, [data])
    ]);

    res.json({ agenda: agenda.rows, bloqueios: bloqueios.rows });
  } catch (erro) { next(erro); }
});

// -----------------------------------------------------------------------------
// Responder um pedido
// -----------------------------------------------------------------------------
async function mudarStatus(res, next, { id, de, para, motivo = null }) {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ erro: "DADOS_INVALIDOS" });

    const { rows } = await q(
      `update agendamentos
          set status = $2, respondido_em = now(),
              motivo_recusa = coalesce($4, motivo_recusa)
        where id = $1 and status = any($3)
        returning id, status, lower(periodo) as inicio`,
      [id, para, de, motivo]
    );

    if (!rows[0]) {
      const atual = await uma("select status from agendamentos where id = $1", [id]);
      if (!atual) return res.status(404).json({ erro: "NAO_ENCONTRADO" });
      return res.status(409).json({ erro: "JA_RESPONDIDO", status: atual.status });
    }

    res.json(rows[0]);
  } catch (erro) { next(erro); }
}

admin.post("/pedidos/:id/confirmar", (req, res, next) =>
  mudarStatus(res, next, { id: req.params.id, de: ["pendente"], para: "confirmado" }));

admin.post("/pedidos/:id/recusar", (req, res, next) =>
  mudarStatus(res, next, {
    id: req.params.id, de: ["pendente"], para: "recusado",
    motivo: String(req.body?.motivo || "").trim().slice(0, 200) || null
  }));

admin.post("/pedidos/:id/concluir", (req, res, next) =>
  mudarStatus(res, next, { id: req.params.id, de: ["confirmado"], para: "concluido" }));

admin.post("/pedidos/:id/nao-compareceu", (req, res, next) =>
  mudarStatus(res, next, { id: req.params.id, de: ["confirmado"], para: "nao_compareceu" }));

admin.post("/pedidos/:id/cancelar", (req, res, next) =>
  mudarStatus(res, next, {
    id: req.params.id, de: ["pendente", "confirmado"], para: "cancelado",
    motivo: String(req.body?.motivo || "").trim().slice(0, 200) || null
  }));

// Remarcar: o novo fim é sempre recalculado pela duração do serviço. Se o
// horário novo bater com outro, a trava do banco recusa — e é isso que a gente
// devolve, sem inventar checagem paralela.
admin.post("/pedidos/:id/remarcar", async (req, res, next) => {
  try {
    const corpo = z.object({ inicio: z.string().datetime({ offset: true }) }).safeParse(req.body);
    if (!corpo.success) return res.status(400).json({ erro: "DADOS_INVALIDOS" });

    const { rows } = await q(
      `update agendamentos a
          set periodo = tstzrange($2::timestamptz,
                                  $2::timestamptz + make_interval(mins => s.duracao_min), '[)')
         from servicos s
        where s.id = a.servico_id
          and a.id = $1
          and a.status in ('pendente','confirmado')
        returning a.id, lower(a.periodo) as inicio, upper(a.periodo) as fim`,
      [req.params.id, corpo.data.inicio]
    );

    if (!rows[0]) return res.status(409).json({ erro: "NAO_PODE_REMARCAR" });
    res.json(rows[0]);
  } catch (erro) {
    if (erro.code === "23P01") return res.status(409).json({ erro: "HORARIO_OCUPADO" });
    if (erro.code === "23505") return res.status(409).json({ erro: "JA_TEM_NO_DIA" });
    next(erro);
  }
});

// -----------------------------------------------------------------------------
// Encaixe
// -----------------------------------------------------------------------------
// Cliente que chegou sem marcar. Sem isso o sistema descola da realidade da
// loja: o horário aparece livre no site enquanto tem gente na cadeira.
admin.post("/encaixe", async (req, res, next) => {
  try {
    const corpo = z.object({
      nome: z.string().trim().min(2).max(80),
      servico_id: z.string().uuid(),
      inicio: z.string().datetime({ offset: true }),
      telefone: z.string().trim().max(30).optional()
    }).safeParse(req.body);

    if (!corpo.success) return res.status(400).json({ erro: "DADOS_INVALIDOS" });

    const linha = await uma(
      `insert into agendamentos (nome, telefone, servico_id, periodo, origem, status)
       select $1, $4, s.id,
              tstzrange($3::timestamptz,
                        $3::timestamptz + make_interval(mins => s.duracao_min), '[)'),
              'encaixe', 'confirmado'
         from servicos s where s.id = $2
       returning id, lower(periodo) as inicio, upper(periodo) as fim`,
      [corpo.data.nome, corpo.data.servico_id, corpo.data.inicio, corpo.data.telefone || ""]
    );

    if (!linha) return res.status(400).json({ erro: "SERVICO_INVALIDO" });
    res.status(201).json(linha);
  } catch (erro) {
    if (erro.code === "23P01") return res.status(409).json({ erro: "HORARIO_OCUPADO" });
    next(erro);
  }
});

// -----------------------------------------------------------------------------
// Bloqueios
// -----------------------------------------------------------------------------
admin.post("/bloqueios", async (req, res, next) => {
  try {
    const corpo = z.object({
      inicio: z.string().datetime({ offset: true }),
      fim: z.string().datetime({ offset: true }),
      motivo: z.string().trim().max(120).optional(),
      // O painel manda true na segunda tentativa, depois de mostrar quem está
      // marcado dentro do período.
      confirmar: z.boolean().optional()
    }).safeParse(req.body);

    if (!corpo.success) return res.status(400).json({ erro: "DADOS_INVALIDOS" });
    const { inicio, fim, motivo, confirmar } = corpo.data;

    if (new Date(fim) <= new Date(inicio)) return res.status(400).json({ erro: "PERIODO_INVALIDO" });

    if (!confirmar) {
      // Bloquear por cima de gente marcada é como o sistema perde a confiança
      // do dono. Avisar antes custa uma consulta.
      const { rows } = await q(
        `select a.id, a.nome, lower(a.periodo) as inicio, a.status
           from agendamentos a
          where a.status in ('pendente','confirmado')
            and a.periodo && tstzrange($1::timestamptz, $2::timestamptz, '[)')
          order by lower(a.periodo)`,
        [inicio, fim]
      );
      if (rows.length) return res.status(409).json({ erro: "CONFLITO", conflitos: rows });
    }

    const linha = await uma(
      `insert into bloqueios (inicio, fim, motivo) values ($1, $2, $3)
       returning id, inicio, fim, motivo`,
      [inicio, fim, motivo || null]
    );
    res.status(201).json(linha);
  } catch (erro) { next(erro); }
});

admin.delete("/bloqueios/:id", async (req, res, next) => {
  try {
    const { rowCount } = await q("delete from bloqueios where id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ erro: "NAO_ENCONTRADO" });
    res.json({ ok: true });
  } catch (erro) { next(erro); }
});

// -----------------------------------------------------------------------------
// Configurações
// -----------------------------------------------------------------------------
admin.get("/servicos", async (_req, res, next) => {
  try {
    const { rows } = await q(
      "select id, nome, duracao_min, preco_centavos, ativo, ordem from servicos order by ordem, nome"
    );
    res.json(rows);
  } catch (erro) { next(erro); }
});

const Servico = z.object({
  nome: z.string().trim().min(2).max(60),
  duracao_min: z.number().int().min(5).max(480),
  preco_centavos: z.number().int().min(0).max(10_000_00),
  ordem: z.number().int().min(0).max(999),
  ativo: z.boolean()
});

admin.post("/servicos", async (req, res, next) => {
  try {
    const corpo = Servico.safeParse(req.body);
    if (!corpo.success) return res.status(400).json({ erro: "DADOS_INVALIDOS" });
    const { nome, duracao_min, preco_centavos, ordem, ativo } = corpo.data;

    const linha = await uma(
      `insert into servicos (nome, duracao_min, preco_centavos, ordem, ativo)
       values ($1,$2,$3,$4,$5) returning *`,
      [nome, duracao_min, preco_centavos, ordem, ativo]
    );
    res.status(201).json(linha);
  } catch (erro) { next(erro); }
});

admin.put("/servicos/:id", async (req, res, next) => {
  try {
    const corpo = Servico.safeParse(req.body);
    if (!corpo.success) return res.status(400).json({ erro: "DADOS_INVALIDOS" });
    const { nome, duracao_min, preco_centavos, ordem, ativo } = corpo.data;

    const linha = await uma(
      `update servicos set nome=$2, duracao_min=$3, preco_centavos=$4, ordem=$5, ativo=$6
        where id=$1 returning *`,
      [req.params.id, nome, duracao_min, preco_centavos, ordem, ativo]
    );
    if (!linha) return res.status(404).json({ erro: "NAO_ENCONTRADO" });
    res.json(linha);
  } catch (erro) { next(erro); }
});

admin.get("/expediente", async (_req, res, next) => {
  try {
    const { rows } = await q("select * from expediente order by dia_semana");
    res.json(rows);
  } catch (erro) { next(erro); }
});

admin.put("/expediente/:dia", async (req, res, next) => {
  try {
    const dia = Number(req.params.dia);
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
      return res.status(400).json({ erro: "DIA_INVALIDO" });
    }

    const hora = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
    const corpo = z.object({
      aberto: z.boolean(),
      abre: hora,
      fecha: hora,
      intervalo_inicio: hora.nullable().optional(),
      intervalo_fim: hora.nullable().optional()
    }).safeParse(req.body);

    if (!corpo.success) return res.status(400).json({ erro: "DADOS_INVALIDOS" });
    const { aberto, abre, fecha } = corpo.data;

    // As duas colunas do almoço andam juntas: uma preenchida e a outra vazia é
    // recusado pelo banco, então normalizamos antes de tentar.
    const temAlmoco = Boolean(corpo.data.intervalo_inicio && corpo.data.intervalo_fim);
    const ini = temAlmoco ? corpo.data.intervalo_inicio : null;
    const fim = temAlmoco ? corpo.data.intervalo_fim : null;

    if (fecha <= abre) return res.status(400).json({ erro: "HORARIO_INVALIDO" });

    const linha = await uma(
      `insert into expediente (dia_semana, abre, fecha, intervalo_inicio, intervalo_fim, aberto)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (dia_semana) do update
          set abre=excluded.abre, fecha=excluded.fecha,
              intervalo_inicio=excluded.intervalo_inicio,
              intervalo_fim=excluded.intervalo_fim,
              aberto=excluded.aberto
       returning *`,
      [dia, abre, fecha, ini, fim, aberto]
    );
    res.json(linha);
  } catch (erro) {
    if (erro.code === "23514") return res.status(400).json({ erro: "HORARIO_INVALIDO" });
    next(erro);
  }
});

admin.get("/configuracoes", async (_req, res, next) => {
  try {
    const { rows } = await q("select chave, valor, descricao from configuracoes order by chave");
    res.json(rows);
  } catch (erro) { next(erro); }
});

// Lista fechada: chave desconhecida não entra. A tabela aceita qualquer coisa,
// mas o que não tem interface nem leitor é lixo esperando para confundir.
const CHAVES = new Set([
  "antecedencia_min_min", "janela_dias", "passo_grade_min", "prazo_resposta_h",
  "acao_ao_expirar", "cancelamento_min", "max_cancelamentos_mes", "exige_email_verificado"
]);

admin.put("/configuracoes", async (req, res, next) => {
  try {
    const entradas = Object.entries(req.body || {})
      .filter(([chave]) => CHAVES.has(chave));

    if (!entradas.length) return res.status(400).json({ erro: "DADOS_INVALIDOS" });

    for (const [chave, valor] of entradas) {
      await q(
        `insert into configuracoes (chave, valor, atualizado_em) values ($1, $2, now())
         on conflict (chave) do update set valor = excluded.valor, atualizado_em = now()`,
        [chave, String(valor).trim().slice(0, 40)]
      );
    }

    res.json(await configuracoes());
  } catch (erro) { next(erro); }
});
