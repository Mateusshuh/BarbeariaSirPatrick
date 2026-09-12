-- =============================================================================
-- 004 — a arquitetura com API: caixa de saída e fechamento das portas
-- =============================================================================
-- -----------------------------------------------------------------------------
-- 1. Caixa de saída
-- -----------------------------------------------------------------------------

create table if not exists public.notificacoes (
  id              uuid primary key default gen_random_uuid(),
  tipo            text not null
                  check (tipo in ('novo_pedido','resposta','lembrete')),
  agendamento_id  uuid not null references public.agendamentos(id) on delete cascade,
  destino         text not null check (destino in ('patrick','cliente')),
  status          text not null default 'pendente'
                  check (status in ('pendente','enviada','falhou')),
  tentativas      int not null default 0,
  erro            text,
  criado_em       timestamptz not null default now(),
  enviada_em      timestamptz
);


create index if not exists notificacoes_fila on public.notificacoes (criado_em)
  where status = 'pendente';

-- -----------------------------------------------------------------------------
-- 2. Quem enfileira
-- -----------------------------------------------------------------------------

create or replace function public.enfileirar_notificacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then

    if new.status = 'pendente' then
      insert into public.notificacoes (tipo, agendamento_id, destino)
      values ('novo_pedido', new.id, 'patrick');
    end if;
    return new;
  end if;


  if new.status is distinct from old.status
     and old.status in ('pendente','confirmado')
     and new.status in ('confirmado','recusado','cancelado')
     and new.cliente_id is not null then
    insert into public.notificacoes (tipo, agendamento_id, destino)
    values ('resposta', new.id, 'cliente');
  end if;

  return new;
end;
$$;

drop trigger if exists ao_agendar_notificar on public.agendamentos;
create trigger ao_agendar_notificar
  after insert or update of status on public.agendamentos
  for each row execute function public.enfileirar_notificacao();

-- -----------------------------------------------------------------------------
-- 3. Expiração
-- -----------------------------------------------------------------------------

create or replace function public.resolver_pedidos_vencidos()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_h    int;
  v_novo text;
  v_n    int;
begin
  v_h := public.config_int('prazo_resposta_h', 12);

  v_novo := case when lower(public.configuracao('acao_ao_expirar','confirmar')) = 'recusar'
                 then 'recusado' else 'confirmado' end;

  with vencidos as (
    select id from public.agendamentos
     where status = 'pendente'
       and least(criado_em + make_interval(hours => v_h), lower(periodo)) <= now()
     for update skip locked
  )
  update public.agendamentos a
     set status = v_novo,
         motivo_recusa = case when v_novo = 'recusado'
           then coalesce(a.motivo_recusa, 'Sem resposta no prazo') else a.motivo_recusa end
    from vencidos v
   where a.id = v.id;

  get diagnostics v_n = row_count;

  with meio as (
    update public.agendamentos
       set lembrete_em = now()
     where status = 'pendente'
       and lembrete_em is null
       and now() >= criado_em
                  + (least(criado_em + make_interval(hours => v_h), lower(periodo)) - criado_em) / 2
    returning id
  )
  insert into public.notificacoes (tipo, agendamento_id, destino)
  select 'lembrete', id, 'patrick' from meio;

  return v_n;
end;
$$;


revoke all on function public.resolver_pedidos_vencidos() from public, anon, authenticated;


drop function if exists public.resolver_pendentes_vencidos();

do $$
begin
  perform cron.unschedule('resolver-pendentes');
exception when others then
  null;
end $$;

select cron.schedule(
  'resolver-pendentes',
  '*/10 * * * *',
  $cron$ select public.resolver_pedidos_vencidos() $cron$
);

-- -----------------------------------------------------------------------------
-- 4. Fechando as portas de escrita do navegador
-- -----------------------------------------------------------------------------

alter table public.notificacoes enable row level security;

revoke all on public.notificacoes from anon, authenticated;


drop policy if exists "gerencia as proprias assinaturas" on public.push_assinaturas;
revoke all on public.push_assinaturas from anon, authenticated;


drop policy if exists "cliente pede para si" on public.agendamentos;


drop policy if exists "cria o proprio perfil" on public.perfis;

drop policy if exists "cliente so cancela" on public.agendamentos;
create policy "cliente so cancela"
  on public.agendamentos for update to authenticated
  using (cliente_id = auth.uid() and status in ('pendente','confirmado'))
  with check (cliente_id = auth.uid() and status = 'cancelado');

-- -----------------------------------------------------------------------------
-- 5. Sem vitrine pública
-- -----------------------------------------------------------------------------

drop function if exists public.proximos_horarios_publicos();

-- -----------------------------------------------------------------------------
-- 6. A grade também responde à API
-- -----------------------------------------------------------------------------

create or replace function public.horarios_disponiveis(p_data date, p_servico uuid)
returns setof timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  tz       constant text := 'America/Sao_Paulo';
  v_dur    int;
  v_passo  int;
  v_antec  int;
  v_janela int;
  v_exp    public.expediente%rowtype;
  v_abre   timestamptz;
  v_fecha  timestamptz;
  v_almoco tstzrange;
  v_hoje   date := (now() at time zone tz)::date;
begin
  if auth.uid() is null and current_user in ('anon', 'authenticated') then
    raise exception 'É preciso ter uma conta para ver os horários.'
      using errcode = '42501';
  end if;

  select duracao_min into v_dur
    from public.servicos where id = p_servico and ativo;
  if v_dur is null then
    return;  
  end if;

  v_passo  := greatest(public.config_int('passo_grade_min', 30), 5);
  v_antec  := public.config_int('antecedencia_min_min', 60);
  v_janela := public.config_int('janela_dias', 30);

  if p_data < v_hoje or p_data > v_hoje + v_janela then
    return;
  end if;

  select * into v_exp
    from public.expediente where dia_semana = extract(dow from p_data)::int;
  if not found or not v_exp.aberto then
    return;
  end if;

  v_abre  := (p_data + v_exp.abre)  at time zone tz;
  v_fecha := (p_data + v_exp.fecha) at time zone tz;

  if v_exp.intervalo_inicio is not null then
    v_almoco := tstzrange((p_data + v_exp.intervalo_inicio) at time zone tz,
                          (p_data + v_exp.intervalo_fim)    at time zone tz, '[)');
  else
    v_almoco := 'empty'::tstzrange;
  end if;

  return query
  select s.inicio
  from generate_series(
         v_abre,
         v_fecha - make_interval(mins => v_dur),
         make_interval(mins => v_passo)
       ) as s(inicio)
  where
    s.inicio >= now() + make_interval(mins => v_antec)
    and not (tstzrange(s.inicio, s.inicio + make_interval(mins => v_dur), '[)') && v_almoco)
    and not exists (
      select 1 from public.bloqueios b
      where tstzrange(b.inicio, b.fim, '[)')
         && tstzrange(s.inicio, s.inicio + make_interval(mins => v_dur), '[)')
    )
    and not exists (
      select 1 from public.agendamentos a
      where a.status in ('pendente','confirmado')
        and a.periodo && tstzrange(s.inicio, s.inicio + make_interval(mins => v_dur), '[)')
    )
  order by s.inicio;
end;
$$;

revoke all on function public.horarios_disponiveis(date, uuid) from public, anon;
grant execute on function public.horarios_disponiveis(date, uuid) to authenticated;
