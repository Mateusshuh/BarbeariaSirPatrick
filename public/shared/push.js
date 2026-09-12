// =============================================================================
// Notificação neste aparelho
// =============================================================================
// Registra o service worker, pede permissão e guarda a assinatura em
// push_assinaturas. A chave que aparece aqui é a VAPID PÚBLICA — a privada vive
// só nos segredos da Edge Function, e nunca chega ao navegador.
//
// No iPhone, Web Push só funciona a partir do iOS 16.4 e SOMENTE com o site
// adicionado à tela de início. Como aba comum do Safari a notificação não
// chega, sem erro e sem aviso — por isso a tela avisa antes, em vez de deixar
// a pessoa achar que ativou.
// =============================================================================

import { api, mensagemDaApi } from "./api.js";
import { VAPID_PUBLIC_KEY } from "./config.js";
import { aviso } from "./ui.js";

const NO_ADMIN = location.pathname.startsWith("/admin/");
const ARQUIVO_SW = NO_ADMIN ? "/admin/sw.js" : "/agenda/sw.js";
const ESCOPO = NO_ADMIN ? "/admin/" : "/agenda/";

export function suportado() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function ehIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function instalado() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

/**
 * Desenha a oferta de ativação dentro de um elemento.
 * Não faz nada se a Fase 4 não estiver configurada (VAPID vazia) — melhor
 * nenhum botão do que um botão que não funciona.
 */
export async function oferecerAtivacao(caixa, { texto } = {}) {
  if (!caixa) return;
  if (!VAPID_PUBLIC_KEY) throw new Error("VAPID pública não configurada");
  if (!suportado()) return;

  // iPhone fora da tela de início: explicar o caminho é mais útil que um botão
  // que parece funcionar e não entrega nada.
  if (ehIOS() && !instalado()) {
    caixa.innerHTML = `
      <p class="aviso aviso-atencao">
        Para receber avisos no iPhone: toque em <strong>Compartilhar</strong> →
        <strong>Adicionar à Tela de Início</strong> e abra por lá. No Safari
        comum o iOS não entrega notificação.
      </p>`;
    return;
  }

  if (Notification.permission === "denied") {
    caixa.innerHTML = `
      <p class="aviso">
        As notificações estão bloqueadas para este site nas configurações do
        navegador. Libere por lá para voltar a receber avisos.
      </p>`;
    return;
  }

  const registro = await navigator.serviceWorker.getRegistration(ESCOPO);
  const jaTem = registro && await registro.pushManager.getSubscription();

  if (jaTem && Notification.permission === "granted") {
    caixa.innerHTML = '<p class="aviso aviso-ok">Avisos ligados neste aparelho.</p>';
    return;
  }

  caixa.innerHTML = `
    <div class="cartao" style="margin:22px 0">
      <p style="margin-bottom:12px">${texto || "Receber avisos neste aparelho?"}</p>
      <button class="btn btn-linha" type="button" id="btn-ativar-push">Ativar avisos</button>
      <p class="aviso" id="aviso-push" hidden></p>
    </div>`;

  caixa.querySelector("#btn-ativar-push").addEventListener("click", async (e) => {
    const botao = e.target;
    botao.disabled = true;
    botao.textContent = "Ativando…";
    try {
      await ativar();
      caixa.innerHTML = '<p class="aviso aviso-ok">Pronto. Os avisos chegam neste aparelho.</p>';
    } catch (erro) {
      botao.disabled = false;
      botao.textContent = "Ativar avisos";
      aviso(caixa.querySelector("#aviso-push"), mensagemPush(erro));
    }
  });
}

/** Registra, pede permissão, assina e guarda. */
export async function ativar() {
  const registro = await navigator.serviceWorker.register(ARQUIVO_SW, { scope: ESCOPO });
  await navigator.serviceWorker.ready;

  const permissao = await Notification.requestPermission();
  if (permissao !== "granted") throw new Error("permissao-negada");

  const assinatura = await registro.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64ParaBytes(VAPID_PUBLIC_KEY)
  });

  const bruto = assinatura.toJSON();

  // Quem grava a assinatura é a API: ela sabe de qual conta é o token, e assim
  // ninguém cadastra aparelho no nome de outra pessoa. O navegador não escreve
  // mais direto em push_assinaturas.
  await api("/api/push/assinar", {
    metodo: "POST",
    corpo: { endpoint: bruto.endpoint, keys: bruto.keys }
  });

  return assinatura;
}

function mensagemPush(erro) {
  if (String(erro.message).includes("permissao-negada")) {
    return "Você recusou a permissão. Para ligar depois, é nas configurações do navegador para este site.";
  }
  return mensagemDaApi(erro,
    "Não consegui ligar os avisos neste aparelho. Tente de novo mais tarde — você continua recebendo por e-mail.");
}

/** A chave VAPID vem em base64url e o navegador quer bytes. */
function base64ParaBytes(base64) {
  const preenchido = (base64 + "=".repeat((4 - base64.length % 4) % 4))
    .replace(/-/g, "+").replace(/_/g, "/");
  const texto = atob(preenchido);
  return Uint8Array.from(texto, (c) => c.charCodeAt(0));
}
