# Publicação — Barbearia Sir. Patrick

Três peças, nesta ordem de montagem:

```
Static Site (Render)  ──┬──▶ Supabase Auth          entrar, criar conta
                        ├──▶ Supabase RPC           quais horários estão livres
                        └──▶ Web Service (Render) ──▶ Supabase Postgres
                                                       pedir, cancelar,
                                                       confirmar, recusar,
                                                       e o envio dos avisos
```

Ler o que está livre vai direto ao Supabase de propósito: o Web Service gratuito
do Render dorme depois de 15 minutos e leva cerca de um minuto para acordar.
Ninguém encara um minuto de tela vazia para ver se tem vaga na terça. Pedir um
horário é clique com botão e spinner — ali a espera é tolerável, e o site ainda
cutuca a API assim que a agenda abre, para ela acordar enquanto a pessoa escolhe.

Legenda: 🖐 feito à mão no painel · ⌨️ linha de comando ou SQL colado.

---

## 1. Supabase — o projeto e o banco

1. 🖐 Crie o projeto em [supabase.com](https://supabase.com). Região **South
   America (São Paulo)**.
2. 🖐 Guarde a senha do banco num gerenciador de senhas — ela não aparece de novo.
3. 🖐 **Anote a connection string do pooler**: Project Settings → Database →
   Connection string → **Transaction pooler**. É a que tem
   `pooler.supabase.com` no host.

   > Use essa, nunca a direta (`db.<ref>.supabase.co`). A direta só responde em
   > IPv6 e o Render pode não alcançá-la: o erro que aparece é de conexão,
   > parece credencial errada, e custa horas até alguém desconfiar do protocolo.

4. ⌨️ SQL Editor → cole e rode **nesta ordem**:
   - `supabase/migrations/001_inicial.sql`
   - `supabase/migrations/002_grade.sql`
   - `supabase/migrations/003_notificacoes.sql`
   - `supabase/migrations/004_api.sql`
5. ⌨️ Rode `supabase/testes/fase_a.sql`. Ele termina devolvendo uma tabela: a
   coluna `passou` precisa estar **toda em `true`**. Linha em `false` é trava de
   segurança que não fechou — pare e resolva antes de seguir.
6. 🖐 Depois de conferir: `drop table public.teste_resultados;`

### Se o `pg_cron` reclamar

A 003 tenta ligar a extensão sozinha. Dando erro de permissão:

1. 🖐 Database → Extensions → `pg_cron` → ligar.
2. ⌨️ Rode de novo o trecho do `cron.schedule` da **004**.

Confira com `select * from cron.job;` — precisa existir `resolver-pendentes`, a
cada dez minutos.

---

## 2. Supabase — contas e e-mails

1. 🖐 Authentication → Providers → **Email**: **Confirm email** ligado. É o que
   sustenta a regra `exige_email_verificado`.
2. 🖐 Authentication → URL Configuration:
   - **Site URL**: `https://seudominio.com.br`
   - **Redirect URLs**: acrescente `https://seudominio.com.br/agenda/**`
     (sem isso o link de confirmação e o de trocar senha voltam para lugar nenhum)
3. 🖐 Authentication → Email Templates: traduza os três modelos. O padrão vem em
   inglês, e e-mail em inglês de uma barbearia do interior parece golpe.
4. 🖐 Crie a conta do Patrick **pelo site**, em `/agenda/entrar.html` → aba Criar
   conta, com o e-mail real dele. Confirme o e-mail.
5. 🖐 **Promova à mão**, no SQL Editor:

   ```sql
   update public.perfis set papel = 'admin'
    where id = (select id from auth.users where email = 'email-do-patrick@exemplo.com');
   ```

   **Nenhuma tela e nenhum endpoint concede admin, e isso é de propósito.** Se
   existisse um botão, existiria um caminho — e toda a separação entre cliente e
   Patrick se apoia nesse campo.

   Confira:

   ```sql
   select u.email, p.papel from public.perfis p join auth.users u on u.id = p.id;
   ```

6. 🖐 Serviços, expediente e configurações: entram com valores de partida nas
   migrações e são editados depois em `/admin/config.html`, sem tocar em SQL.
   **Confira os preços e o horário real da loja antes de divulgar o link** — os
   valores que estão lá são chute de partida.

> O e-mail padrão do Supabase tem limite baixo e cai em spam com facilidade.
> Para uso de verdade, configure SMTP próprio em Authentication → SMTP Settings
> (o mesmo Resend do passo 4 serve).

---

## 3. As chaves no front

🖐 `public/shared/config.js`, com o que está em Project Settings → API:

```js
export const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
export const API_URL = "https://sirpatrick-api.onrender.com";  // preencha no passo 5
export const VAPID_PUBLIC_KEY = "BN...";                        // preencha no passo 4
```

As duas primeiras são **públicas por desenho** — a anon key vai no JavaScript de
qualquer aplicação Supabase que roda no navegador, e quem protege os dados é a
RLS. A VAPID pública também é pública, por definição do protocolo.

O que **nunca** entra aqui: a `service_role`, a VAPID **privada**, a
`DATABASE_URL` e a chave do Resend. Essas quatro vivem só nas variáveis de
ambiente do Web Service.

---

## 4. Chaves VAPID e Resend

⌨️ Numa pasta qualquer:

```bash
npx web-push generate-vapid-keys
```

- A **pública** vai em `public/shared/config.js` e também na variável
  `VAPID_PUBLIC_KEY` do Render (as duas precisam ser a mesma).
- A **privada** só na variável `VAPID_PRIVATE_KEY`.

🖐 Resend: crie a conta em [resend.com](https://resend.com), adicione o domínio e
cadastre na Hostinger os registros TXT/CNAME que ele pedir (SPF e DKIM). Gere uma
API key.

> Sem domínio verificado, o Resend só entrega para o e-mail do dono da conta.
> Serve para testar, não para clientes.

---

## 5. Render — os dois serviços

1. 🖐 [dashboard.render.com](https://dashboard.render.com) → **New** →
   **Blueprint** → aponte para este repositório. O `render.yaml` cria os dois
   serviços e pergunta, uma a uma, as variáveis marcadas com `sync: false`:

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | a string do **pooler** (passo 1) |
   | `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` |
   | `SUPABASE_ANON_KEY` | a anon key |
   | `ORIGEM_PERMITIDA` | `https://seudominio.com.br` (sem barra no fim) |
   | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | do passo 4 |
   | `VAPID_SUBJECT` | `mailto:contato@seudominio.com.br` |
   | `RESEND_API_KEY` | do passo 4 |
   | `EMAIL_REMETENTE` | `Barbearia Sir. Patrick <agenda@seudominio.com.br>` |

2. 🖐 Quando a API subir, copie a URL dela (`https://sirpatrick-api.onrender.com`)
   para `API_URL` em `public/shared/config.js`, faça commit e push. O Static Site
   republica sozinho.

3. 🖐 Confira o health check:

   ```bash
   curl https://sirpatrick-api.onrender.com/api/saude
   # {"ok":true,"agora":"..."}
   ```

   E confira que ele recusa origem estranha (tem que vir `ORIGEM_NAO_PERMITIDA`):

   ```bash
   curl -H "Origin: https://qualquer-site.com" https://sirpatrick-api.onrender.com/api/saude
   ```

4. 🖐 Nos logs da API, no arranque, precisa aparecer:

   ```
   [api] no ar na porta 10000
   [api] origem permitida: https://seudominio.com.br
   [fila] ligada, a cada 30s
   ```

   Se aparecer `origem permitida: (nenhuma!)`, a variável `ORIGEM_PERMITIDA` não
   chegou — e nenhuma escrita vai funcionar.

5. 🖐 Abra direto pela URL, sem passar pela home:
   - `/` → site institucional
   - `/agenda/` → cai na tela de entrar (esperado: sem sessão não se vê nada)
   - `/admin/` → cai na tela de entrar; com a conta do Patrick, abre o painel

---

## 6. Manter a API acordada

O plano gratuito dorme depois de 15 minutos sem tráfego. **Isso não é só
conforto: o trabalhador da fila de notificações só roda com o serviço no ar.**
Sem o ping, o aviso de um pedido novo fica esperando na tabela `notificacoes`
até alguém abrir o site.

🖐 Configure um ping externo a cada **10 minutos** em
`https://sirpatrick-api.onrender.com/api/saude`. Serve qualquer um:
[UptimeRobot](https://uptimerobot.com), [cron-job.org](https://cron-job.org) ou
Better Stack — todos com plano gratuito que cobre isso.

**Sobre as horas:** a conta gratuita do Render dá 750 horas de instância por mês
e o mês tem cerca de 730. Um serviço acordado o tempo todo cabe — **desde que
seja o único Web Service gratuito da conta**. Se criar um segundo, os dois
passam a disputar as mesmas 750 horas e a API cai no fim do mês.

---

## 7. Hostinger — o domínio

No Render, no serviço **sirpatrick-site**: Settings → Custom Domains → adicione
`seudominio.com.br` e `www.seudominio.com.br`. O Render mostra na tela os valores
exatos — **confira com o que ele mostrar**, porque o IP abaixo é o publicado hoje
e pode mudar.

Na Hostinger: Domínios → seu domínio → DNS / Nameservers → Gerenciar registros.

| Tipo  | Nome (Host) | Aponta para            | TTL   |
|-------|-------------|------------------------|-------|
| A     | `@`         | `216.24.57.1`          | 14400 |
| CNAME | `www`       | `seu-site.onrender.com`| 14400 |

O que evita a maior parte dos problemas:

- **Apague antes** qualquer A ou CNAME anterior para `@` e `www` — a Hostinger
  costuma deixar um apontando para a hospedagem dela, e dois registros para o
  mesmo nome fazem o domínio abrir ora um site, ora outro.
- Nada de A para `www`, nem CNAME para `@`: CNAME na raiz quebra o e-mail do
  domínio.
- Se o e-mail do domínio está na Hostinger, **não mexa** nos MX nem no TXT do SPF
  (só acrescente os do Resend).

### O certificado HTTPS

O Render emite sozinho pela Let's Encrypt assim que o DNS aponta para ele.

1. 🖐 Em Custom Domains, os dois domínios precisam ficar **Verified** e o
   certificado **Issued**. Costuma levar de 10 minutos a 1 hora.
2. Travou em "Verifying"? Confira com `nslookup seudominio.com.br` se o IP
   respondido é o do Render.
3. 🖐 Se houver proxy (Cloudflare laranja), desligue até o certificado sair.
4. 🖐 Com o domínio final de pé, volte e atualize:
   - Supabase → Authentication → URL Configuration (Site URL e Redirect URLs)
   - Render → `ORIGEM_PERMITIDA` na API
   - `public/index.html`: o `canonical` e as `og:url`/`og:image`, que ainda
     apontam para o endereço antigo da Vercel

---

## 8. O celular do Patrick — iPhone

Ele usa um iPhone recente, então Web Push funciona — **mas só com o painel
adicionado à tela de início**. Como aba comum do Safari, a notificação não chega:
sem erro, sem aviso, simplesmente não chega.

🖐 O caminho, no aparelho dele:

1. Safari → `https://seudominio.com.br/admin/`
2. Entrar com a conta dele
3. Botão **Compartilhar** → **Adicionar à Tela de Início**
4. Fechar o Safari e abrir **pelo ícone**
5. No painel, tocar em **Ativar avisos** e autorizar

A tela detecta iPhone fora da tela de início e mostra esse passo a passo em vez
de um botão que não funcionaria. Conferência:

```sql
select u.email, count(*) from public.push_assinaturas a
  join auth.users u on u.id = a.user_id group by 1;
```

Se um dia ele trocar por um aparelho mais antigo (abaixo do iOS 16.4), Web Push
deixa de existir para ele — e a saída é um bot do Telegram, que funciona em
qualquer celular e entra como mais um caso dentro de `api/src/notificacoes/`.

---

## 9. Teste de ponta a ponta

Com tudo no ar, numa aba anônima:

1. Criar conta de cliente → confirmar o e-mail → entrar.
2. Pedir um horário → cai em `/agenda/enviado.html`, dizendo **aguardando** (a
   palavra "confirmado" não pode aparecer nessa tela).
3. Conferir a fila:
   ```sql
   select tipo, destino, status, tentativas, erro from notificacoes order by criado_em desc limit 5;
   ```
   Em até 30 segundos a linha precisa virar `enviada`.
4. O celular do Patrick recebe o push. Confirmar pelo botão da notificação.
5. O cliente recebe o e-mail de confirmação.
6. Em `/agenda/minha-conta.html`, cancelar → o horário volta na hora para a
   grade (confira recarregando a agenda em outra aba).
7. No painel: gravar um encaixe e um bloqueio, e conferir que os dois somem da
   grade do cliente.
8. Deixar um pedido pendente vencer (ou baixar `prazo_resposta_h` para 1 e
   forjar um `criado_em` antigo) e conferir que `resolver_pedidos_vencidos()`
   resolve sozinho em até dez minutos.

---

## 10. Quando mexer no código

`git push` na branch conectada: o Static Site republica em segundos e a API
reconstrói em um ou dois minutos. Durante a reconstrução da API o site continua
no ar — só as escritas ficam indisponíveis por alguns segundos.

O que **não** usar, e por quê:

- **Postgres no Render**: o gratuito expira 30 dias depois de criado e apaga os
  dados. O banco é o Supabase.
- **Cron job no Render**: não existe no plano gratuito. As rotinas ficam no
  pg_cron do Supabase.
- **Um segundo Web Service gratuito**: divide as 750 horas com a API.
