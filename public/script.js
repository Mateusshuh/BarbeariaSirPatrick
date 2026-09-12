(function () {
  "use strict";

  var AGENDA_URL = "/agenda/";

  /* ---------- 1. Botões de agendar ---------- */
  var botoes = document.querySelectorAll(".js-agenda");
  for (var i = 0; i < botoes.length; i++) {
    botoes[i].setAttribute("href", AGENDA_URL);
    botoes[i].setAttribute("target", "_blank");
    botoes[i].setAttribute("rel", "noopener");
  }

  /* ---------- 1.5. Detalhes dos serviços ---------- */
  var servicoBotoes = document.querySelectorAll(".servico-trigger");
  for (var s = 0; s < servicoBotoes.length; s++) {
    servicoBotoes[s].addEventListener("click", function () {
      var detalheId = this.getAttribute("aria-controls");
      var detalhe = document.getElementById(detalheId);
      var aberto = this.getAttribute("aria-expanded") === "true";

      if (!detalhe) return;

      this.setAttribute("aria-expanded", String(!aberto));
      detalhe.hidden = aberto;
    });
  }

  /* ---------- 2. Header que acompanha a rolagem ----------
     O header é fixo o tempo todo. Transparente só em repouso no topo, onde
     atrás dele existe apenas a parte vazia da foto; assim que a rolagem
     começa ele ganha fundo, porque a partir daí o conteúdo passa POR BAIXO
     dele — sem fundo, a marca do header fica escrita em cima do título do
     hero, creme sobre creme.

     O gatilho é a sentinela de 1px, não o hero: o que importa é "saiu do
     repouso", e não "a foto acabou". */
  var header = document.getElementById("site-header");
  var sentinela = document.querySelector(".topo-sentinela");

  if (header && sentinela && "IntersectionObserver" in window) {
    var observador = new IntersectionObserver(
      function (entradas) {
        /* A callback pode receber várias entradas de uma vez, e a primeira
           é a mais ANTIGA: vale sempre a última, ou o header fica no estado
           errado quando duas mudanças caem no mesmo lote. */
        var ultima = entradas[entradas.length - 1];
        header.classList.toggle("is-stuck", !ultima.isIntersecting);
      },
      { threshold: 0 },
    );

    observador.observe(sentinela);
  } else if (header) {
    header.classList.add("is-stuck");
  }

  /* ---------- 3. Títulos letra por letra ----------
     Cada letra vira um <span> com seu próprio atraso, para o título se
     escrever na tela em vez de simplesmente aparecer.

     Três cuidados que não são óbvios:
     - o <em> dourado e o <br> têm de sobreviver, então percorremos a
       árvore em vez de mexer em textContent, que apagaria as duas coisas;
     - a palavra inteira ganha um <span> próprio porque letras em
       inline-block permitiriam quebra de linha no meio da palavra;
     - o título recebe aria-label com o texto original: para um leitor de
       tela, 30 spans soltos podem virar 30 letras lidas uma a uma. */
  var PASSO_LETRA = 26; // ms de diferença entre uma letra e a seguinte
  var semMovimento = window.matchMedia("(prefers-reduced-motion: reduce)");

  function separarEmLetras(titulo) {
    /* Guarda o texto legível antes de picar o conteúdo em pedaços.
       O <br> não gera texto nenhum, então ler textContent direto colaria
       as palavras das duas linhas ("te" + "espera" = "teespera"). Numa
       cópia descartável cada <br> vira um espaço primeiro. */
    var copia = titulo.cloneNode(true);
    var quebras = copia.querySelectorAll("br");
    for (var q = 0; q < quebras.length; q++) {
      quebras[q].parentNode.replaceChild(
        document.createTextNode(" "),
        quebras[q],
      );
    }

    titulo.setAttribute(
      "aria-label",
      copia.textContent.replace(/\s+/g, " ").trim(),
    );

    var indice = 0;

    function percorrer(no) {
      var filhos = Array.prototype.slice.call(no.childNodes);

      for (var i = 0; i < filhos.length; i++) {
        var filho = filhos[i];

        if (filho.nodeType === 3) {
          // Nó de texto: separa em palavras, e cada palavra em letras.
          var pedacos = filho.nodeValue.split(/(\s+)/);
          var bloco = document.createDocumentFragment();

          for (var p = 0; p < pedacos.length; p++) {
            var pedaco = pedacos[p];
            if (pedaco === "") continue;

            if (/^\s+$/.test(pedaco)) {
              // Espaço segue nó de texto normal, senão a linha não quebra.
              bloco.appendChild(document.createTextNode(" "));
              continue;
            }

            var palavra = document.createElement("span");
            palavra.className = "palavra";

            // Array.from respeita acentos e pares surrogados.
            var letras = Array.from(pedaco);
            for (var c = 0; c < letras.length; c++) {
              var letra = document.createElement("span");
              letra.className = "letra";
              letra.textContent = letras[c];
              letra.style.transitionDelay = indice * PASSO_LETRA + "ms";
              indice++;
              palavra.appendChild(letra);
            }

            bloco.appendChild(palavra);
          }

          no.replaceChild(bloco, filho);
        } else if (filho.nodeType === 1 && filho.tagName !== "BR") {
          // Entra no <em> para animar as letras dele mantendo o itálico.
          percorrer(filho);
        }
      }
    }

    percorrer(titulo);
  }

  /* Com movimento reduzido nem separamos: sem animação, os spans só
     serviriam para atrapalhar. */
  if (!semMovimento.matches) {
    var titulos = document.querySelectorAll(".letras");
    for (var t = 0; t < titulos.length; t++) {
      separarEmLetras(titulos[t]);
    }
  }

  /* ---------- 4. Entrada dos textos por rolagem ----------
     Cada bloco é revelado uma vez e depois esquecido: reaparecer a cada
     subida e descida cansa mais do que ajuda. O estado de partida vive no
     CSS, então blocos já visíveis no carregamento entram na primeira
     chamada do observer, sem esperar rolagem. */
  var blocos = document.querySelectorAll(".reveal-group, .reveal");

  if (blocos.length && "IntersectionObserver" in window) {
    var observadorTexto = new IntersectionObserver(
      function (entradas, obs) {
        for (var n = 0; n < entradas.length; n++) {
          if (!entradas[n].isIntersecting) continue;
          entradas[n].target.classList.add("is-visible");
          obs.unobserve(entradas[n].target);
        }
      },
      /* A margem de baixo atrasa o disparo: o bloco só conta como visível
         depois de entrar de verdade, não no instante em que encosta na
         borda da tela. */
      { threshold: 0.1, rootMargin: "0px 0px -8% 0px" },
    );

    for (var b = 0; b < blocos.length; b++) {
      observadorTexto.observe(blocos[b]);
    }
  } else {
    /* Sem observer não há como saber a hora certa; melhor tudo visível do
       que conteúdo preso invisível. */
    for (var v = 0; v < blocos.length; v++) {
      blocos[v].classList.add("is-visible");
    }
  }

  /* ---------- 5. Mapa sob demanda ---------- */
  var mapa = document.querySelector(".onde-mapa iframe[data-src]");

  if (mapa && "IntersectionObserver" in window) {
    var observadorMapa = new IntersectionObserver(
      function (entradas, obs) {
        /* Carrega uma vez só: basta que QUALQUER entrada do lote tenha
           cruzado a margem. */
        var chegou = entradas.some(function (e) {
          return e.isIntersecting;
        });
        if (!chegou) return;
        mapa.src = mapa.getAttribute("data-src");
        obs.disconnect();
      },
      { rootMargin: "400px 0px" },
    );

    observadorMapa.observe(mapa.parentNode);
  } else if (mapa) {
    mapa.src = mapa.getAttribute("data-src");
  }

  /* ---------- 6. Spotlight nas superfícies escuras ---------- */
  if (!semMovimento.matches && window.matchMedia("(hover: hover)").matches) {
    var spotlightAreas = document.querySelectorAll(
      ".agenda-booking, .onde",
    );

    for (var a = 0; a < spotlightAreas.length; a++) {
      (function (area) {
        area.addEventListener("pointermove", function (evento) {
          var caixa = area.getBoundingClientRect();
          area.style.setProperty(
            "--spotlight-x",
            evento.clientX - caixa.left + "px",
          );
          area.style.setProperty(
            "--spotlight-y",
            evento.clientY - caixa.top + "px",
          );
          area.style.setProperty("--spotlight-opacity", "1");
        });

        area.addEventListener("pointerleave", function () {
          area.style.setProperty("--spotlight-opacity", "0");
        });
      })(spotlightAreas[a]);
    }
  }

  /* ---------- 7. Rolagem suave nos links internos ---------- */

  document.addEventListener("click", function (evento) {
    var link = evento.target.closest
      ? evento.target.closest('a[href^="#"]')
      : null;
    if (!link) return;

    var alvoId = link.getAttribute("href").slice(1);
    if (!alvoId) return;

    var alvo = document.getElementById(alvoId);
    if (!alvo) return;

    evento.preventDefault();

    var alturaHeader = header ? header.offsetHeight : 0;
    var topo =
      alvo.getBoundingClientRect().top + window.pageYOffset - alturaHeader;

    window.scrollTo({
      top: Math.max(topo, 0),
      behavior: semMovimento.matches ? "auto" : "smooth",
    });

    alvo.setAttribute("tabindex", "-1");
    alvo.focus({ preventScroll: true });
  });
})();
