// =============================================================================
// Autenticação
// =============================================================================
// O cliente entra pelo Supabase Auth e recebe um JWT. Toda chamada à API traz
// esse token no Authorization. Aqui ele é validado contra o Supabase — nunca
// decodificado à mão, nunca acreditado sem conferir.
//
// Nenhum campo vindo do navegador decide papel. O papel é lido da tabela
// perfis, no nosso banco, a cada chamada de admin.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { uma } from "./db.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Validar o token é uma chamada de rede ao Supabase. Guardar o resultado por
// pouco tempo tira essa ida do caminho de cada clique sem abrir buraco: se a
// sessão for revogada, o pior caso é um minuto de atraso.
const CACHE_MS = 60_000;
const cache = new Map();

function doCache(token) {
  const guardado = cache.get(token);
  if (guardado && guardado.ate > Date.now()) return guardado.usuario;
  cache.delete(token);
  return null;
}

function guardar(token, usuario) {
  // Teto para a memória não crescer com token velho de quem nunca mais voltou.
  if (cache.size > 500) cache.clear();
  cache.set(token, { usuario, ate: Date.now() + CACHE_MS });
}

function lerToken(req) {
  const cabecalho = req.get("authorization") || "";
  if (!cabecalho.toLowerCase().startsWith("bearer ")) return null;
  const token = cabecalho.slice(7).trim();
  return token || null;
}

/** Exige sessão válida. Preenche req.usuario. */
export async function exigeCliente(req, res, next) {
  const token = lerToken(req);
  if (!token) return res.status(401).json({ erro: "SEM_SESSAO" });

  try {
    let usuario = doCache(token);

    if (!usuario) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) return res.status(401).json({ erro: "SESSAO_INVALIDA" });

      usuario = {
        id: data.user.id,
        email: data.user.email,
        emailConfirmado: Boolean(data.user.email_confirmed_at)
      };
      guardar(token, usuario);
    }

    req.usuario = usuario;
    next();
  } catch (erro) {
    console.error("[auth]", erro.message);
    res.status(503).json({ erro: "AUTH_INDISPONIVEL" });
  }
}

/** Exige sessão válida E papel admin. */
export async function exigeAdmin(req, res, next) {
  exigeCliente(req, res, async () => {
    const perfil = await uma("select papel from perfis where id = $1", [req.usuario.id]);

    // Token bom, papel errado: 403, não 401. Entrar de novo não resolveria, e
    // mandar a pessoa para o login seria mentira.
    if (perfil?.papel !== "admin") return res.status(403).json({ erro: "SEM_PERMISSAO" });

    req.usuario.papel = "admin";
    next();
  });
}

/** Some com o token do cache quando a sessão cai. */
export function esquecerToken(req) {
  const token = lerToken(req);
  if (token) cache.delete(token);
}
