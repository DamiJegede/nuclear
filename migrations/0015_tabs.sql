-- Shared tabs (docs/TABS.md). Order state: venue_tables (a table with a QR / NFC code), tabs, tab_members (a wallet on a tab: the consent and the position), tab_items
-- (who ordered what; wallet NULL = the Table) and tab_covers (a member paying for another member or the Table). The money truth stays in `transactions`; a closed tab is
-- frozen. Fund holds (0014) get their foreign key here. Money functions: app_tab_settle (Close My Tab: check and hold a member's funds), app_tab_release (release holds)
-- and app_close_tab (Pay: every payer checked in the same call, nothing written when anyone is short, otherwise one checkout and one `pay` per paying wallet).
-- The allocation of the bill to paying wallets is computed by the API (lib/tabQuote.ts) and passed to app_close_tab, which checks the tab's version under the lock.

CREATE TABLE venue_tables (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  name text NOT NULL CONSTRAINT venue_tables_name_check CHECK (length(name) BETWEEN 1 AND 60),
  code text NOT NULL UNIQUE CONSTRAINT venue_tables_code_check CHECK (length(code) BETWEEN 16 AND 64),
  served_by uuid REFERENCES accounts(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_tables_account_idx ON venue_tables (account_id, created_at, id);
CREATE TRIGGER venue_tables_business_only BEFORE INSERT OR UPDATE OF account_id ON venue_tables FOR EACH ROW EXECUTE FUNCTION public.require_business_account();
CREATE TRIGGER venue_tables_updated_at BEFORE UPDATE ON venue_tables FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE tabs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  table_id uuid REFERENCES venue_tables(id),
  host_wallet_id uuid NOT NULL REFERENCES wallets(id),
  status text NOT NULL DEFAULT 'open' CONSTRAINT tabs_status_check CHECK (status IN ('open', 'paying', 'closed', 'unpaid', 'canceled', 'expired')),
  split_mode text NOT NULL DEFAULT 'own' CONSTRAINT tabs_split_mode_check CHECK (split_mode IN ('own', 'pitch', 'equal', 'host')),
  cover_cap bigint CONSTRAINT tabs_cover_cap_check CHECK (cover_cap IS NULL OR cover_cap > 0),
  version integer NOT NULL DEFAULT 1,
  invite_code text NOT NULL UNIQUE CONSTRAINT tabs_invite_code_check CHECK (length(invite_code) BETWEEN 16 AND 64),
  locked boolean NOT NULL DEFAULT false,
  served_by uuid REFERENCES accounts(id),
  tip_mode text NOT NULL DEFAULT 'none' CONSTRAINT tabs_tip_mode_check CHECK (tip_mode IN ('none', 'percent', 'amount')),
  tip_value bigint NOT NULL DEFAULT 0 CONSTRAINT tabs_tip_value_check CHECK (tip_value >= 0 AND tip_value <= 1000000000),
  opened_at timestamptz NOT NULL DEFAULT now(),
  review_at timestamptz,
  closed_at timestamptz,
  closed_by uuid REFERENCES accounts(id),
  closed_reason text CONSTRAINT tabs_closed_reason_check CHECK (closed_reason IN ('host', 'staff', 'canceled', 'expired')),
  unpaid_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A table holds at most one open or paying tab; closed, unpaid, canceled and expired tabs are off the table.
CREATE UNIQUE INDEX tabs_one_per_table ON tabs (table_id) WHERE table_id IS NOT NULL AND status IN ('open', 'paying');
CREATE INDEX tabs_account_idx ON tabs (account_id, status, created_at DESC, id DESC);
CREATE INDEX tabs_activity_idx ON tabs (last_activity_at) WHERE status IN ('open', 'paying', 'unpaid');
CREATE TRIGGER tabs_business_only BEFORE INSERT OR UPDATE OF account_id ON tabs FOR EACH ROW EXECUTE FUNCTION public.require_business_account();
CREATE TRIGGER tabs_updated_at BEFORE UPDATE ON tabs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE tab_members (
  tab_id uuid NOT NULL REFERENCES tabs(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  max_tip_bps integer NOT NULL DEFAULT 2500 CONSTRAINT tab_members_tip_check CHECK (max_tip_bps BETWEEN 0 AND 10000),
  settled_at timestamptz,
  away_at timestamptz,
  removed_at timestamptz,
  removed_by uuid REFERENCES accounts(id),
  PRIMARY KEY (tab_id, wallet_id)
);
CREATE INDEX tab_members_wallet_idx ON tab_members (wallet_id, joined_at DESC);

CREATE TABLE tab_items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tab_id uuid NOT NULL REFERENCES tabs(id),
  wallet_id uuid REFERENCES wallets(id),
  account_id uuid REFERENCES accounts(id),
  added_by uuid REFERENCES accounts(id),
  product_id uuid REFERENCES products(id),
  name text NOT NULL,
  unit_price bigint NOT NULL CONSTRAINT tab_items_price_check CHECK (unit_price >= 0),
  discount bigint NOT NULL DEFAULT 0 CONSTRAINT tab_items_discount_check CHECK (discount >= 0 AND discount <= unit_price),
  taxable boolean NOT NULL DEFAULT true,
  quantity integer NOT NULL CONSTRAINT tab_items_quantity_check CHECK (quantity BETWEEN 1 AND 1000),
  note text CONSTRAINT tab_items_note_check CHECK (note IS NULL OR length(note) <= 80),
  status text NOT NULL DEFAULT 'ordered' CONSTRAINT tab_items_status_check CHECK (status IN ('ordered', 'void')),
  voided_at timestamptz,
  voided_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tab_items_table_check CHECK ((wallet_id IS NULL) = (account_id IS NULL))
);
CREATE INDEX tab_items_tab_idx ON tab_items (tab_id, created_at, id);

CREATE TABLE tab_covers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tab_id uuid NOT NULL REFERENCES tabs(id),
  covered_wallet_id uuid REFERENCES wallets(id),          -- NULL = the Table
  payer_wallet_id uuid NOT NULL REFERENCES wallets(id),
  cap bigint CONSTRAINT tab_covers_cap_check CHECK (cap IS NULL OR cap > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  declined_at timestamptz,
  ended_at timestamptz,
  CONSTRAINT tab_covers_self_check CHECK (covered_wallet_id IS NULL OR covered_wallet_id <> payer_wallet_id)
);
-- one active coverer per covered person (and one for the Table)
CREATE UNIQUE INDEX tab_covers_active_key ON tab_covers (tab_id, coalesce(covered_wallet_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE declined_at IS NULL AND ended_at IS NULL;
CREATE INDEX tab_covers_payer_idx ON tab_covers (tab_id, payer_wallet_id);

ALTER TABLE checkouts ADD COLUMN tab_id uuid REFERENCES tabs(id);
CREATE INDEX checkouts_tab_idx ON checkouts (tab_id) WHERE tab_id IS NOT NULL;
ALTER TABLE fund_holds ADD CONSTRAINT fund_holds_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES tabs(id);

-- A finished tab (closed, canceled, expired) never changes, and nothing under it does.
CREATE FUNCTION public.tabs_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'tabs are never deleted'; END IF;
  IF OLD.status IN ('closed', 'canceled', 'expired') THEN RAISE EXCEPTION 'a % tab is frozen', OLD.status; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tabs_frozen BEFORE UPDATE OR DELETE ON tabs FOR EACH ROW EXECUTE FUNCTION public.tabs_frozen();

CREATE FUNCTION public.tab_children_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_status text; v_tab uuid;
BEGIN
  v_tab := CASE WHEN TG_OP = 'DELETE' THEN OLD.tab_id ELSE NEW.tab_id END;
  SELECT status INTO v_status FROM public.tabs WHERE id = v_tab;
  IF v_status IN ('closed', 'canceled', 'expired') THEN RAISE EXCEPTION 'a % tab is frozen', v_status; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tab_members_frozen BEFORE INSERT OR UPDATE OR DELETE ON tab_members FOR EACH ROW EXECUTE FUNCTION public.tab_children_frozen();
CREATE TRIGGER tab_items_frozen BEFORE INSERT OR UPDATE OR DELETE ON tab_items FOR EACH ROW EXECUTE FUNCTION public.tab_children_frozen();
CREATE TRIGGER tab_covers_frozen BEFORE INSERT OR UPDATE OR DELETE ON tab_covers FOR EACH ROW EXECUTE FUNCTION public.tab_children_frozen();

-- ---------------------------------------------------------------------------------------------------------------------------------------------------
-- app_tab_release: release active holds and say why. p = {tab_id?, wallet_id?, account_id?, hold_id?, reason}. Holds are taken wallet by wallet in id order. A
-- reason that reopens the member's position (reopened, mode_changed, withdrawn_by_system) clears settled_at; every tab touched gets a new version.
CREATE FUNCTION public.app_tab_release(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_tab uuid := nullif(p ->> 'tab_id', '')::uuid;
  v_wallet uuid := nullif(p ->> 'wallet_id', '')::uuid;
  v_acct uuid := nullif(p ->> 'account_id', '')::uuid;
  v_hold uuid := nullif(p ->> 'hold_id', '')::uuid;
  v_reason text := p ->> 'reason';
  h record; v_n int := 0; v_tabs uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_tab IS NULL AND v_wallet IS NULL AND v_acct IS NULL AND v_hold IS NULL THEN RAISE EXCEPTION 'app_tab_release needs a scope'; END IF;
  FOR h IN SELECT id, wallet_id, tab_id, amount FROM public.fund_holds
            WHERE status = 'active' AND (v_tab IS NULL OR tab_id = v_tab) AND (v_wallet IS NULL OR wallet_id = v_wallet)
              AND (v_acct IS NULL OR account_id = v_acct) AND (v_hold IS NULL OR id = v_hold)
            ORDER BY wallet_id, id FOR NO KEY UPDATE LOOP
    UPDATE public.wallets SET held = held - h.amount WHERE id = h.wallet_id;
    UPDATE public.fund_holds SET status = 'released', ended_at = now(), end_reason = v_reason WHERE id = h.id;
    IF v_reason IN ('reopened', 'mode_changed', 'withdrawn_by_system') THEN
      UPDATE public.tab_members SET settled_at = NULL WHERE tab_id = h.tab_id AND wallet_id = h.wallet_id;
    END IF;
    v_tabs := v_tabs || h.tab_id;
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN
    UPDATE public.tabs SET version = version + 1, last_activity_at = now() WHERE id = ANY (v_tabs) AND status IN ('open', 'paying', 'unpaid');
  END IF;
  RETURN jsonb_build_object('released', v_n);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------
-- app_tab_settle (Close My Tab): check the member's funds, hold them and fix the position. p = {tab_id, wallet_id, amount, version?}. The hold needs what a payment
-- needs: an active wallet and account with allow_pay, funds (the wallet's own money, or the shared pool plus unused approved credit) and the wallet's daily limit
-- (a hold reserves it). Nothing is written when any of that is missing.
CREATE FUNCTION public.app_tab_settle(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_tab_id uuid := (p ->> 'tab_id')::uuid;
  v_wallet uuid := (p ->> 'wallet_id')::uuid;
  v_amount bigint := (p ->> 'amount')::bigint;
  v_today date := public.program_today();
  t record; m record; w record; b record; v_status text; v_em bigint; v_funds bigint; v_credit bigint; v_hold uuid;
BEGIN
  IF v_amount IS NULL OR v_amount <= 0 THEN RETURN public.app_err('invalid_amount', 400); END IF;
  SELECT id, status, version INTO t FROM public.tabs WHERE id = v_tab_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN public.app_err('tab_not_found', 404); END IF;
  IF t.status NOT IN ('open', 'paying') THEN RETURN public.app_err('tab_not_open', 409); END IF;
  IF nullif(p ->> 'version', '') IS NOT NULL AND (p ->> 'version')::int <> t.version THEN RETURN public.app_err('stale_version', 409); END IF;
  SELECT * INTO m FROM public.tab_members WHERE tab_id = v_tab_id AND wallet_id = v_wallet FOR NO KEY UPDATE;
  IF NOT FOUND OR m.removed_at IS NOT NULL THEN RETURN public.app_err('not_a_member', 404); END IF;
  IF m.settled_at IS NOT NULL THEN RETURN public.app_err('already_closed', 409); END IF;

  SELECT balance, credit_limit, credit_spent INTO b FROM public.balances WHERE account_id = m.account_id FOR NO KEY UPDATE;
  SELECT status, allow_pay, daily_limit, CASE WHEN spent_day = v_today THEN spent_today ELSE 0 END AS spent, balance, held, type INTO w
    FROM public.wallets WHERE id = v_wallet FOR NO KEY UPDATE;
  SELECT status INTO v_status FROM public.accounts WHERE id = m.account_id;
  IF b IS NULL OR w IS NULL THEN RETURN public.app_err('not_a_member', 404); END IF;
  IF v_status IS DISTINCT FROM 'active' OR w.status IS DISTINCT FROM 'active' THEN RETURN public.app_err('payer_unavailable', 422); END IF;
  IF NOT w.allow_pay THEN RETURN public.app_err('pay_not_allowed', 422); END IF;
  IF b.balance < 0 OR b.credit_spent > b.credit_limit THEN RETURN public.app_err('account_restricted', 422); END IF;

  SELECT coalesce(sum(CASE WHEN balance IS NOT NULL THEN balance ELSE held END), 0) INTO v_em FROM public.wallets WHERE account_id = m.account_id;
  v_funds := CASE WHEN w.balance IS NOT NULL THEN greatest(w.balance - w.held, 0) ELSE greatest(b.balance - v_em, 0) END;
  v_credit := CASE WHEN w.balance IS NOT NULL THEN 0 ELSE greatest(b.credit_limit - b.credit_spent, 0) END;
  IF v_funds + v_credit < v_amount THEN
    RETURN jsonb_build_object('kind', 'error', 'status', 422, 'error', 'insufficient_funds', 'missing', v_amount - (v_funds + v_credit));
  END IF;
  IF w.daily_limit IS NOT NULL AND w.spent + w.held + v_amount > w.daily_limit THEN RETURN public.app_err('spend_limit_exceeded', 422); END IF;

  INSERT INTO public.fund_holds (account_id, wallet_id, kind, tab_id, amount) VALUES (m.account_id, v_wallet, 'tab', v_tab_id, v_amount) RETURNING id INTO v_hold;
  UPDATE public.wallets SET held = held + v_amount WHERE id = v_wallet;
  UPDATE public.tab_members SET settled_at = now() WHERE tab_id = v_tab_id AND wallet_id = v_wallet;
  UPDATE public.tabs SET version = version + 1, last_activity_at = now() WHERE id = v_tab_id;
  RETURN jsonb_build_object('kind', 'ok', 'hold_id', v_hold, 'amount', v_amount, 'version', t.version + 1);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------
-- app_close_tab (Pay). p = {tab_id, version, actor, closed_reason, reference, served_by,
--   payers: [{wallet_id, account_id, amount, total, sales_tax, tip, lines, tips: [{staff_account_id, amount}]}]}.
-- `amount` is what the payer pays (total + tip); `total` is the checkout's total (the lines, tax when added). Lock order: tab, products (by id), the balances of the
-- merchant and every payer's account ascending, then the payer wallets (by id). Pass 1 checks every payer with no writes (a payer with a hold must be covered by it;
-- the others are checked live: status, allow_pay, funds then approved credit, the daily limit, tallied per account so two wallets of one account cannot both spend the
-- same money). Anyone short: return the shortfall and write NOTHING; a tab never records a declined payment. Pass 2 writes, one payer after another: release the hold,
-- the checkout, the balance moves, the `pay`, the tips, the hold captured. Stock is taken but never below zero (the food was served).
CREATE FUNCTION public.app_close_tab(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_tab_id uuid := (p ->> 'tab_id')::uuid;
  v_today date := public.program_today();
  t record; r record; w record; b record; hd record; v_ma record;
  v_merchant uuid; v_mw uuid; v_status text; v_em bigint; v_funds bigint; v_credit bigint; v_own bigint; v_take bigint; v_use bigint;
  v_short jsonb := '[]'::jsonb; v_used_bal jsonb := '{}'::jsonb; v_used_credit jsonb := '{}'::jsonb; v_code text; v_missing bigint;
  v_co uuid; v_tx uuid; v_idem text; v_from_balance bigint; v_from_credit bigint; v_payments jsonb := '[]'::jsonb; v_ref text := p ->> 'reference';
  v_accts uuid[]; v_wallets uuid[]; v_products uuid[]; q record; v_prev jsonb; v_tip bigint; v_closed_reason text := coalesce(p ->> 'closed_reason', 'host');
BEGIN
  SELECT * INTO t FROM public.tabs WHERE id = v_tab_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN public.app_err('tab_not_found', 404); END IF;
  IF t.status = 'closed' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('wallet_id', x.wallet_id, 'transaction_id', x.id, 'checkout_id', x.checkout_id, 'amount', x.amount) ORDER BY x.wallet_id), '[]'::jsonb)
      INTO v_prev FROM (SELECT tr.id, tr.from_wallet_id AS wallet_id, tr.checkout_id, tr.amount FROM public.transactions tr JOIN public.checkouts c ON c.id = tr.checkout_id
                         WHERE c.tab_id = v_tab_id AND tr.type = 'pay' AND tr.status = 'completed') x;
    RETURN jsonb_build_object('kind', 'ok', 'replayed', true, 'payments', v_prev);
  END IF;
  IF t.status NOT IN ('paying', 'unpaid') THEN RETURN public.app_err('tab_not_payable', 409); END IF;
  IF (p ->> 'version')::int IS DISTINCT FROM t.version THEN RETURN public.app_err('stale_version', 409); END IF;
  v_merchant := t.account_id;
  SELECT status, type INTO v_ma FROM public.accounts WHERE id = v_merchant;
  IF v_ma.status IS DISTINCT FROM 'active' OR v_ma.type IS DISTINCT FROM 'B' THEN RETURN public.app_err('merchant_unavailable', 422); END IF;
  SELECT id INTO v_mw FROM public.wallets WHERE account_id = v_merchant AND type = 'default';
  IF v_mw IS NULL THEN RAISE EXCEPTION 'merchant wallet missing'; END IF;
  IF jsonb_array_length(p -> 'payers') = 0 THEN RETURN public.app_err('nothing_to_pay', 422); END IF;

  -- locks: products (by id), balances (ascending), wallets (by id)
  SELECT coalesce(array_agg(DISTINCT (l ->> 'product_id')::uuid), ARRAY[]::uuid[]) INTO v_products
    FROM jsonb_array_elements(p -> 'payers') e, jsonb_array_elements(e -> 'lines') l WHERE l ->> 'product_id' IS NOT NULL;
  PERFORM 1 FROM public.products WHERE id = ANY (v_products) AND account_id = v_merchant ORDER BY id FOR NO KEY UPDATE;
  SELECT array_agg(DISTINCT a) INTO v_accts FROM (SELECT (e ->> 'account_id')::uuid AS a FROM jsonb_array_elements(p -> 'payers') e UNION SELECT v_merchant) s;
  PERFORM 1 FROM public.balances WHERE account_id = ANY (v_accts) ORDER BY account_id FOR NO KEY UPDATE;
  SELECT array_agg((e ->> 'wallet_id')::uuid) INTO v_wallets FROM jsonb_array_elements(p -> 'payers') e;
  PERFORM 1 FROM public.wallets WHERE id = ANY (v_wallets) ORDER BY id FOR NO KEY UPDATE;

  -- pass 1: check everyone, write nothing
  FOR r IN SELECT (e ->> 'wallet_id')::uuid AS wid, (e ->> 'account_id')::uuid AS acct, (e ->> 'amount')::bigint AS amt
             FROM jsonb_array_elements(p -> 'payers') e ORDER BY 1 LOOP
    v_code := NULL; v_missing := r.amt;
    SELECT status, allow_pay, daily_limit, CASE WHEN spent_day = v_today THEN spent_today ELSE 0 END AS spent, balance, held, account_id INTO w FROM public.wallets WHERE id = r.wid;
    IF w IS NULL OR w.account_id <> r.acct THEN RAISE EXCEPTION 'payer wallet does not belong to the account'; END IF;
    SELECT balance, credit_limit, credit_spent INTO b FROM public.balances WHERE account_id = r.acct;
    SELECT status INTO v_status FROM public.accounts WHERE id = r.acct;
    SELECT coalesce(amount, 0) INTO v_own FROM public.fund_holds WHERE tab_id = v_tab_id AND wallet_id = r.wid AND status = 'active';
    v_own := coalesce(v_own, 0);
    SELECT coalesce(sum(CASE WHEN balance IS NOT NULL THEN balance ELSE held END), 0) INTO v_em FROM public.wallets WHERE account_id = r.acct;
    v_funds := CASE WHEN w.balance IS NOT NULL THEN greatest(w.balance - (w.held - v_own), 0)
                    ELSE greatest(b.balance - (v_em - v_own) - coalesce((v_used_bal ->> r.acct::text)::bigint, 0), 0) END;
    v_credit := CASE WHEN w.balance IS NOT NULL THEN 0 ELSE greatest(b.credit_limit - b.credit_spent - coalesce((v_used_credit ->> r.acct::text)::bigint, 0), 0) END;
    IF v_status IS DISTINCT FROM 'active' OR w.status IS DISTINCT FROM 'active' THEN v_code := 'payer_unavailable';
    ELSIF NOT w.allow_pay THEN v_code := 'pay_not_allowed';
    ELSIF b.balance < 0 OR b.credit_spent > b.credit_limit THEN v_code := 'account_restricted';
    ELSIF v_own > 0 AND v_own < r.amt THEN v_code := 'hold_too_small'; v_missing := r.amt - v_own;
    ELSIF v_funds + v_credit < r.amt THEN v_code := 'insufficient_funds'; v_missing := r.amt - (v_funds + v_credit);
    ELSIF w.daily_limit IS NOT NULL AND w.spent + (w.held - v_own) + r.amt > w.daily_limit THEN v_code := 'spend_limit_exceeded'; v_missing := w.spent + (w.held - v_own) + r.amt - w.daily_limit;
    END IF;
    IF v_code IS NOT NULL THEN
      v_short := v_short || jsonb_build_array(jsonb_build_object('wallet_id', r.wid, 'amount', v_missing, 'code', v_code));
    ELSE
      v_take := least(v_funds, r.amt); v_use := r.amt - v_take;
      v_used_bal := v_used_bal || jsonb_build_object(r.acct::text, coalesce((v_used_bal ->> r.acct::text)::bigint, 0) + v_take);
      v_used_credit := v_used_credit || jsonb_build_object(r.acct::text, coalesce((v_used_credit ->> r.acct::text)::bigint, 0) + v_use);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_short) > 0 THEN RETURN jsonb_build_object('kind', 'short', 'short', v_short); END IF;

  -- pass 2: write
  FOR q IN SELECT e AS e, (e ->> 'wallet_id')::uuid AS wid, (e ->> 'account_id')::uuid AS acct, (e ->> 'amount')::bigint AS amt FROM jsonb_array_elements(p -> 'payers') e ORDER BY 2 LOOP
    v_tip := coalesce((q.e ->> 'tip')::bigint, 0);
    SELECT * INTO hd FROM public.fund_holds WHERE tab_id = v_tab_id AND wallet_id = q.wid AND status = 'active' FOR NO KEY UPDATE;
    IF FOUND THEN UPDATE public.wallets SET held = held - hd.amount WHERE id = q.wid; END IF;
    SELECT balance, credit_limit, credit_spent INTO b FROM public.balances WHERE account_id = q.acct;
    SELECT balance, held INTO w FROM public.wallets WHERE id = q.wid;
    SELECT coalesce(sum(CASE WHEN balance IS NOT NULL THEN balance ELSE held END), 0) INTO v_em FROM public.wallets WHERE account_id = q.acct;
    v_funds := CASE WHEN w.balance IS NOT NULL THEN greatest(w.balance - w.held, 0) ELSE greatest(b.balance - v_em, 0) END;
    v_credit := CASE WHEN w.balance IS NOT NULL THEN 0 ELSE greatest(b.credit_limit - b.credit_spent, 0) END;
    v_from_balance := least(v_funds, q.amt); v_from_credit := q.amt - v_from_balance;
    IF v_from_credit > v_credit THEN RAISE EXCEPTION 'tab payment could not be completed (wallet %)', q.wid; END IF;

    INSERT INTO public.checkouts (account_id, terminal_id, reference, total, items, status, served_by, tip_amount, sales_tax, tab_id)
    VALUES (v_merchant, NULL, v_ref, (q.e ->> 'total')::bigint, q.e -> 'lines', 'paid', nullif(p ->> 'served_by', '')::uuid, v_tip, coalesce((q.e ->> 'sales_tax')::bigint, 0), v_tab_id)
    RETURNING id INTO v_co;
    v_idem := 'pay:' || v_merchant::text || ':c:' || q.acct::text || ':tab:' || v_tab_id::text || ':' || q.wid::text;
    UPDATE public.balances SET balance = balance - v_from_balance, credit_spent = credit_spent + v_from_credit WHERE account_id = q.acct;
    UPDATE public.balances SET balance = balance + q.amt WHERE account_id = v_merchant;
    UPDATE public.wallets SET spent_today = CASE WHEN spent_day = v_today THEN spent_today + q.amt ELSE q.amt END, spent_day = v_today,
                              balance = CASE WHEN balance IS NOT NULL THEN balance - v_from_balance ELSE balance END WHERE id = q.wid;
    INSERT INTO public.transactions (type, status, from_wallet_id, to_wallet_id, amount, credit_amount, checkout_id, account_id, reference, idem, meta)
    VALUES ('pay', 'completed', q.wid, v_mw, q.amt, v_from_credit, v_co, q.acct, v_ref, v_idem,
            jsonb_build_object('items', q.e -> 'lines', 'tab_id', v_tab_id) || CASE WHEN q.e ? 'for' THEN jsonb_build_object('covers', q.e -> 'for') ELSE '{}'::jsonb END)
    RETURNING id INTO v_tx;
    IF v_tip > 0 THEN
      INSERT INTO public.tips (transaction_id, account_id, staff_account_id, amount)
      SELECT v_tx, v_merchant, (x ->> 'staff_account_id')::uuid, (x ->> 'amount')::bigint FROM jsonb_array_elements(q.e -> 'tips') x;
      IF (SELECT coalesce(sum(amount), 0) FROM public.tips WHERE transaction_id = v_tx) <> v_tip THEN RAISE EXCEPTION 'tips do not add up to the tip'; END IF;
    END IF;
    IF hd.id IS NOT NULL THEN
      UPDATE public.fund_holds SET status = 'captured', ended_at = now(), end_reason = 'paid', transaction_id = v_tx WHERE id = hd.id;
    END IF;
    v_payments := v_payments || jsonb_build_array(jsonb_build_object('wallet_id', q.wid, 'transaction_id', v_tx, 'checkout_id', v_co, 'amount', q.amt));
  END LOOP;

  -- stock: taken, never below zero (the food has been served); the sale is counted
  FOR q IN SELECT (l ->> 'product_id')::uuid AS pid, sum((l ->> 'quantity')::int)::int AS qty
             FROM jsonb_array_elements(p -> 'payers') e, jsonb_array_elements(e -> 'lines') l WHERE l ->> 'product_id' IS NOT NULL GROUP BY 1 ORDER BY 1 LOOP
    UPDATE public.products SET stock = CASE WHEN stock IS NULL THEN NULL ELSE greatest(stock - q.qty, 0) END, total_sold = total_sold + q.qty,
                               sold_today = CASE WHEN sold_day = v_today THEN sold_today + q.qty ELSE q.qty END, sold_day = v_today
     WHERE id = q.pid AND account_id = v_merchant;
  END LOOP;

  -- holds of members who are not paying are released; the tab is closed
  PERFORM public.app_tab_release(jsonb_build_object('tab_id', v_tab_id, 'reason', 'left'));
  UPDATE public.tabs SET status = 'closed', closed_at = now(), closed_by = nullif(p ->> 'actor', '')::uuid, closed_reason = v_closed_reason,
                         version = version + 1, last_activity_at = now() WHERE id = v_tab_id;
  RETURN jsonb_build_object('kind', 'ok', 'replayed', false, 'payments', v_payments);
END;
$$;
