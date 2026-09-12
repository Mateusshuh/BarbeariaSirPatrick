-- =============================================================================
-- 003 — expiração de pedidos, lembrete e tempo real
-- =============================================================================

  alter table public.agendamentos
  add column if not exists lembrete_em timestamptz;


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

  v_novo := case when v_acao = 'recusar' then 'recusado' else 'confirmado' end;


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


revoke all on function public.resolver_pendentes_vencidos() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- O agendador
-- -----------------------------------------------------------------------------
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('resolver-pendentes');
exception when others then
  null;  
end $$;

select cron.schedule(
  'resolver-pendentes',
  '*/10 * * * *',
  $cron$ select public.resolver_pendentes_vencidos() $cron$
);

-- -----------------------------------------------------------------------------
-- Tempo real para o painel
-- -----------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.agendamentos;
exception when duplicate_object then
  null;
end $$;
