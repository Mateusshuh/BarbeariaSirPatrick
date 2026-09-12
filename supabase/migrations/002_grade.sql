-- =============================================================================
-- 002 — o que a tela do cliente precisa do banco
-- =============================================================================
-- Rode depois da 001. Duas coisas:
--   1. dias_disponiveis(): o calendário precisa saber, de uma vez, quais dias
--      do mês ainda têm vaga. Sem isso o navegador faria trinta chamadas para
--      pintar um mês, ou leria a tabela de agendamentos — que é justamente o
--      que não pode.
--   2. a regra exige_email_verificado, que estava na tabela de configurações
--      sem ninguém para aplicá-la.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Varredura do mês
-- -----------------------------------------------------------------------------
-- Devolve uma linha por dia do intervalo, dizendo se a barbearia abre naquele
-- dia da semana e quantos horários ainda cabem. O navegador usa isso para
-- pintar o calendário: 0 vaga com a loja aberta é "lotado" (riscado), loja
-- fechada é "apagado". São coisas diferentes e a pessoa percebe a diferença.
create or replace function public.dias_disponiveis(
  p_inicio  date,
  p_fim     date,
  p_servico uuid
)
returns table (dia date, aberto boolean, vagas int)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_janela int;
  v_hoje   date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if auth.uid() is null then
    raise exception 'É preciso ter uma conta para ver a agenda.' using errcode = '42501';
  end if;

  v_janela := public.config_int('janela_dias', 30);

  -- Nunca responde por um intervalo maior do que a janela configurada, mesmo
  -- que o navegador peça: a janela é regra de negócio, não sugestão.
  p_inicio := greatest(p_inicio, v_hoje);
  p_fim    := least(p_fim, v_hoje + v_janela);
  if p_fim < p_inicio then
    return;
  end if;

  return query
  select d::date,
         coalesce(e.aberto, false),
         (select count(*) from public.horarios_disponiveis(d::date, p_servico))::int
    from generate_series(p_inicio, p_fim, interval '1 day') d
    left join public.expediente e on e.dia_semana = extract(dow from d)::int
   order by d;
end;
$$;

revoke all on function public.dias_disponiveis(date, date, uuid) from public, anon;
grant execute on function public.dias_disponiveis(date, date, uuid) to authenticated;

-- Irmã da config_int, para as configurações que são texto.
create or replace function public.configuracao(p_chave text, p_padrao text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select valor from public.configuracoes where chave = p_chave), p_padrao);
$$;

revoke all on function public.configuracao(text, text) from public, anon;
grant execute on function public.configuracao(text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. E-mail verificado
-- -----------------------------------------------------------------------------
-- A configuração exige_email_verificado existe desde a 001, mas quem a aplica é
-- este gatilho. Poderia ser uma checagem na tela; seria enfeite, porque o
-- console do navegador passa por cima de qualquer checagem de tela.
--
-- A leitura de auth.users só é possível porque a função é security definer.
create or replace function public.normalizar_agendamento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tz         constant text := 'America/Sao_Paulo';
  v_dur      int;
  v_inicio   timestamptz;
  v_nome     text;
  v_tel      text;
  v_verifica boolean;
begin
  select duracao_min into v_dur from public.servicos where id = new.servico_id;
  if v_dur is null then
    raise exception 'Serviço não encontrado.' using errcode = '23503';
  end if;

  v_inicio := lower(new.periodo);
  if v_inicio is null then
    raise exception 'O agendamento precisa de um horário de início.' using errcode = '23514';
  end if;
  -- O fim é sempre a duração do serviço, não o que veio do navegador.
  new.periodo := tstzrange(v_inicio, v_inicio + make_interval(mins => v_dur), '[)');

  if new.origem = 'site' then
    -- Nome e telefone vêm do perfil, não do formulário: o cliente não escolhe
    -- com que nome aparece na fila do Patrick.
    select p.nome, p.telefone into v_nome, v_tel
      from public.perfis p where p.id = new.cliente_id;
    if nullif(trim(coalesce(v_nome, '')), '') is not null then new.nome := v_nome; end if;
    if nullif(trim(coalesce(v_tel,  '')), '') is not null then new.telefone := v_tel; end if;
  end if;

  -- A validação vale para quem está logado como cliente. Sem auth.uid() quem
  -- está gravando é a service_role (Edge Function, rotina do pg_cron, seed):
  -- nesses casos não existe grade a consultar, e a RLS já barrou o anônimo
  -- antes de chegar aqui.
  if tg_op = 'INSERT' and new.origem = 'site'
     and auth.uid() is not null and not public.eh_admin() then

    if new.status <> 'pendente' then
      raise exception 'Pedido feito pelo site nasce pendente.' using errcode = '42501';
    end if;

    if lower(public.configuracao('exige_email_verificado', 'sim')) in ('sim','true','1') then
      select u.email_confirmed_at is not null into v_verifica
        from auth.users u where u.id = new.cliente_id;
      if not coalesce(v_verifica, false) then
        -- Sem errcode: cai no P0001 padrão, que a tela mostra como veio. A
        -- frase já está escrita para o cliente ler.
        raise exception 'Confirme seu e-mail antes de pedir um horário. Abra o link que enviamos para você.';
      end if;
    end if;

    -- O horário precisa existir de verdade na grade daquele dia.
    if not exists (
      select 1
      from public.horarios_disponiveis((v_inicio at time zone tz)::date, new.servico_id) h
      where h = v_inicio
    ) then
      raise exception 'Esse horário não está mais disponível.' using errcode = '23P01';
    end if;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Limite de cancelamentos por mês
-- -----------------------------------------------------------------------------
-- A configuração max_cancelamentos_mes existia sem ninguém para aplicá-la. Ela
-- vale só para o cliente: o Patrick cancela quantas vezes precisar, e a rotina
-- de expiração também.
create or replace function public.limitar_cancelamentos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tz  constant text := 'America/Sao_Paulo';
  v_max int;
  v_n   int;
begin
  if new.status <> 'cancelado' or old.status = 'cancelado' then
    return new;
  end if;
  if auth.uid() is null or public.eh_admin() then
    return new;
  end if;

  v_max := public.config_int('max_cancelamentos_mes', 4);
  if v_max <= 0 then
    return new;   -- zero ou negativo significa "sem limite"
  end if;

  select count(*) into v_n
    from public.agendamentos
   where cliente_id = new.cliente_id
     and status = 'cancelado'
     and id <> new.id
     and coalesce(respondido_em, criado_em)
         >= (date_trunc('month', now() at time zone tz) at time zone tz);

  if v_n >= v_max then
    raise exception
      'Você já cancelou % vezes este mês. Fale com o Patrick pelo WhatsApp para desmarcar este horário.', v_n;
  end if;

  return new;
end;
$$;

drop trigger if exists ao_cancelar_agendamento on public.agendamentos;
create trigger ao_cancelar_agendamento
  before update of status on public.agendamentos
  for each row execute function public.limitar_cancelamentos();
