-- =============================================================================
-- Barbearia Sir. Patrick — migração inicial
-- =============================================================================
-- Este arquivo é a fundação do sistema: tabelas, travas, função de
-- disponibilidade e RLS. A regra que vale para tudo o que vier depois:
-- o navegador desenha e pergunta, o Postgres decide.
--
-- Rode inteiro, de uma vez, no SQL Editor do Supabase.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensões e fuso
-- -----------------------------------------------------------------------------

-- btree_gist permite misturar tipos escalares (=) com intervalos (&&) dentro de
-- uma mesma constraint de exclusão. Hoje a trava usa só o período, mas no dia
-- em que entrar um segundo barbeiro ela vira (barbeiro_id with =, periodo with
-- &&) e a extensão precisa já estar aqui.
create extension if not exists btree_gist;

-- O fuso do banco fica em America/Sao_Paulo por conforto de quem consulta pelo
-- editor. Nenhum código abaixo depende disso: todo lugar que converte instante
-- em data escreve o fuso explicitamente, porque o PostgREST abre a conexão com
-- o fuso dele e não herda este ajuste.
do $$
begin
  execute format('alter database %I set timezone to ''America/Sao_Paulo''', current_database());
exception when insufficient_privilege then
  raise notice 'Sem permissão para fixar o fuso do banco — o código não depende dele.';
end $$;

-- -----------------------------------------------------------------------------
-- 1. Tabelas
-- -----------------------------------------------------------------------------

-- Serviços oferecidos. A duração não é enfeite: ela define o tamanho do bloco
-- na grade e, portanto, o que o cliente consegue marcar.
create table if not exists public.servicos (
  id              uuid primary key default gen_random_uuid(),
  nome            text not null,
  duracao_min     int  not null check (duracao_min > 0 and duracao_min <= 480),
  preco_centavos  int  not null default 0 check (preco_centavos >= 0),
  ativo           boolean not null default true,
  ordem           int  not null default 0,
  criado_em       timestamptz not null default now()
);

-- Expediente de cada dia da semana. dia_semana segue o extract(dow) do
-- Postgres: 0 = domingo ... 6 = sábado. O almoço é opcional, mas as duas
-- colunas andam juntas.
create table if not exists public.expediente (
  dia_semana        int primary key check (dia_semana between 0 and 6),
  abre              time not null,
  fecha             time not null,
  intervalo_inicio  time,
  intervalo_fim     time,
  aberto            boolean not null default true,
  constraint expediente_ordem check (fecha > abre),
  constraint expediente_almoco check (
    (intervalo_inicio is null and intervalo_fim is null)
    or (intervalo_inicio is not null and intervalo_fim is not null
        and intervalo_fim > intervalo_inicio
        and intervalo_inicio >= abre and intervalo_fim <= fecha)
  )
);

-- Férias, feriado, tarde fechada, curso. Qualquer buraco no expediente normal.
create table if not exists public.bloqueios (
  id        uuid primary key default gen_random_uuid(),
  inicio    timestamptz not null,
  fim       timestamptz not null,
  motivo    text,
  criado_em timestamptz not null default now(),
  constraint bloqueio_ordem check (fim > inicio)
);

create index if not exists bloqueios_periodo on public.bloqueios (inicio, fim);

-- Perfil é o vínculo entre a conta do Supabase Auth e os agendamentos.
-- O papel NUNCA é escolhido por quem se cadastra: o gatilho grava 'cliente' e a
-- promoção a admin é feita à mão no painel do Supabase.
create table if not exists public.perfis (
  id         uuid primary key references auth.users(id) on delete cascade,
  nome       text not null,
  telefone   text not null default '',
  papel      text not null default 'cliente' check (papel in ('cliente','admin')),
  criado_em  timestamptz not null default now()
);

-- Tudo que o Patrick regula sem mexer no código. O valor é texto porque a
-- tabela guarda coisas de tipos diferentes; quem lê converte.
create table if not exists public.configuracoes (
  chave         text primary key,
  valor         text not null,
  descricao     text,
  atualizado_em timestamptz not null default now()
);

-- Uma linha por aparelho que autorizou notificação. O mesmo usuário pode ter
-- várias (celular, computador da loja), por isso a chave é (user_id, endpoint).
create table if not exists public.push_assinaturas (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  endpoint  text not null,
  p256dh    text not null,
  auth      text not null,
  criado_em timestamptz not null default now(),
  constraint push_unica unique (user_id, endpoint)
);

-- O centro do sistema.
create table if not exists public.agendamentos (
  id             uuid primary key default gen_random_uuid(),
  cliente_id     uuid references auth.users(id),
  nome           text not null,
  telefone       text not null,
  servico_id     uuid not null references public.servicos(id),

  -- Um intervalo, não duas colunas de data. É o que permite a trava de
  -- sobreposição: o Postgres sabe comparar intervalos sozinho, e não saberia
  -- comparar "inicio e fim" soltos sem alguém escrever a lógica.
  periodo        tstzrange not null,

  -- Calculado pelo banco, no fuso da barbearia. Se isso virasse conta de
  -- JavaScript, um cliente com o relógio em outro fuso quebraria a trava de um
  -- agendamento por dia.
  dia            date generated always as
                   ((lower(periodo) at time zone 'America/Sao_Paulo')::date) stored,

  status         text not null default 'pendente'
                 check (status in ('pendente','confirmado','recusado',
                                   'concluido','cancelado','nao_compareceu')),
  respondido_em  timestamptz,
  motivo_recusa  text,
  observacao     text,
  origem         text not null default 'site'
                 check (origem in ('site','encaixe')),
  criado_em      timestamptz not null default now(),

  -- Pedido pelo site exige conta. Encaixe é o cliente que chegou na porta: o
  -- Patrick digita o nome e pronto, não existe conta por trás.
  constraint conta_obrigatoria check (
    (origem = 'site'    and cliente_id is not null) or
    (origem = 'encaixe' and cliente_id is null)
  )
);

create index if not exists agendamentos_dia     on public.agendamentos (dia);
create index if not exists agendamentos_cliente on public.agendamentos (cliente_id, criado_em desc);
create index if not exists agendamentos_pendentes
  on public.agendamentos (criado_em) where (status = 'pendente');

-- -----------------------------------------------------------------------------
-- 2. As duas travas
-- -----------------------------------------------------------------------------
-- Nenhuma das duas pode viver em JavaScript: entre checar e gravar existe uma
-- fresta de tempo em que outra pessoa grava primeiro. Só o banco fecha isso.

-- Duas pessoas nunca ficam com o mesmo horário.
do $$
begin
  alter table public.agendamentos
    add constraint sem_sobreposicao
    exclude using gist (periodo with &&)
    where (status in ('pendente','confirmado'));
exception when duplicate_table or duplicate_object then
  null;
end $$;

-- Cada cliente, no máximo um agendamento ativo por dia.
create unique index if not exists um_por_dia
  on public.agendamentos (cliente_id, dia)
  where (status in ('pendente','confirmado') and cliente_id is not null);

-- Repare no where das duas: só pendente e confirmado ocupam lugar. Recusar ou
-- cancelar devolve o horário para a grade sozinho, sem nenhuma linha de código.

-- -----------------------------------------------------------------------------
-- 3. Funções auxiliares
-- -----------------------------------------------------------------------------

-- security definer porque as políticas de perfis consultam perfis: sem definer
-- a leitura cairia na própria RLS e entraria em recursão.
create or replace function public.eh_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.perfis
    where id = auth.uid() and papel = 'admin'
  );
$$;

revoke all on function public.eh_admin() from public, anon;
grant execute on function public.eh_admin() to authenticated;

-- Lê uma configuração como inteiro, com padrão para o caso de a linha sumir.
create or replace function public.config_int(p_chave text, p_padrao int)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(regexp_replace(valor, '\D', '', 'g'), '')::int
       from public.configuracoes where chave = p_chave),
    p_padrao);
$$;

revoke all on function public.config_int(text, int) from public, anon;
grant execute on function public.config_int(text, int) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Disponibilidade
-- -----------------------------------------------------------------------------
-- A ÚNICA forma de o navegador saber o que está livre. A tabela agendamentos
-- nunca é lida pelo cliente para montar a grade: a função devolve apenas
-- instantes livres, sem dizer de quem é o horário ocupado nem por quê.
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
  -- security definer roda com os poderes do dono. Sem esta porta, o revoke de
  -- anon lá embaixo seria a única tranca; com ela, são duas.
  if auth.uid() is null then
    raise exception 'É preciso ter uma conta para ver os horários.'
      using errcode = '42501';
  end if;

  select duracao_min into v_dur
    from public.servicos where id = p_servico and ativo;
  if v_dur is null then
    return;  -- serviço inexistente ou desativado: grade vazia, sem erro
  end if;

  v_passo  := greatest(public.config_int('passo_grade_min', 30), 5);
  v_antec  := public.config_int('antecedencia_min_min', 60);
  v_janela := public.config_int('janela_dias', 30);

  -- Passado e além da janela não abrem, nem por link direto.
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
    v_almoco := 'empty'::tstzrange;   -- 'empty' && qualquer coisa dá falso
  end if;

  return query
  select s.inicio
  from generate_series(
         v_abre,
         v_fecha - make_interval(mins => v_dur),  -- o que não cabe antes de fechar nem entra na lista
         make_interval(mins => v_passo)
       ) as s(inicio)
  where
    -- antecedência mínima: ninguém marca para daqui a cinco minutos
    s.inicio >= now() + make_interval(mins => v_antec)
    -- almoço
    and not (tstzrange(s.inicio, s.inicio + make_interval(mins => v_dur), '[)') && v_almoco)
    -- férias, feriado, tarde fechada
    and not exists (
      select 1 from public.bloqueios b
      where tstzrange(b.inicio, b.fim, '[)')
         && tstzrange(s.inicio, s.inicio + make_interval(mins => v_dur), '[)')
    )
    -- horários já tomados: só pendente e confirmado ocupam
    and not exists (
      select 1 from public.agendamentos a
      where a.status in ('pendente','confirmado')
        and a.periodo && tstzrange(s.inicio, s.inicio + make_interval(mins => v_dur), '[)')
    )
  order by s.inicio;
end;
$$;

-- Sem este revoke o security definer deixaria a função aberta para quem não tem
-- conta: o EXECUTE de função nova vai para PUBLIC por padrão.
revoke all on function public.horarios_disponiveis(date, uuid) from public, anon;
grant execute on function public.horarios_disponiveis(date, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Gatilhos
-- -----------------------------------------------------------------------------

-- Cadastro cria o perfil. O papel é escrito na mão como 'cliente': se viesse do
-- options.data do signUp, qualquer pessoa viraria admin no próprio cadastro.
create or replace function public.criar_perfil()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.perfis (id, nome, telefone, papel)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'nome'), ''), 'Cliente'),
    coalesce(nullif(trim(new.raw_user_meta_data->>'telefone'), ''), ''),
    'cliente'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario
  after insert on auth.users
  for each row execute function public.criar_perfil();

-- Normaliza e valida o pedido antes de gravar.
-- O navegador manda só o início; quem decide o fim é a duração do serviço, e
-- quem decide se aquele horário existe é a função de disponibilidade. Assim um
-- cliente com o console aberto não marca dentro do almoço, nem fora do
-- expediente, nem com duração inventada.
create or replace function public.normalizar_agendamento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tz       constant text := 'America/Sao_Paulo';
  v_dur    int;
  v_inicio timestamptz;
  v_nome   text;
  v_tel    text;
begin
  select duracao_min into v_dur from public.servicos where id = new.servico_id;
  if v_dur is null then
    raise exception 'Serviço não encontrado.' using errcode = '23503';
  end if;

  v_inicio := lower(new.periodo);
  if v_inicio is null then
    raise exception 'O agendamento precisa de um horário de início.' using errcode = '23514';
  end if;
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

drop trigger if exists ao_gravar_agendamento on public.agendamentos;
create trigger ao_gravar_agendamento
  before insert or update of periodo, servico_id, cliente_id on public.agendamentos
  for each row execute function public.normalizar_agendamento();

-- Carimba a hora da resposta. Serve para o painel mostrar "respondido em 4 min"
-- e para a rotina de expiração saber quem já foi tratado.
create or replace function public.carimbar_resposta()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('confirmado','recusado','cancelado','concluido','nao_compareceu') then
    new.respondido_em := coalesce(new.respondido_em, now());
  end if;
  return new;
end;
$$;

drop trigger if exists ao_responder_agendamento on public.agendamentos;
create trigger ao_responder_agendamento
  before update of status on public.agendamentos
  for each row execute function public.carimbar_resposta();

-- -----------------------------------------------------------------------------
-- 6. Permissões de tabela e RLS
-- -----------------------------------------------------------------------------
-- O Supabase já concede privilégios por padrão nas tabelas novas do schema
-- public, mas deixar isso implícito é ruim: se um dia o padrão mudar, a agenda
-- quebra sem ninguém entender por quê. Aqui está escrito.
--
-- anon recebe SELECT de propósito, e não recebe nada além disso. Quem barra o
-- visitante é a RLS — assim ele recebe lista vazia, que é o que o front espera,
-- em vez de um erro de permissão que teria de ser tratado em toda tela.

grant usage on schema public to anon, authenticated;

grant select on
  public.servicos, public.expediente, public.bloqueios, public.configuracoes,
  public.perfis, public.agendamentos, public.push_assinaturas
  to anon, authenticated;

grant insert, update, delete on
  public.servicos, public.expediente, public.bloqueios, public.configuracoes,
  public.perfis, public.agendamentos, public.push_assinaturas
  to authenticated;

-- Regra geral: sem conta não se lê NADA. Nem a lista de serviços.

alter table public.servicos         enable row level security;
alter table public.expediente       enable row level security;
alter table public.bloqueios        enable row level security;
alter table public.perfis           enable row level security;
alter table public.configuracoes    enable row level security;
alter table public.push_assinaturas enable row level security;
alter table public.agendamentos     enable row level security;

-- servicos --------------------------------------------------------------------
drop policy if exists "cliente le servicos ativos" on public.servicos;
create policy "cliente le servicos ativos"
  on public.servicos for select to authenticated
  using (ativo or public.eh_admin());

drop policy if exists "admin gerencia servicos" on public.servicos;
create policy "admin gerencia servicos"
  on public.servicos for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- expediente ------------------------------------------------------------------
-- O cliente lê só os dias abertos. Dia sem linha visível é dia fechado: o
-- calendário apaga o que não veio, e ninguém precisa saber o motivo.
drop policy if exists "cliente le expediente aberto" on public.expediente;
create policy "cliente le expediente aberto"
  on public.expediente for select to authenticated
  using (aberto or public.eh_admin());

drop policy if exists "admin gerencia expediente" on public.expediente;
create policy "admin gerencia expediente"
  on public.expediente for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- bloqueios -------------------------------------------------------------------
-- Cliente não lê: férias e compromissos do Patrick não são da conta dele. O
-- efeito dos bloqueios chega ao cliente pela função de disponibilidade.
drop policy if exists "admin gerencia bloqueios" on public.bloqueios;
create policy "admin gerencia bloqueios"
  on public.bloqueios for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- configuracoes ---------------------------------------------------------------
-- O cliente precisa saber o prazo de resposta e o limite de cancelamento.
drop policy if exists "cliente le configuracoes" on public.configuracoes;
create policy "cliente le configuracoes"
  on public.configuracoes for select to authenticated
  using (true);

drop policy if exists "admin gerencia configuracoes" on public.configuracoes;
create policy "admin gerencia configuracoes"
  on public.configuracoes for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- perfis ----------------------------------------------------------------------
drop policy if exists "le o proprio perfil" on public.perfis;
create policy "le o proprio perfil"
  on public.perfis for select to authenticated
  using (id = auth.uid() or public.eh_admin());

-- Rede de segurança: se o gatilho do cadastro falhar, a pessoa ficaria sem
-- perfil e sem poder agendar, sem nenhuma saída pela tela. Ela pode criar o
-- próprio perfil — e só com papel 'cliente'.
drop policy if exists "cria o proprio perfil" on public.perfis;
create policy "cria o proprio perfil"
  on public.perfis for insert to authenticated
  with check (id = auth.uid() and papel = 'cliente');

-- O with check é o que impede a autopromoção: o cliente corrige nome e
-- telefone, mas a linha continua saindo com papel 'cliente'.
drop policy if exists "edita o proprio perfil" on public.perfis;
create policy "edita o proprio perfil"
  on public.perfis for update to authenticated
  using (id = auth.uid() or public.eh_admin())
  with check ((id = auth.uid() and papel = 'cliente') or public.eh_admin());

-- agendamentos ----------------------------------------------------------------
drop policy if exists "cliente pede para si" on public.agendamentos;
create policy "cliente pede para si"
  on public.agendamentos for insert to authenticated
  with check (cliente_id = auth.uid() and origem = 'site'
              and status = 'pendente');

drop policy if exists "cliente le os proprios" on public.agendamentos;
create policy "cliente le os proprios"
  on public.agendamentos for select to authenticated
  using (cliente_id = auth.uid() or public.eh_admin());

-- Cancelar é a ÚNICA alteração que o cliente pode fazer.
-- Sem o with check certo, um cliente logado aprova o próprio pedido pelo
-- console do navegador e a confirmação do Patrick vira enfeite.
drop policy if exists "cliente so cancela" on public.agendamentos;
create policy "cliente so cancela"
  on public.agendamentos for update to authenticated
  using (cliente_id = auth.uid() and status in ('pendente','confirmado'))
  with check (cliente_id = auth.uid() and status = 'cancelado');

drop policy if exists "admin gerencia agendamentos" on public.agendamentos;
create policy "admin gerencia agendamentos"
  on public.agendamentos for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- push_assinaturas ------------------------------------------------------------
-- Cada um cuida das próprias. A Edge Function lê todas com a service_role, que
-- passa por cima da RLS — por isso não existe política de admin aqui.
drop policy if exists "gerencia as proprias assinaturas" on public.push_assinaturas;
create policy "gerencia as proprias assinaturas"
  on public.push_assinaturas for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 7. Conteúdo inicial
-- -----------------------------------------------------------------------------

insert into public.configuracoes (chave, valor, descricao) values
  ('antecedencia_min_min',  '60',        'Minutos mínimos entre agora e o horário marcado'),
  ('janela_dias',           '30',        'Quantos dias à frente a agenda abre'),
  ('passo_grade_min',       '30',        'De quantos em quantos minutos começa um horário'),
  ('prazo_resposta_h',      '12',        'Horas que o Patrick tem para responder um pedido'),
  ('acao_ao_expirar',       'confirmar', 'O que fazer com o pedido vencido: confirmar ou recusar'),
  ('cancelamento_min',      '120',       'Minutos antes do corte em que o cliente ainda pode cancelar'),
  ('max_cancelamentos_mes', '4',         'Cancelamentos permitidos por cliente no mês'),
  ('exige_email_verificado','sim',       'Só deixa pedir horário com e-mail confirmado')
on conflict (chave) do nothing;

-- Expediente de partida. AJUSTE na tela de configurações da Fase 3: estes
-- horários são um chute razoável, não o horário real da loja.
insert into public.expediente (dia_semana, abre, fecha, intervalo_inicio, intervalo_fim, aberto) values
  (0, '09:00', '18:00', null,    null,    false),  -- domingo, fechado
  (1, '09:00', '19:00', '12:00', '13:30', false),  -- segunda, fechado
  (2, '09:00', '19:00', '12:00', '13:30', true),
  (3, '09:00', '19:00', '12:00', '13:30', true),
  (4, '09:00', '19:00', '12:00', '13:30', true),
  (5, '09:00', '19:00', '12:00', '13:30', true),
  (6, '08:00', '17:00', null,    null,    true)    -- sábado, direto
on conflict (dia_semana) do nothing;

-- Os quatro serviços do site. O preço entra pela tela de configurações: no site
-- ele não aparece, e aqui não vou inventar valor.
insert into public.servicos (nome, duracao_min, preco_centavos, ordem)
select * from (values
  ('Corte',         30, 0, 1),
  ('Barba',         30, 0, 2),
  ('Sobrancelha',   15, 0, 3),
  ('Corte + barba', 60, 0, 4)
) as s(nome, duracao_min, preco_centavos, ordem)
where not exists (select 1 from public.servicos);
