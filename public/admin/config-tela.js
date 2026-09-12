// =============================================================================
// Configurações do painel
// =============================================================================
// Serviços, expediente e as regras da agenda. O arquivo se chama config-tela.js
// para não se confundir com shared/config.js, que guarda as chaves do projeto.
// =============================================================================

import { supabase, mensagemDeErro } from "/shared/supabase.js";
import { api, mensagemDaApi, acordarApi, avisarDemora } from "/shared/api.js";
import { exigirSessao, sair, tratarSessaoMorta } from "/shared/sessao.js";
import { $, $$, escapar, aviso, limparAviso, ocupado, montarTopo } from "/shared/ui.js";

const { perfil } = await exigirSessao({ admin: true });
montarTopo($("#topo"), perfil, { admin: true });
$("#topo").addEventListener("click", (e) => {
  if (e.target.matches("[data-sair]")) { e.preventDefault(); sair(); }
});

acordarApi();

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// As regras que aparecem na tela, com o texto que explica cada uma. A tabela
// configuracoes aceita qualquer chave; aqui está a lista que tem interface.
const REGRAS = [
  ["antecedencia_min_min", "Antecedência mínima", "minutos", "number",
    "Quanto tempo antes do corte o cliente ainda consegue marcar."],
  ["janela_dias", "Janela de agendamento", "dias", "number",
    "Até quantos dias à frente a agenda abre."],
  ["passo_grade_min", "Passo da grade", "minutos", "number",
    "De quantos em quantos minutos começa um horário. 30 é o comum."],
  ["prazo_resposta_h", "Prazo para responder", "horas", "number",
    "Quanto tempo você tem para confirmar ou recusar um pedido."],
  ["acao_ao_expirar", "Se o prazo vencer", "", "select",
    "O que o sistema faz sozinho quando você não responde a tempo."],
  ["cancelamento_min", "Cancelamento até", "minutos antes", "number",
    "Até quando o cliente pode cancelar um horário já confirmado."],
  ["max_cancelamentos_mes", "Cancelamentos por mês", "por cliente", "number",
    "Quantas vezes o mesmo cliente pode cancelar no mês. 0 tira o limite."],
  ["exige_email_verificado", "Exigir e-mail confirmado", "", "simnao",
    "Só deixa pedir horário quem confirmou o e-mail. Deixe ligado."]
];

let servicos = [];
let expediente = [];
let config = {};

await carregar();

async function carregar() {
  const [rS, rE, rC] = await Promise.all([
    supabase.from("servicos").select("*").order("ordem"),
    supabase.from("expediente").select("*").order("dia_semana"),
    supabase.from("configuracoes").select("chave, valor")
  ]);

  for (const r of [rS, rE, rC]) {
    if (r.error) {
      if (tratarSessaoMorta(r.error)) return;
      aviso($("#aviso-geral"), mensagemDeErro(r.error, "Não consegui carregar as configurações."));
      return;
    }
  }

  servicos = rS.data;
  expediente = rE.data;
  config = Object.fromEntries(rC.data.map((c) => [c.chave, c.valor]));

  desenharServicos();
  desenharExpediente();
  desenharRegras();
}

// -----------------------------------------------------------------------------
// Serviços
// -----------------------------------------------------------------------------
function desenharServicos() {
  $("#lista-servicos").innerHTML = servicos.map((s, i) => `
    <div class="item-servico" data-i="${i}">
      <label class="campo campo-nome">
        <span>Nome</span>
        <input type="text" name="nome" value="${escapar(s.nome)}">
      </label>
      <label class="campo campo-curto">
        <span>Duração (min)</span>
        <input type="number" name="duracao_min" min="5" max="480" step="5" value="${s.duracao_min}">
      </label>
      <label class="campo campo-curto">
        <span>Preço (R$)</span>
        <input type="number" name="preco" min="0" step="0.01" value="${(s.preco_centavos / 100).toFixed(2)}">
      </label>
      <label class="campo campo-curto">
        <span>Ordem</span>
        <input type="number" name="ordem" step="1" value="${s.ordem}">
      </label>
      <label class="campo campo-curto" style="flex:0 0 auto">
        <span>Ativo</span>
        <input type="checkbox" name="ativo" ${s.ativo ? "checked" : ""}>
      </label>
    </div>`).join("");
}

$("#btn-novo-servico").addEventListener("click", () => {
  servicos.push({
    id: null, nome: "Novo serviço", duracao_min: 30, preco_centavos: 0,
    ativo: true, ordem: (servicos.at(-1)?.ordem || 0) + 1
  });
  desenharServicos();
});

$("#btn-salvar-servicos").addEventListener("click", async (e) => {
  limparAviso($("#aviso-geral"));
  const liberar = ocupado(e.target, "Salvando…");

  const linhas = $$(".item-servico").map((div) => {
    const i = Number(div.dataset.i);
    const campo = (nome) => div.querySelector(`[name="${nome}"]`);
    return {
      ...(servicos[i].id ? { id: servicos[i].id } : {}),
      nome: campo("nome").value.trim(),
      duracao_min: Number(campo("duracao_min").value),
      // O preço é digitado em reais e guardado em centavos: dinheiro com casa
      // decimal em ponto flutuante é como conta errada nasce.
      preco_centavos: Math.round(Number(campo("preco").value.replace(",", ".")) * 100),
      ordem: Number(campo("ordem").value),
      ativo: campo("ativo").checked
    };
  });

  const invalido = linhas.find((l) => !l.nome || !(l.duracao_min > 0));
  if (invalido) {
    liberar();
    return aviso($("#aviso-geral"), "Todo serviço precisa de nome e de uma duração maior que zero.");
  }

  // Um serviço por chamada: são quatro ou cinco linhas, e um endpoint em lote
  // só existiria para economizar requisição que ninguém está contando.
  try {
    for (const linha of linhas) {
      const { id, ...dados } = linha;
      if (id) await api(`/api/admin/servicos/${id}`, { metodo: "PUT", corpo: dados });
      else await api("/api/admin/servicos", { metodo: "POST", corpo: dados });
    }
  } catch (erro) {
    liberar();
    if (tratarSessaoMorta(erro)) return;
    return aviso($("#aviso-geral"), mensagemDaApi(erro, "Não consegui salvar os serviços."));
  }

  liberar();

  aviso($("#aviso-geral"), "Serviços salvos.", "ok");
  await carregar();
});

// -----------------------------------------------------------------------------
// Expediente
// -----------------------------------------------------------------------------
function desenharExpediente() {
  const porDia = new Map(expediente.map((e) => [e.dia_semana, e]));

  $("#tabela-expediente tbody").innerHTML = DIAS.map((nome, dia) => {
    const e = porDia.get(dia) || {
      dia_semana: dia, abre: "09:00", fecha: "18:00",
      intervalo_inicio: null, intervalo_fim: null, aberto: false
    };
    const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
    return `
      <tr data-dia="${dia}">
        <td>${nome}</td>
        <td><input type="checkbox" name="aberto" ${e.aberto ? "checked" : ""} aria-label="Abre na ${nome}"></td>
        <td><input type="time" name="abre" value="${hhmm(e.abre)}" step="300"></td>
        <td><input type="time" name="fecha" value="${hhmm(e.fecha)}" step="300"></td>
        <td><input type="time" name="intervalo_inicio" value="${hhmm(e.intervalo_inicio)}" step="300"></td>
        <td><input type="time" name="intervalo_fim" value="${hhmm(e.intervalo_fim)}" step="300"></td>
      </tr>`;
  }).join("");
}

$("#btn-salvar-expediente").addEventListener("click", async (e) => {
  limparAviso($("#aviso-geral"));
  const liberar = ocupado(e.target, "Salvando…");

  const linhas = $$("#tabela-expediente tbody tr").map((tr) => {
    const campo = (nome) => tr.querySelector(`[name="${nome}"]`).value;
    return {
      dia_semana: Number(tr.dataset.dia),
      aberto: tr.querySelector('[name="aberto"]').checked,
      abre: campo("abre") || "09:00",
      fecha: campo("fecha") || "18:00",
      // As duas colunas do almoço andam juntas: uma preenchida e a outra vazia
      // é recusado pelo banco, então normalizamos aqui.
      intervalo_inicio: campo("intervalo_inicio") && campo("intervalo_fim") ? campo("intervalo_inicio") : null,
      intervalo_fim: campo("intervalo_inicio") && campo("intervalo_fim") ? campo("intervalo_fim") : null
    };
  });

  const errado = linhas.find((l) => l.fecha <= l.abre);
  if (errado) {
    liberar();
    return aviso($("#aviso-geral"), `Em ${DIAS[errado.dia_semana]}, o horário de fechar precisa ser depois do de abrir.`);
  }

  try {
    for (const linha of linhas) {
      const { dia_semana, ...dados } = linha;
      await api(`/api/admin/expediente/${dia_semana}`, { metodo: "PUT", corpo: dados });
    }
  } catch (erro) {
    liberar();
    if (tratarSessaoMorta(erro)) return;
    return aviso($("#aviso-geral"), mensagemDaApi(erro, "Não consegui salvar o expediente."));
  }

  liberar();

  aviso($("#aviso-geral"), "Expediente salvo. O calendário do cliente já mudou.", "ok");
  await carregar();
});

// -----------------------------------------------------------------------------
// Regras
// -----------------------------------------------------------------------------
function desenharRegras() {
  $("#lista-config").innerHTML = REGRAS.map(([chave, rotulo, unidade, tipo, ajuda]) => {
    const valor = config[chave] ?? "";
    let campo;

    if (tipo === "select") {
      campo = `
        <select name="${chave}">
          <option value="confirmar" ${valor === "confirmar" ? "selected" : ""}>Confirmar sozinho</option>
          <option value="recusar" ${valor === "recusar" ? "selected" : ""}>Recusar sozinho</option>
        </select>`;
    } else if (tipo === "simnao") {
      campo = `
        <select name="${chave}">
          <option value="sim" ${valor === "sim" ? "selected" : ""}>Sim</option>
          <option value="nao" ${valor !== "sim" ? "selected" : ""}>Não</option>
        </select>`;
    } else {
      campo = `<input type="number" name="${chave}" value="${escapar(valor)}" min="0" step="1">`;
    }

    return `
      <label class="campo">
        <span>${rotulo}${unidade ? ` (${unidade})` : ""}</span>
        ${campo}
        <span class="campo-dica">${ajuda}</span>
      </label>`;
  }).join("");
}

$("#btn-salvar-config").addEventListener("click", async (e) => {
  limparAviso($("#aviso-geral"));
  const liberar = ocupado(e.target, "Salvando…");

  // Um objeto chave → valor; a API só aceita as chaves que ela conhece.
  const corpo = Object.fromEntries(REGRAS.map(([chave]) => [
    chave, String($(`#lista-config [name="${chave}"]`).value).trim()
  ]));

  try {
    await api("/api/admin/configuracoes", { metodo: "PUT", corpo });
  } catch (erro) {
    liberar();
    if (tratarSessaoMorta(erro)) return;
    return aviso($("#aviso-geral"), mensagemDaApi(erro, "Não consegui salvar as regras."));
  }

  liberar();

  aviso($("#aviso-geral"), "Regras salvas.", "ok");
  await carregar();
});
