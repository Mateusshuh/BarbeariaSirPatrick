// =============================================================================
// Rotas sem conta e rotas de leitura com conta
// =============================================================================

import { Router } from "express";
import { q, configuracoes } from "../db.js";
import { exigeCliente } from "../auth.js";

export const publicas = Router();

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------
// É o que o Render usa para saber se o serviço subiu, e é o que o ping externo
// bate a cada 10 minutos para ele não dormir. Não toca no banco de propósito:
// se o Supabase estiver fora do ar, o serviço continua vivo, e o ping precisa
// continuar funcionando justamente aí.
publicas.get("/saude", (_req, res) => {
  res.json({ ok: true, agora: new Date().toISOString() });
});

// Não existe /api/vitrine: por decisão de projeto o site institucional não
// mostra horário para quem não tem conta. Se um dia mostrar, o endpoint nasce
// aqui, chamando proximos_horarios_publicos() e guardando 60s em memória.

// -----------------------------------------------------------------------------
// Com conta
// -----------------------------------------------------------------------------
publicas.get("/servicos", exigeCliente, async (_req, res, next) => {
  try {
    const { rows } = await q(
      `select id, nome, duracao_min, preco_centavos
         from servicos where ativo order by ordem, nome`
    );
    res.json(rows);
  } catch (erro) { next(erro); }
});

// O expediente vai junto porque a tela do cliente precisa dele para desenhar a
// grade teórica do dia — e para saber onde entra a linha do almoço.
publicas.get("/expediente", exigeCliente, async (_req, res, next) => {
  try {
    const { rows } = await q(
      `select dia_semana, abre, fecha, intervalo_inicio, intervalo_fim
         from expediente where aberto order by dia_semana`
    );
    res.json(rows);
  } catch (erro) { next(erro); }
});

// Só as configurações que a tela precisa saber. As outras (ação ao expirar,
// limite de cancelamentos) são regra interna e não ajudam em nada no navegador.
publicas.get("/configuracoes-publicas", exigeCliente, async (_req, res, next) => {
  try {
    const cfg = await configuracoes();
    res.json({
      prazo_resposta_h: Number(cfg.prazo_resposta_h || 12),
      antecedencia_min_min: Number(cfg.antecedencia_min_min || 60),
      janela_dias: Number(cfg.janela_dias || 30),
      passo_grade_min: Number(cfg.passo_grade_min || 30),
      cancelamento_min: Number(cfg.cancelamento_min || 120),
      exige_email_verificado: String(cfg.exige_email_verificado || "sim").toLowerCase() === "sim"
    });
  } catch (erro) { next(erro); }
});

// Quem sou eu, segundo o banco. O painel usa para saber se mostra o link de
// admin; o cliente, para preencher nome e telefone sem formulário.
publicas.get("/eu", exigeCliente, async (req, res, next) => {
  try {
    const { rows } = await q(
      "select id, nome, telefone, papel from perfis where id = $1",
      [req.usuario.id]
    );

    if (!rows[0]) {
      // Rede de segurança: se o gatilho do cadastro não tiver rodado, a pessoa
      // ficaria sem perfil e sem conseguir agendar, sem saída pela tela.
      const { rows: criado } = await q(
        `insert into perfis (id, nome, telefone, papel)
         values ($1, $2, '', 'cliente')
         on conflict (id) do nothing
         returning id, nome, telefone, papel`,
        [req.usuario.id, (req.usuario.email || "cliente").split("@")[0]]
      );
      return res.json({ ...criado[0], email: req.usuario.email, email_confirmado: req.usuario.emailConfirmado });
    }

    res.json({ ...rows[0], email: req.usuario.email, email_confirmado: req.usuario.emailConfirmado });
  } catch (erro) { next(erro); }
});

publicas.put("/eu", exigeCliente, async (req, res, next) => {
  try {
    const nome = String(req.body?.nome ?? "").trim();
    const telefone = String(req.body?.telefone ?? "").trim();

    if (nome.length < 2) return res.status(400).json({ erro: "NOME_CURTO" });
    if (telefone.replace(/\D/g, "").length < 10) return res.status(400).json({ erro: "TELEFONE_INVALIDO" });

    // O papel fica fora do update de propósito: nenhum endpoint concede admin.
    const { rows } = await q(
      `update perfis set nome = $2, telefone = $3 where id = $1
       returning id, nome, telefone, papel`,
      [req.usuario.id, nome, telefone]
    );
    res.json(rows[0]);
  } catch (erro) { next(erro); }
});
