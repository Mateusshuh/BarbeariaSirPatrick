-- =============================================================================
-- Barbearia Sir. Patrick — testes da Fase A (arquitetura com API)
-- =============================================================================

drop table if exists public.teste_resultados;
create table public.teste_resultados (
  n        int primary key,
  teste    text,
  esperado text,
  obtido   text,
  passou   boolean generated always as (esperado = obtido) stored
);

drop table if exists public.teste_fixtures;
create table public.teste_fixtures (chave text primary key, valor text);

grant all on public.teste_resultados, public.teste_fixtures to anon, authenticated;

create or replace function public.teste_reg(p_n int, p_teste text, p_esperado text, p_obtido text)
returns void language sql as $$
  insert into public.teste_resultados (n, teste, esperado, obtido)
  values (p_n, p_teste, p_esperado, p_obtido)
  on conflict (n) do update set teste = excluded.teste,
                                esperado = excluded.esperado,
                                obtido = excluded.obtido;
$$;

-- -----------------------------------------------------------------------------
-- Preparação
-- -----------------------------------------------------------------------------
delete from public.notificacoes
 where agendamento_id in (select id from public.agendamentos
                           where cliente_id in ('11111111-1111-1111-1111-111111111111',
                                                '22222222-2222-2222-2222-222222222222'));
delete from public.agendamentos
 where cliente_id in ('11111111-1111-1111-1111-111111111111',
                      '22222222-2222-2222-2222-222222222222')
    or observacao = 'TESTE';
delete from auth.users
 where id in ('11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222');

insert into auth.users
  (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ana.teste@exemplo.com', 'sem-login', now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"nome":"Ana Teste","telefone":"55999990001"}'::jsonb, now(), now()),
  ('22222222-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'bruno.teste@exemplo.com', 'sem-login', now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"nome":"Bruno Teste","telefone":"55999990002"}'::jsonb, now(), now());

do $$
declare
  v_dono  text := current_user;
  v_serv  uuid;
  v_dia   date;
  v_slots timestamptz[];
begin
  select id into v_serv from public.servicos where ativo order by ordem limit 1;

  select min(d)::date into v_dia
    from generate_series(current_date + 1, current_date + 20, interval '1 day') d
   where extract(dow from d)::int in (select dia_semana from public.expediente where aberto);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

  select array_agg(h order by h) into v_slots
    from (select h from public.horarios_disponiveis(v_dia, v_serv) h order by h limit 3) x(h);

  perform set_config('role', v_dono, true);

  if v_slots is null or array_length(v_slots, 1) < 3 then
    raise exception 'Preparação falhou: o dia % não tem três horários livres. Confira o expediente.', v_dia;
  end if;

  insert into public.teste_fixtures (chave, valor) values
    ('servico', v_serv::text), ('dia', v_dia::text),
    ('slot1', v_slots[1]::text), ('slot2', v_slots[2]::text), ('slot3', v_slots[3]::text);

  insert into public.agendamentos (cliente_id, nome, telefone, servico_id, periodo, observacao)
  values ('11111111-1111-1111-1111-111111111111', 'Ana Teste', '55999990001',
          v_serv, tstzrange(v_slots[1], v_slots[1] + interval '5 min', '[)'), 'TESTE');
end $$;

-- -----------------------------------------------------------------------------
-- 0a — horarios_disponiveis como anon: negado
-- -----------------------------------------------------------------------------
do $$
declare v_dono text := current_user; v_res text := 'respondeu (!)'; v_serv uuid; v_dia date;
begin
  select valor::uuid into v_serv from public.teste_fixtures where chave = 'servico';
  select valor::date into v_dia  from public.teste_fixtures where chave = 'dia';
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.horarios_disponiveis(v_dia, v_serv);
  exception when others then v_res := sqlstate;
  end;
  perform set_config('role', v_dono, true);
  perform public.teste_reg(1, '0a · grade de horários sem conta', '42501', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- 0b — horarios_disponiveis como cliente logado: devolve horários
-- -----------------------------------------------------------------------------
do $$
declare v_dono text := current_user; v_n int; v_serv uuid; v_dia date;
begin
  select valor::uuid into v_serv from public.teste_fixtures where chave = 'servico';
  select valor::date into v_dia  from public.teste_fixtures where chave = 'dia';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  select count(*) into v_n from public.horarios_disponiveis(v_dia, v_serv);
  perform set_config('role', v_dono, true);
  perform public.teste_reg(2, '0b · grade de horários com conta',
    'mais de zero', case when v_n > 0 then 'mais de zero' else 'zero' end);
end $$;

-- -----------------------------------------------------------------------------
-- 0c — a vitrine pública não existe (decisão de projeto)
-- -----------------------------------------------------------------------------
do $$
declare v_n int;
begin
  select count(*) into v_n from pg_proc
   where proname = 'proximos_horarios_publicos'
     and pronamespace = 'public'::regnamespace;
  perform public.teste_reg(3, '0c · nenhuma função aberta para anon', '0 funções', v_n || ' funções');
end $$;

-- -----------------------------------------------------------------------------
-- 0d — ler servicos, expediente e configuracoes como anon: vazio
-- -----------------------------------------------------------------------------
do $$
declare v_dono text := current_user; v_s int; v_e int; v_c int;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  select count(*) into v_s from public.servicos;
  select count(*) into v_e from public.expediente;
  select count(*) into v_c from public.configuracoes;
  perform set_config('role', v_dono, true);
  perform public.teste_reg(4, '0d · anon lê serviços/expediente/configurações',
    '0/0/0', v_s || '/' || v_e || '/' || v_c);
end $$;

-- -----------------------------------------------------------------------------
-- 0e — cadastro cria a linha em perfis com papel 'cliente'
-- -----------------------------------------------------------------------------
do $$
declare v_papel text; v_nome text; v_tel text;
begin
  select papel, nome, telefone into v_papel, v_nome, v_tel
    from public.perfis where id = '11111111-1111-1111-1111-111111111111';
  perform public.teste_reg(5, '0e · gatilho do cadastro cria o perfil',
    'cliente / Ana Teste / 55999990001',
    coalesce(v_papel,'sem perfil') || ' / ' || coalesce(v_nome,'-') || ' / ' || coalesce(v_tel,'-'));
end $$;

-- -----------------------------------------------------------------------------
-- 1 — Dois pedidos no mesmo horário: o segundo falha com 23P01
-- -----------------------------------------------------------------------------
do $$
declare v_res text := 'gravou (!)'; v_serv uuid; v_slot timestamptz;
begin
  select valor::uuid        into v_serv from public.teste_fixtures where chave = 'servico';
  select valor::timestamptz into v_slot from public.teste_fixtures where chave = 'slot1';
  begin
    -- como a API grava: dono do banco, RLS ignorada. Quem barra é a constraint.
    insert into public.agendamentos (cliente_id, nome, telefone, servico_id, periodo, observacao)
    values ('22222222-2222-2222-2222-222222222222', 'Bruno Teste', '55999990002',
            v_serv, tstzrange(v_slot, v_slot + interval '5 min', '[)'), 'TESTE');
  exception when others then v_res := sqlstate;
  end;
  perform public.teste_reg(6, '1 · dois pedidos no mesmo horário', '23P01', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- 2 — Dois pedidos do mesmo cliente no mesmo dia: o segundo falha com 23505
-- -----------------------------------------------------------------------------
do $$
declare v_res text := 'gravou (!)'; v_serv uuid; v_slot timestamptz;
begin
  select valor::uuid        into v_serv from public.teste_fixtures where chave = 'servico';
  select valor::timestamptz into v_slot from public.teste_fixtures where chave = 'slot2';
  begin
    insert into public.agendamentos (cliente_id, nome, telefone, servico_id, periodo, observacao)
    values ('11111111-1111-1111-1111-111111111111', 'Ana Teste', '55999990001',
            v_serv, tstzrange(v_slot, v_slot + interval '5 min', '[)'), 'TESTE');
  exception when others then v_res := sqlstate;
  end;
  perform public.teste_reg(7, '2 · mesmo cliente, dois pedidos no mesmo dia', '23505', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- 3 — Recusar um e pedir outro no mesmo dia: passa
-- -----------------------------------------------------------------------------
do $$
declare v_res text; v_serv uuid; v_slot timestamptz;
begin
  select valor::uuid        into v_serv from public.teste_fixtures where chave = 'servico';
  select valor::timestamptz into v_slot from public.teste_fixtures where chave = 'slot2';

  update public.agendamentos set status = 'recusado'
   where cliente_id = '11111111-1111-1111-1111-111111111111' and status = 'pendente';

  begin
    insert into public.agendamentos (cliente_id, nome, telefone, servico_id, periodo, observacao)
    values ('11111111-1111-1111-1111-111111111111', 'Ana Teste', '55999990001',
            v_serv, tstzrange(v_slot, v_slot + interval '5 min', '[)'), 'TESTE');
    v_res := 'gravou';
  exception when others then v_res := sqlstate;
  end;
  perform public.teste_reg(8, '3 · recusado libera a vaga do dia', 'gravou', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- 4 — Ler agendamentos como anon: vazio
-- -----------------------------------------------------------------------------
do $$
declare v_dono text := current_user; v_n int;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  select count(*) into v_n from public.agendamentos;
  perform set_config('role', v_dono, true);
  perform public.teste_reg(9, '4 · anon lê agendamentos', '0 linhas', v_n || ' linhas');
end $$;

-- -----------------------------------------------------------------------------
-- 4b — Cliente gravando agendamento direto pelo navegador: recusado
-- -----------------------------------------------------------------------------

do $$
declare v_dono text := current_user; v_res text := 'gravou (!)'; v_serv uuid; v_slot timestamptz;
begin
  select valor::uuid        into v_serv from public.teste_fixtures where chave = 'servico';
  select valor::timestamptz into v_slot from public.teste_fixtures where chave = 'slot3';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  begin
    insert into public.agendamentos (cliente_id, nome, telefone, servico_id, periodo, observacao)
    values ('22222222-2222-2222-2222-222222222222', 'Bruno', '55999990002',
            v_serv, tstzrange(v_slot, v_slot + interval '5 min', '[)'), 'TESTE');
  exception when others then v_res := sqlstate;
  end;
  perform set_config('role', v_dono, true);
  perform public.teste_reg(10, '4b · cliente grava agendamento pelo navegador', '42501', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- 5 — Cliente mudando o próprio papel para admin: recusado
-- -----------------------------------------------------------------------------
do $$
declare v_dono text := current_user; v_res text := 'virou admin (!)';
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  begin
    update public.perfis set papel = 'admin' where id = '11111111-1111-1111-1111-111111111111';
  exception when others then v_res := sqlstate;
  end;
  perform set_config('role', v_dono, true);
  perform public.teste_reg(11, '5 · cliente se promove a admin', '42501', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- 6 — Cliente confirmando o próprio pedido: recusado
-- -----------------------------------------------------------------------------
do $$
declare v_dono text := current_user; v_res text := 'confirmou (!)';
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  begin
    update public.agendamentos set status = 'confirmado'
     where cliente_id = '11111111-1111-1111-1111-111111111111' and status = 'pendente';
  exception when others then v_res := sqlstate;
  end;
  perform set_config('role', v_dono, true);
  perform public.teste_reg(12, '6 · cliente confirma o próprio pedido', '42501', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- 7 — Inserir pedido enfileira aviso para o Patrick
-- -----------------------------------------------------------------------------
do $$
declare v_n int; v_id uuid;
begin
  select id into v_id from public.agendamentos
   where cliente_id = '11111111-1111-1111-1111-111111111111' and status = 'pendente'
   order by criado_em desc limit 1;

  select count(*) into v_n from public.notificacoes
   where agendamento_id = v_id and destino = 'patrick' and tipo = 'novo_pedido';

  perform public.teste_reg(13, '7 · pedido novo enfileira aviso ao Patrick', '1 linha', v_n || ' linha');
end $$;

-- -----------------------------------------------------------------------------
-- 8 — Confirmar enfileira aviso para o cliente
-- -----------------------------------------------------------------------------
do $$
declare v_n int; v_id uuid;
begin
  select id into v_id from public.agendamentos
   where cliente_id = '11111111-1111-1111-1111-111111111111' and status = 'pendente'
   order by criado_em desc limit 1;

  -- como a API confirma: a condição vai no where, não numa leitura antes
  update public.agendamentos set status = 'confirmado', respondido_em = now()
   where id = v_id and status = 'pendente';

  select count(*) into v_n from public.notificacoes
   where agendamento_id = v_id and destino = 'cliente' and tipo = 'resposta';

  perform public.teste_reg(14, '8 · confirmação enfileira aviso ao cliente', '1 linha', v_n || ' linha');
end $$;

-- -----------------------------------------------------------------------------
-- 9 — Pendente vencido: a rotina resolve e enfileira
-- -----------------------------------------------------------------------------
do $$
declare
  v_serv   uuid;
  v_id     uuid;
  v_status text;
  v_n      int;
begin
  select valor::uuid into v_serv from public.teste_fixtures where chave = 'servico';

  -- Este bloco grava como dono, e não como cliente. O bloco anterior restaurou
  -- o role mas deixou o claim de JWT para trás: sem limpar, auth.uid() ainda
  -- devolve a Ana, a validação de grade liga, e o horário de 100 dias à frente
  -- é recusado por estar fora da janela de 30 dias.
  perform set_config('request.jwt.claims', '', true);

  insert into public.agendamentos
    (cliente_id, nome, telefone, servico_id, periodo, criado_em, observacao)
  values ('22222222-2222-2222-2222-222222222222', 'Bruno Teste', '55999990002', v_serv,
          tstzrange(date_trunc('hour', now()) + interval '100 days',
                    date_trunc('hour', now()) + interval '100 days' + interval '5 min', '[)'),
          now() - interval '13 hours', 'TESTE')
  returning id into v_id;

  perform public.resolver_pedidos_vencidos();

  select status into v_status from public.agendamentos where id = v_id;
  select count(*) into v_n from public.notificacoes
   where agendamento_id = v_id and destino = 'cliente';

  perform public.teste_reg(15, '9 · pendente vencido é resolvido e avisado',
    'confirmado / 1 aviso', coalesce(v_status,'sumiu') || ' / ' || v_n || ' aviso');
end $$;

-- -----------------------------------------------------------------------------
-- 10 — Cliente logado lendo a fila de notificações: vazio
-- -----------------------------------------------------------------------------
do $$
declare v_dono text := current_user; v_res text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  begin
    perform count(*) from public.notificacoes;
    v_res := 'leu (!)';
  exception when others then v_res := 'negado';
  end;
  perform set_config('role', v_dono, true);
  perform public.teste_reg(16, '10 · cliente lê a fila de notificações', 'negado', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- Limpeza
-- -----------------------------------------------------------------------------
delete from public.notificacoes
 where agendamento_id in (select id from public.agendamentos where observacao = 'TESTE');
delete from public.agendamentos where observacao = 'TESTE';
delete from public.agendamentos
 where cliente_id in ('11111111-1111-1111-1111-111111111111',
                      '22222222-2222-2222-2222-222222222222');
delete from auth.users
 where id in ('11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222');
drop table if exists public.teste_fixtures;
drop function if exists public.teste_reg(int, text, text, text);

select n, teste, esperado, obtido, passou
  from public.teste_resultados
 order by n;
