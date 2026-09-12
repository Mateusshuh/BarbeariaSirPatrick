// =============================================================================
// Utilidades de tela
// =============================================================================
// Formatação, rótulos de estado e os pedaços de HTML que aparecem em mais de
// uma página. Nada aqui decide regra de negócio: isso é trabalho do Postgres.
// =============================================================================

import { FUSO, DDI_PADRAO } from "./config.js";

// -----------------------------------------------------------------------------
// Datas
// -----------------------------------------------------------------------------
// Tudo é formatado no fuso da barbearia, nunca no fuso do aparelho. Um cliente
// que abre a agenda viajando precisa ver o horário de Três de Maio.

const fmt = (opcoes) => new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, ...opcoes });

const fHora = fmt({ hour: "2-digit", minute: "2-digit" });
const fDiaMes = fmt({ day: "2-digit", month: "2-digit" });
const fDiaSemana = fmt({ weekday: "long" });
const fCompleto = fmt({ weekday: "long", day: "2-digit", month: "long" });

export function hora(iso) { return fHora.format(new Date(iso)); }
export function diaMes(iso) { return fDiaMes.format(new Date(iso)); }
export function diaSemana(iso) { return fDiaSemana.format(new Date(iso)); }

/** "sexta-feira, 11 de setembro às 14:30" */
export function quandoPorExtenso(iso) {
  const d = new Date(iso);
  return `${fCompleto.format(d)} às ${fHora.format(d)}`;
}

/** "sex, 11/09 às 14:30" — versão curta, para listas */
export function quandoCurto(iso) {
  const d = new Date(iso);
  const semana = fDiaSemana.format(d).slice(0, 3);
  return `${semana}, ${fDiaMes.format(d)} às ${fHora.format(d)}`;
}

/** Data no formato do banco (YYYY-MM-DD), calculada no fuso da barbearia. */
export function dataISO(data) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(data);
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function hojeISO() { return dataISO(new Date()); }

/** Quanto falta ou quanto já passou, em palavras: "há 20 min", "em 3 h". */
export function intervaloHumano(iso, { futuro = false } = {}) {
  const ms = Math.abs(new Date(iso) - new Date());
  const min = Math.round(ms / 60000);
  let texto;
  if (min < 1) texto = "menos de 1 min";
  else if (min < 60) texto = `${min} min`;
  else if (min < 60 * 24) texto = `${Math.floor(min / 60)} h`;
  else texto = `${Math.floor(min / 1440)} dia${Math.floor(min / 1440) > 1 ? "s" : ""}`;
  return futuro ? `em ${texto}` : `há ${texto}`;
}

/** Início do dia (00:00) daquele dia no fuso da barbearia, como Date. */
export function inicioDoDia(iso) { return new Date(`${iso}T00:00:00-03:00`); }

// -----------------------------------------------------------------------------
// Dinheiro e telefone
// -----------------------------------------------------------------------------

export function dinheiro(centavos) {
  return (Number(centavos || 0) / 100).toLocaleString("pt-BR", {
    style: "currency", currency: "BRL"
  });
}

export function duracao(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto ? `${h}h${String(resto).padStart(2, "0")}` : `${h}h`;
}

/** (55) 99999-0000 — só para exibir; o banco guarda como a pessoa digitou. */
export function telefoneBonito(tel) {
  const d = String(tel || "").replace(/\D/g, "").replace(/^55/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return tel || "";
}

export function linkWhatsApp(tel, texto) {
  const d = String(tel || "").replace(/\D/g, "");
  const numero = d.startsWith(DDI_PADRAO) ? d : DDI_PADRAO + d;
  return `https://wa.me/${numero}${texto ? "?text=" + encodeURIComponent(texto) : ""}`;
}

// -----------------------------------------------------------------------------
// Estados
// -----------------------------------------------------------------------------

export const ESTADOS = {
  pendente: { rotulo: "Aguardando o Patrick", curto: "Pendente" },
  confirmado: { rotulo: "Confirmado", curto: "Confirmado" },
  recusado: { rotulo: "Recusado", curto: "Recusado" },
  cancelado: { rotulo: "Cancelado", curto: "Cancelado" },
  concluido: { rotulo: "Atendido", curto: "Atendido" },
  nao_compareceu: { rotulo: "Não compareceu", curto: "Faltou" }
};

export function selo(status, curto = false) {
  const e = ESTADOS[status] || { rotulo: status, curto: status };
  return `<span class="selo selo-${status}">${curto ? e.curto : e.rotulo}</span>`;
}

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

/** Texto vindo do banco nunca entra por innerHTML sem passar por aqui. */
export function escapar(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Mostra um aviso. tipo: "erro" | "ok" | "atencao" | "info".
 * Avisos de erro recebem foco de leitor de tela: quem não vê a tela precisa
 * saber que a tentativa falhou.
 */
export function aviso(elemento, texto, tipo = "erro") {
  if (!elemento) return;
  elemento.className = "aviso" + (tipo === "info" ? "" : ` aviso-${tipo}`);
  elemento.innerHTML = texto;
  elemento.hidden = false;
  elemento.setAttribute("role", tipo === "erro" ? "alert" : "status");
}

export function limparAviso(elemento) {
  if (!elemento) return;
  elemento.hidden = true;
  elemento.innerHTML = "";
}

/** Desabilita o botão enquanto a chamada está no ar, e devolve o texto depois. */
export function ocupado(botao, textoOcupado) {
  const original = botao.dataset.textoOriginal || botao.textContent;
  botao.dataset.textoOriginal = original;
  botao.disabled = true;
  botao.textContent = textoOcupado || "Enviando…";
  return () => {
    botao.disabled = false;
    botao.textContent = original;
  };
}

/** Cabeçalho com o nome de quem está logado. Sem isto a pessoa não sabe com
    qual conta está, nem como sair. */
export function montarTopo(elemento, perfil, { admin = false } = {}) {
  if (!elemento) return;
  const primeiroNome = escapar((perfil?.nome || "").split(" ")[0] || "você");
  elemento.innerHTML = `
    <div class="shell topo-inner">
      <a class="marca" href="${admin ? "/admin/" : "/agenda/"}">
        <span class="marca-nome">Sir. Patrick</span>
        <span class="marca-kicker">${admin ? "PAINEL" : "AGENDA"}</span>
      </a>
      <div class="topo-conta">
        <span>Olá, <strong>${primeiroNome}</strong></span>
        ${admin
          ? '<a href="/admin/config.html">Configurações</a>'
          : '<a href="/agenda/minha-conta.html">Minha conta</a>'}
        <a href="#" data-sair>Sair</a>
      </div>
    </div>`;
}

/**
 * Monta o instante exato de "dia às HH:MM" no fuso da barbearia.
 * O Brasil não tem horário de verão desde 2019, então o deslocamento é fixo em
 * -03:00. Se um dia voltar, é esta linha que muda — e só ela no projeto todo.
 */
export function instanteLocal(diaISO, hhmm) {
  return new Date(`${diaISO}T${String(hhmm).slice(0, 5)}:00-03:00`);
}

/** Lê o início de um tstzrange como o PostgREST devolve: ["2026-09-12 14:30:00-03",...) */
export function inicioDoPeriodo(periodo) {
  const bruto = String(periodo).replace(/^[\[(]/, "").split(",")[0].replace(/"/g, "").trim();
  return new Date(bruto.replace(" ", "T"));
}

/** Idem, para o fim. */
export function fimDoPeriodo(periodo) {
  const bruto = String(periodo).replace(/[\])]$/, "").split(",")[1].replace(/"/g, "").trim();
  return new Date(bruto.replace(" ", "T"));
}
