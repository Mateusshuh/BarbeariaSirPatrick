-- =============================================================================
-- 003 — expiração de pedidos, lembrete e tempo real
-- =============================================================================
-- Rode depois da 002.
--
-- NOTA DE LEITURA: este arquivo foi escrito quando o envio de notificações
-- sairia de uma Edge Function acionada por Database Webhook. A 004 trocou esse
-- desenho por uma caixa de saída (tabela notificacoes) consumida pela API no
-- Render, e substitui a rotina daqui. Rode este arquivo mesmo assim: a coluna
-- lembrete_em e a publicação de tempo real continuam valendo.
--
-- O ponto frágil do fluxo inteiro: o Patrick está cortando cabelo, o celular
-- está no bolso, e o cliente fica sem saber se tem horário enquanto a vaga fica
-- presa. Quem resolve isso é uma rotina no banco, não uma tela aberta.
--
-- Como o aviso sai daqui sem nenhuma chave dentro do banco: esta rotina só
-- MUDA a linha. É o Database Webhook de UPDATE em agendamentos (configurado no
-- painel do Supabase) que chama a Edge Function. Guardar a service_role dentro
-- do Postgres para ele mesmo chamar a função seria uma credencial a mais
-- circulando, sem nenhuma vantagem.
-- =============================================================================

-- Marca de que o lembrete de meio de prazo já foi mandado. A própria escrita
-- desta coluna é o que dispara o webhook do lembrete — nenhuma outra coisa na
-- linha muda, e a Edge Function sabe ler essa diferença.
alter table public.agendamentos
  add column if not exists lembrete_em timestamptz;

-- -----------------------------------------------------------------------------
-- A rotina
-- -----------------------------------------------------------------------------
create or replace function public.resolver_pendentes_vencidos()
returns table (expirados int, lembrados int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acao  text;
  v_h     int;
  v_novo  text;
begin
  v_acao := lower(public.configuracao('acao_ao_expirar', 'confirmar'));
  v_h    := public.config_int('prazo_resposta_h', 12);

  -- Padrão: o silêncio vale como sim. O cliente nunca fica no vácuo, e se o
  -- Patrick não puder atender ele cancela — mesmo trabalho, mas o ônus fica com
  -- quem não respondeu.
  v_novo := case when v_acao = 'recusar' then 'recusado' else 'confirmado' end;

  -- 1. Pendentes vencidos.
  -- O prazo é o configurado, SEMPRE limitado pelo horário do corte: um pedido
  -- para daqui a três horas não pode esperar doze. Vale o menor dos dois.
  with vencidos as (
    select id
      from public.agendamentos
     where status = 'pendente'
       and least(criado_em + make_interval(hours => v_h), lower(periodo)) <= now()
     for update skip locked
  )
  update public.agendamentos a
     set status = v_novo,
         motivo_recusa = case
           when v_novo = 'recusado'
             then coalesce(a.motivo_recusa, 'Sem resposta no prazo')
           else a.motivo_recusa
         end
    from vencidos v
   where a.id = v.id;

  get diagnostics expirados = row_count;

  -- 2. Lembrete na metade do prazo.
  update public.agendamentos
     set lembrete_em = now()
   where status = 'pendente'
     and lembrete_em is null
     and now() >= criado_em
                + (least(criado_em + make_interval(hours => v_h), lower(periodo)) - criado_em) / 2;

  get diagnostics lembrados = row_count;

  return next;
end;
$$;

-- Só o dono e o agendador chamam isso. Nenhum navegador, nunca.
revoke all on function public.resolver_pendentes_vencidos() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- O agendador
-- -----------------------------------------------------------------------------
-- Se este create extension falhar por permissão, ligue pg_cron no painel:
-- Database → Extensions → pg_cron. Depois rode só o bloco do cron.schedule.
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('resolver-pendentes');
exception when others then
  null;  -- não existia ainda
end $$;

select cron.schedule(
  'resolver-pendentes',
  '*/10 * * * *',
  $cron$ select public.resolver_pendentes_vencidos() $cron$
);

-- -----------------------------------------------------------------------------
-- Tempo real para o painel
-- -----------------------------------------------------------------------------
-- Com a aba do painel aberta, o pedido aparece na hora. Vale para o computador
-- da barbearia; para o celular no bolso, quem serve é o push.
-- A RLS continua valendo aqui: o cliente assinando este canal receberia apenas
-- o que já pode ler.
do $$
begin
  alter publication supabase_realtime add table public.agendamentos;
exception when duplicate_object then
  null;
end $$;
