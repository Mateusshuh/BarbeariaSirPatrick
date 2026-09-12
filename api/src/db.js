// =============================================================================
// Conexão com o Postgres do Supabase
// =============================================================================

import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  // Falhar no arranque é melhor que falhar no primeiro cliente.
  console.error("[api] falta DATABASE_URL");
  process.exit(1);
}

// ATENÇÃO À STRING DE CONEXÃO.
// Use a do POOLER do Supabase (a que tem "pooler.supabase.com" no host), nunca
// a conexão direta (db.<ref>.supabase.co). A direta só responde em IPv6, e o
// Render pode não alcançá-la: o erro que aparece é de conexão, parece
// credencial errada, e custa horas até alguém desconfiar do protocolo.
//
// Painel do Supabase → Project Settings → Database → Connection string →
// Transaction pooler (porta 6543) ou Session pooler (porta 5432).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // O plano gratuito do Supabase tem limite baixo de conexões e esta API é um
  // serviço só, com um barbeiro atendendo. Cinco é folga.
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,

  // O pooler exige TLS e apresenta certificado de uma CA que o Node não traz.
  ssl: { rejectUnauthorized: false }
});

// Toda conexão nasce no fuso da barbearia. Não é enfeite: é o mesmo fuso da
// coluna gerada `dia`, e divergência aqui quebra a trava de um por dia.
pool.on("connect", (cliente) => {
  cliente.query("set time zone 'America/Sao_Paulo'").catch(() => {});
});

pool.on("error", (erro) => {
  console.error("[db] conexão ociosa caiu:", erro.message);
});

/** Atalho para consulta simples. */
export function q(texto, valores) {
  return pool.query(texto, valores);
}

/** Primeira linha, ou null. */
export async function uma(texto, valores) {
  const { rows } = await pool.query(texto, valores);
  return rows[0] ?? null;
}

/**
 * Transação. Usada onde duas escritas precisam valer juntas — cancelar um
 * horário e enfileirar o aviso ao Patrick, por exemplo.
 */
export async function transacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    const resultado = await fn(cliente);
    await cliente.query("commit");
    return resultado;
  } catch (erro) {
    await cliente.query("rollback").catch(() => {});
    throw erro;
  } finally {
    cliente.release();
  }
}

/** Lê a tabela de configurações inteira como objeto. */
export async function configuracoes() {
  const { rows } = await pool.query("select chave, valor from configuracoes");
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

export async function configNumero(chave, padrao) {
  const linha = await uma("select valor from configuracoes where chave = $1", [chave]);
  const n = Number(String(linha?.valor ?? "").replace(/\D/g, ""));
  return Number.isFinite(n) && String(linha?.valor ?? "") !== "" ? n : padrao;
}

/**
 * Descreve um erro para o log.
 * Existe por um motivo concreto: quando o Node tenta IPv6 e IPv4 e as duas
 * falham, ele entrega um AggregateError com `message` VAZIO — e o log sai como
 * "[fila]" e mais nada, que é o pior tipo de pista. Aqui a causa real aparece.
 */
export function descreverErro(erro) {
  if (!erro) return "erro sem detalhe";

  const partes = [erro.message, erro.code].filter(Boolean);

  if (Array.isArray(erro.errors) && erro.errors.length) {
    partes.push(erro.errors.map((e) => e.message || e.code).filter(Boolean).join(" · "));
  }

  return partes.filter(Boolean).join(" ") || String(erro);
}
