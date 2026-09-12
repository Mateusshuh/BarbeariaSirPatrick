// =============================================================================
// Service worker do painel
// =============================================================================
// Faz duas coisas, e só: mostra a notificação que chega e trata o toque nela.
// Não guarda credencial nenhuma — os botões de ação abrem o painel com a ação
// no endereço, e quem executa é a página, que tem a sessão do Patrick.
//
// Inventar um token próprio para o service worker chamar a API direto exigiria
// uma credencial fora da sessão, guardada no aparelho. É exatamente onde esse
// tipo de projeto abre buraco de segurança.
// =============================================================================

self.addEventListener("install", (evento) => {
  // Assume o lugar do anterior sem esperar: notificação velha com código velho
  // é pior do que uma troca abrupta numa tela que não tem estado.
  evento.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(self.clients.claim());
});

self.addEventListener("push", (evento) => {
  let dados = {};
  try {
    dados = evento.data ? evento.data.json() : {};
  } catch (_) {
    dados = { titulo: "Sir. Patrick", corpo: evento.data ? evento.data.text() : "" };
  }

  const titulo = dados.titulo || "Novo pedido de horário";
  const opcoes = {
    body: dados.corpo || "",
    icon: "/admin/icone-192.png",
    badge: "/admin/badge-96.png",
    lang: "pt-BR",
    tag: dados.id ? `pedido-${dados.id}` : "sir-patrick",
    renotify: true,
    requireInteraction: true,   // fica na tela até ele responder
    data: { id: dados.id || null, url: dados.url || "/admin/" },
    actions: dados.id
      ? [
          { action: "confirmar", title: "Confirmar" },
          { action: "recusar", title: "Recusar" },
          { action: "ver", title: "Ver agenda" }
        ]
      : []
  };

  evento.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener("notificationclick", (evento) => {
  evento.notification.close();

  const { id, url } = evento.notification.data || {};
  let destino = url || "/admin/";

  // Responder em cinco segundos, sem abrir o app: é este detalhe que faz o
  // fluxo funcionar. A ação vai no endereço e o painel executa ao abrir.
  if (evento.action === "confirmar" && id) destino = `/admin/?acao=confirmar&id=${id}`;
  if (evento.action === "recusar" && id) destino = `/admin/?acao=recusar&id=${id}`;

  evento.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    // Se o painel já está aberto, reaproveita a aba em vez de abrir outra.
    for (const aba of abertas) {
      if (aba.url.includes("/admin/")) {
        await aba.focus();
        if ("navigate" in aba) return aba.navigate(destino);
        return aba.postMessage({ tipo: "navegar", destino });
      }
    }

    return self.clients.openWindow(destino);
  })());
});
