// =============================================================================
// Redefinir senha
// =============================================================================
// O link do e-mail traz um token no endereço. O supabase-js troca esse token
// por uma sessão sozinho (detectSessionInUrl) e emite PASSWORD_RECOVERY — daí
// em diante é só um updateUser. Nada de token manipulado à mão aqui.
// =============================================================================

import { supabase, mensagemDeErro } from "/shared/supabase.js";
import { $, aviso, limparAviso, ocupado } from "/shared/ui.js";

const caixa = $("#aviso");
const form = $("#form-senha");

// O link pode chegar vencido ou já usado. Nesse caso não existe sessão de
// recuperação, e insistir no formulário só gera frustração.
let pronto = false;

supabase.auth.onAuthStateChange((evento) => {
  if (evento === "PASSWORD_RECOVERY" || evento === "SIGNED_IN") pronto = true;
});

const { data: { session } } = await supabase.auth.getSession();
if (session) pronto = true;

// Dá um instante para o supabase-js processar o token que veio no endereço.
setTimeout(() => {
  if (!pronto) {
    aviso(caixa,
      'Este link não vale mais — eles expiram por segurança. <a href="/agenda/entrar.html">Peça um novo link</a> na tela de entrar.',
      "atencao");
    form.querySelector("button").disabled = true;
  }
}, 1500);

form.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  limparAviso(caixa);

  const senha = form.senha.value;
  const senha2 = form.senha2.value;

  if (senha.length < 6) return aviso(caixa, "A senha precisa de pelo menos 6 caracteres.");
  if (senha !== senha2) return aviso(caixa, "As duas senhas não são iguais. Confira e tente de novo.");

  const liberar = ocupado(form.querySelector("button"), "Salvando…");
  const { error } = await supabase.auth.updateUser({ password: senha });
  liberar();

  if (error) return aviso(caixa, mensagemDeErro(error));

  aviso(caixa, "Senha trocada. Levando você para a agenda…", "ok");
  setTimeout(() => location.replace("/agenda/"), 1200);
});
