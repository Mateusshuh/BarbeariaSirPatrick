// =============================================================================
// Entrar / Criar conta / Recuperar senha
// =============================================================================
// Nenhuma linha de autenticação escrita à mão: verificação de e-mail, troca de
// senha e expiração de sessão vêm prontas do Supabase Auth. O que este arquivo
// faz é trocar de aba, validar o que dá para validar antes de chamar, e
// traduzir cada erro para uma frase que diz o que fazer em seguida.
// =============================================================================

import { supabase, mensagemDeErro } from "/shared/supabase.js";
import { consumirDestino } from "/shared/sessao.js";
import { $, aviso, limparAviso, ocupado } from "/shared/ui.js";

const painelEntrar = $("#painel-entrar");
const painelCriar = $("#painel-criar");
const painelRecuperar = $("#painel-recuperar");
const abaEntrar = $("#aba-entrar");
const abaCriar = $("#aba-criar");

// -----------------------------------------------------------------------------
// Quem já entrou não vê esta tela
// -----------------------------------------------------------------------------
const { data: { session } } = await supabase.auth.getSession();
if (session) location.replace(consumirDestino("/agenda/"));

// Motivo pelo qual a pessoa foi parar aqui — vindo do guarda de sessão.
const motivo = new URLSearchParams(location.search).get("motivo");
if (motivo === "sessao") {
  aviso($("#aviso-topo"), "Sua sessão expirou por segurança. Entre de novo para continuar de onde parou.", "atencao");
}

// -----------------------------------------------------------------------------
// Abas
// -----------------------------------------------------------------------------
function mostrar(qual) {
  painelEntrar.hidden = qual !== "entrar";
  painelCriar.hidden = qual !== "criar";
  painelRecuperar.hidden = qual !== "recuperar";
  abaEntrar.setAttribute("aria-selected", String(qual === "entrar"));
  abaCriar.setAttribute("aria-selected", String(qual === "criar"));
  // As abas somem quando a recuperação está aberta: ela não é uma terceira aba,
  // é um desvio do caminho de entrar.
  $(".abas").hidden = qual === "recuperar";
}

abaEntrar.addEventListener("click", () => mostrar("entrar"));
abaCriar.addEventListener("click", () => mostrar("criar"));
$("#link-esqueci").addEventListener("click", () => {
  const email = $("#form-entrar").email.value.trim();
  if (email) $("#form-recuperar").email.value = email;
  mostrar("recuperar");
});
$("#link-voltar").addEventListener("click", () => mostrar("entrar"));

// Abrir direto na criação de conta quando o link pede: /entrar.html?nova=1
if (new URLSearchParams(location.search).get("nova")) mostrar("criar");

// -----------------------------------------------------------------------------
// Entrar
// -----------------------------------------------------------------------------
$("#form-entrar").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const form = evento.target;
  const caixa = $("#aviso-entrar");
  limparAviso(caixa);

  const email = form.email.value.trim();
  const senha = form.senha.value;

  if (!email || !senha) {
    aviso(caixa, "Preencha o e-mail e a senha.");
    return;
  }

  const liberar = ocupado(form.querySelector("button"), "Entrando…");
  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
  liberar();

  if (error) {
    aviso(caixa, mensagemDeErro(error));
    // E-mail não confirmado tem saída própria: reenviar o link.
    if (/email not confirmed/i.test(error.message || "")) {
      caixa.innerHTML += ' <button type="button" id="reenviar" style="border:0;background:none;font:inherit;text-decoration:underline;cursor:pointer;padding:0">Reenviar o e-mail de confirmação</button>';
      $("#reenviar").addEventListener("click", async () => {
        await supabase.auth.resend({ type: "signup", email });
        aviso(caixa, "Reenviado. Confira sua caixa de entrada e o spam.", "ok");
      });
    }
    return;
  }

  location.replace(consumirDestino("/agenda/"));
});

// -----------------------------------------------------------------------------
// Criar conta
// -----------------------------------------------------------------------------
$("#form-criar").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const form = evento.target;
  const caixa = $("#aviso-criar");
  limparAviso(caixa);

  const nome = form.nome.value.trim();
  const telefone = form.telefone.value.trim();
  const email = form.email.value.trim();
  const senha = form.senha.value;

  // Validação do que dá para validar sem ir ao servidor. O resto é com o Auth.
  if (nome.length < 2) return aviso(caixa, "Escreva seu nome — é como o Patrick vai te chamar.");
  if (telefone.replace(/\D/g, "").length < 10) {
    return aviso(caixa, "O WhatsApp precisa do DDD. Exemplo: (55) 99999-0000.");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return aviso(caixa, "Confira o e-mail: parece incompleto.");
  if (senha.length < 6) return aviso(caixa, "A senha precisa de pelo menos 6 caracteres.");

  const liberar = ocupado(form.querySelector("button"), "Criando…");
  const { data, error } = await supabase.auth.signUp({
    email,
    password: senha,
    options: {
      // Um gatilho no banco lê estes dois campos e cria a linha em perfis, que
      // é o vínculo entre a conta e os agendamentos.
      data: { nome, telefone },
      emailRedirectTo: location.origin + "/agenda/"
    }
  });
  liberar();

  if (error) return aviso(caixa, mensagemDeErro(error));

  // Com confirmação de e-mail ligada, o Supabase responde "sucesso" mesmo para
  // e-mail já cadastrado (para não revelar quem tem conta). O sinal é a lista
  // de identities vazia.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    aviso(caixa, "Esse e-mail já tem conta. Use a aba <strong>Entrar</strong>, ou recupere a senha.", "atencao");
    return;
  }

  if (data.session) {
    location.replace(consumirDestino("/agenda/"));
    return;
  }

  form.reset();
  aviso(caixa,
    `Conta criada. Enviamos um e-mail para <strong>${email}</strong> — abra o link de confirmação e volte aqui para entrar.`,
    "ok");
});

// -----------------------------------------------------------------------------
// Recuperar senha
// -----------------------------------------------------------------------------
$("#form-recuperar").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const form = evento.target;
  const caixa = $("#aviso-recuperar");
  limparAviso(caixa);

  const email = form.email.value.trim();
  if (!email) return aviso(caixa, "Escreva o e-mail da sua conta.");

  const liberar = ocupado(form.querySelector("button"), "Enviando…");
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + "/agenda/redefinir-senha.html"
  });
  liberar();

  if (error) return aviso(caixa, mensagemDeErro(error));

  // Resposta igual para e-mail existente ou não: dizer "essa conta não existe"
  // entrega a lista de clientes para quem ficar tentando endereços.
  aviso(caixa,
    "Se existe conta com esse e-mail, o link já está a caminho. Confira também o spam.",
    "ok");
});
