-- Tips (docs/TABLES.md "tips"). A tip is part of the payment: pay.amount includes it, so balances, settlement and reconciliation are unchanged. The order
-- record says how much of it is tip: EVERY payment is now a checkout (an amount-only tap creates one too), and checkouts carry `tip_amount` (written once,
-- when the checkout is paid) and `served_by` (the staff member's account, set when the order is created; a terminal has an active staff member that
-- defaults it). Who the tip belongs to is recorded in `tips`: one immutable row per staff member per transaction (a payment can split a tip between
-- several people; a refund that returns tip money writes negative rows). `transactions` stays the money record and gets no new columns.
-- Staff no longer carry a bank account: tips are reported to staff, never paid out by Nuclear.

ALTER TABLE public.staff DROP CONSTRAINT staff_bank_account_id_staff_account_id_fkey;
ALTER TABLE public.staff DROP COLUMN bank_account_id;
ALTER TABLE public.staff ADD CONSTRAINT staff_id_account_key UNIQUE (id, account_id);

ALTER TABLE public.terminals ADD COLUMN active_staff_id uuid;
ALTER TABLE public.terminals ADD CONSTRAINT terminals_active_staff_fkey FOREIGN KEY (active_staff_id, account_id) REFERENCES public.staff(id, account_id) ON DELETE SET NULL (active_staff_id);

ALTER TABLE public.checkouts ADD COLUMN tip_amount bigint DEFAULT 0 NOT NULL, ADD COLUMN served_by uuid;
ALTER TABLE public.checkouts
    ADD CONSTRAINT checkouts_tip_check CHECK (tip_amount >= 0),
    ADD CONSTRAINT checkouts_tip_paid CHECK (tip_amount = 0 OR status = 'paid'),
    ADD CONSTRAINT checkouts_served_by_fkey FOREIGN KEY (served_by) REFERENCES public.accounts(id) ON DELETE RESTRICT;

-- Every payment is a checkout now, so declined one-step attempts leave canceled ones behind: the nightly purge removes canceled checkouts and long-expired
-- open ones once nothing references them (retention.ts); these two small partial indexes keep that a range read.
CREATE INDEX checkouts_canceled_idx ON public.checkouts USING btree (created_at) WHERE (status = 'canceled');
CREATE INDEX checkouts_expiring_idx ON public.checkouts USING btree (expires_at) WHERE (status = 'open' AND expires_at IS NOT NULL);

CREATE TABLE public.tips (
    id uuid DEFAULT uuidv7() NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    staff_account_id uuid NOT NULL,
    amount bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tips_pkey PRIMARY KEY (id),
    CONSTRAINT tips_transaction_staff_key UNIQUE (transaction_id, staff_account_id),
    CONSTRAINT tips_amount_check CHECK (amount <> 0),
    CONSTRAINT tips_transaction_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT,
    CONSTRAINT tips_account_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT,
    CONSTRAINT tips_staff_fkey FOREIGN KEY (staff_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT
);
CREATE INDEX tips_staff_idx ON public.tips USING btree (staff_account_id, account_id, created_at DESC, id DESC);
CREATE INDEX tips_merchant_idx ON public.tips USING btree (account_id, created_at DESC, id DESC);

-- Immutable like the transactions they belong to: a correction is a new row.
CREATE FUNCTION public.tips_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'tips are immutable; write a new row to correct one';
END;
$$;
CREATE TRIGGER tips_no_update BEFORE DELETE OR UPDATE ON public.tips FOR EACH ROW EXECUTE FUNCTION public.tips_immutable();
CREATE TRIGGER tips_no_truncate BEFORE TRUNCATE ON public.tips FOR EACH STATEMENT EXECUTE FUNCTION public.tips_immutable();

-- A tip row belongs to a completed payment (positive) or refund (negative) of the merchant it names, and the person is that merchant's staff member
-- (or was: removing a staff member keeps their tips).
CREATE FUNCTION public.tips_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE t record;
BEGIN
  SELECT x.type, x.status, CASE x.type WHEN 'pay' THEN tw.account_id WHEN 'refund' THEN fw.account_id END AS merchant INTO t
    FROM public.transactions x JOIN public.wallets fw ON fw.id = x.from_wallet_id JOIN public.wallets tw ON tw.id = x.to_wallet_id WHERE x.id = NEW.transaction_id;
  IF NOT FOUND OR t.status <> 'completed' OR t.merchant IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'a tip belongs to a completed payment or refund of its merchant' USING ERRCODE = '23514';
  END IF;
  IF (t.type = 'pay' AND NEW.amount < 0) OR (t.type = 'refund' AND NEW.amount > 0) THEN
    RAISE EXCEPTION 'a payment tip is positive and a refund tip is negative' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tips_scope BEFORE INSERT ON public.tips FOR EACH ROW EXECUTE FUNCTION public.tips_scope();

-- ---- money functions (same bodies as 0002 with the tip added) ----

CREATE OR REPLACE FUNCTION public.app_payrow(tx_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object('id', x.id, 'status', x.status, 'status_code', x.status_code, 'amount', x.amount,
                            'from_account_id', x.from_account_id, 'to_account_id', x.to_account_id, 'from_wallet_id', x.from_wallet_id,
                            'tag_id', x.tag_id, 'terminal_id', x.terminal_id, 'checkout_id', x.checkout_id, 'reference', x.reference,
                            'idempotency_key', x.idempotency_key, 'timestamp', x."timestamp", 'completed_at', x.completed_at,
                            'tip_amount', coalesce(c.tip_amount, 0), 'served_by', c.served_by)
    FROM public.txn x LEFT JOIN public.checkouts c ON c.id = x.checkout_id WHERE x.id = tx_id
$$;

CREATE FUNCTION public.app_pay_plan_base(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_merchant uuid := (p ->> 'merchant')::uuid;
  v_co public.checkouts;
  v_status text; v_bad text; v_lines jsonb := '[]'::jsonb; v_total bigint := 0; r record; v_prod public.products;
BEGIN
  IF nullif(p ->> 'checkout_id', '') IS NOT NULL THEN
    SELECT * INTO v_co FROM public.checkouts WHERE id = (p ->> 'checkout_id')::uuid AND account_id = v_merchant;
    IF NOT FOUND THEN RETURN public.app_err('checkout_not_found', 404); END IF;
    v_status := CASE WHEN v_co.status = 'open' AND v_co.expires_at IS NOT NULL AND v_co.expires_at <= now() THEN 'expired' ELSE v_co.status END;
    IF v_status = 'expired' THEN RETURN public.app_err('checkout_expired', 409); END IF;
    IF v_status <> 'open' THEN RETURN public.app_err(CASE WHEN v_status = 'paid' THEN 'checkout_paid' ELSE 'checkout_not_open' END, 409); END IF;
    FOR r IN SELECT (i ->> 'product_id')::uuid AS product_id, sum((i ->> 'quantity')::int)::int AS qty
               FROM jsonb_array_elements(v_co.items) i WHERE i ->> 'product_id' IS NOT NULL GROUP BY 1 LOOP
      SELECT * INTO v_prod FROM public.products WHERE id = r.product_id AND account_id = v_merchant;
      IF NOT FOUND THEN RETURN public.app_err('product_unavailable', 422); END IF;
      v_bad := public.product_blocker(v_prod, r.qty);
      IF v_bad IS NOT NULL THEN RETURN public.app_err(v_bad, 422); END IF;
    END LOOP;
    RETURN jsonb_build_object('checkout_id', v_co.id, 'total', v_co.total);
  END IF;

  IF p -> 'items' IS NOT NULL AND jsonb_typeof(p -> 'items') = 'array' THEN
    -- price the cart from the merchant's live catalogue (price - discount); the same product twice is one line
    FOR r IN SELECT (i ->> 'product_id')::uuid AS product_id, sum((i ->> 'quantity')::int)::int AS qty, min(ord) AS ord
               FROM jsonb_array_elements(p -> 'items') WITH ORDINALITY AS e(i, ord) GROUP BY 1 ORDER BY min(ord) LOOP
      SELECT * INTO v_prod FROM public.products WHERE id = r.product_id AND account_id = v_merchant;
      IF NOT FOUND THEN RETURN public.app_err('product_not_found', 404); END IF;
      v_bad := public.product_blocker(v_prod, r.qty);
      IF v_bad IS NOT NULL THEN RETURN public.app_err(v_bad, 422); END IF;
      v_total := v_total + (v_prod.price - v_prod.discount) * r.qty;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod.id, 'name', v_prod.name,
                                                               'unit_price', v_prod.price, 'discount', v_prod.discount, 'quantity', r.qty));
    END LOOP;
    IF v_total <= 0 OR v_total > 1000000000 THEN RETURN public.app_err('invalid_total', 422); END IF;
    IF nullif(p ->> 'amount', '') IS NOT NULL AND (p ->> 'amount')::bigint <> v_total THEN RETURN public.app_err('amount_mismatch', 400); END IF;
    RETURN jsonb_build_object('create', jsonb_build_object('lines', v_lines, 'total', v_total, 'reference', p -> 'reference'), 'total', v_total);
  END IF;

  RETURN jsonb_build_object('create', jsonb_build_object('lines', '[]'::jsonb, 'total', (p ->> 'amount')::bigint, 'reference', p -> 'reference'),
                            'total', (p ->> 'amount')::bigint);
END;
$$;

-- Planning a payment: the old plan (the checkout or the priced cart) plus the tip and who gets it, validated before a tap is consumed.
-- p adds: terminal_id?, tip? (cents, part of what the payer pays), tips? ([{staff_id, amount}] a split, summing to tip), served_by? (a staff id).
-- The staff are the merchant's staff records (ids); the checkout's server, else the terminal's active staff member, is the default. Answers the base plan plus
-- {tip, tips: [{staff_account_id, amount}], served_by: staff account id}.
CREATE OR REPLACE FUNCTION public.app_pay_plan(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_plan jsonb := public.app_pay_plan_base(p);
  v_merchant uuid := (p ->> 'merchant')::uuid;
  v_tip bigint := coalesce(nullif(p ->> 'tip', '')::bigint, 0);
  v_total bigint; v_req uuid; v_act uuid; v_served uuid; v_tip_to uuid; v_tips jsonb := '[]'::jsonb; v_sum bigint := 0; e record; v_acct uuid;
BEGIN
  IF v_plan ->> 'kind' = 'error' THEN RETURN v_plan; END IF;
  v_total := (v_plan ->> 'total')::bigint;
  -- Who served: the request (a staff id), else the terminal's active staff member. A new checkout records that person; the tip goes to the request, else the
  -- paid checkout's own server, else the active staff member.
  IF nullif(p ->> 'served_by', '') IS NOT NULL THEN
    SELECT staff_account_id INTO v_req FROM public.staff WHERE id = (p ->> 'served_by')::uuid AND account_id = v_merchant;
    IF NOT FOUND THEN RETURN public.app_err('staff_not_found', 404); END IF;
  END IF;
  SELECT s.staff_account_id INTO v_act FROM public.terminals t JOIN public.staff s ON s.id = t.active_staff_id
   WHERE t.id = nullif(p ->> 'terminal_id', '')::uuid AND t.account_id = v_merchant;
  v_served := coalesce(v_req, v_act);
  v_tip_to := coalesce(v_req, CASE WHEN v_plan ->> 'checkout_id' IS NOT NULL THEN (SELECT served_by FROM public.checkouts WHERE id = (v_plan ->> 'checkout_id')::uuid) END, v_act);
  IF v_tip < 0 OR v_tip > 1000000000 OR v_tip > v_total * 10 THEN RETURN public.app_err('invalid_tip', 422); END IF;
  IF v_tip > 0 THEN
    IF jsonb_typeof(p -> 'tips') = 'array' AND jsonb_array_length(p -> 'tips') > 0 THEN
      FOR e IN SELECT (x ->> 'staff_id')::uuid AS staff_id, sum((x ->> 'amount')::bigint) AS amount, min(ord) AS ord
                 FROM jsonb_array_elements(p -> 'tips') WITH ORDINALITY AS t(x, ord) GROUP BY 1 ORDER BY min(ord) LOOP
        IF e.amount IS NULL OR e.amount <= 0 THEN RETURN public.app_err('invalid_tip', 422); END IF;
        SELECT staff_account_id INTO v_acct FROM public.staff WHERE id = e.staff_id AND account_id = v_merchant;
        IF NOT FOUND THEN RETURN public.app_err('staff_not_found', 404); END IF;
        v_sum := v_sum + e.amount;
        v_tips := v_tips || jsonb_build_array(jsonb_build_object('staff_account_id', v_acct, 'amount', e.amount));
      END LOOP;
      IF v_sum <> v_tip THEN RETURN public.app_err('tips_mismatch', 422); END IF;
    ELSIF v_tip_to IS NOT NULL THEN
      v_tips := jsonb_build_array(jsonb_build_object('staff_account_id', v_tip_to, 'amount', v_tip));
    ELSE
      RETURN public.app_err('staff_required_for_tip', 422);
    END IF;
  END IF;
  RETURN v_plan || jsonb_build_object('tip', v_tip, 'tips', v_tips, 'served_by', v_served);
END;
$$;

CREATE OR REPLACE FUNCTION public.app_pay_checkout(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_payer_w uuid := (p ->> 'payer_wallet')::uuid;
  v_payer uuid := (p ->> 'payer_account')::uuid;
  v_merchant uuid := (p ->> 'merchant')::uuid;
  v_actor uuid := (p ->> 'actor')::uuid;
  v_terminal uuid := nullif(p ->> 'terminal_id', '')::uuid;
  v_tag uuid := nullif(p ->> 'tag_id', '')::uuid;
  v_tag_limit bigint := nullif(p ->> 'tag_limit', '')::bigint;
  v_today date := public.program_today();
  v_idem text := 'pay:' || (p ->> 'merchant') || ':' || (p ->> 'key');
  v_prev record; v_co public.checkouts; v_co_id uuid; v_created boolean := false;
  v_amount bigint; v_reference text; v_items jsonb := '[]'::jsonb; v_decline text;
  r record; pb record; w record; v_pa text; v_ma record; v_em bigint; v_mw uuid;
  v_funds bigint; v_credit_avail bigint; v_from_balance bigint := 0; v_from_credit bigint := 0;
  v_id uuid; v_prod public.products; v_bad text;
  v_tip bigint := coalesce(nullif(p ->> 'tip', '')::bigint, 0);
  v_served uuid := nullif(p ->> 'served_by', '')::uuid;
BEGIN
  -- Replay first, so a retry never creates a second checkout.
  SELECT t.id, t.status, t.amount, t.from_wallet_id, t.tag_id, t.checkout_id, t.reference,
         coalesce((SELECT c.tip_amount FROM public.checkouts c WHERE c.id = t.checkout_id), 0) AS tip_amount INTO v_prev
    FROM public.transactions t WHERE t.idem = v_idem;
  IF FOUND THEN
    IF nullif(p ->> 'expect_amount', '') IS NOT NULL AND (p ->> 'expect_amount')::bigint <> v_prev.amount - v_prev.tip_amount THEN RETURN jsonb_build_object('kind', 'conflict'); END IF;
    IF coalesce(nullif(p ->> 'expect_tip', '')::bigint, v_tip) <> v_prev.tip_amount THEN RETURN jsonb_build_object('kind', 'conflict'); END IF;
    IF v_prev.from_wallet_id <> v_payer_w OR v_prev.tag_id IS DISTINCT FROM v_tag THEN RETURN jsonb_build_object('kind', 'conflict'); END IF;
    RETURN jsonb_build_object('kind', CASE v_prev.status WHEN 'completed' THEN 'ok' ELSE 'declined' END, 'replayed', true, 'row', public.app_payrow(v_prev.id));
  END IF;

  IF nullif(p ->> 'checkout_id', '') IS NOT NULL THEN
    SELECT * INTO v_co FROM public.checkouts WHERE id = (p ->> 'checkout_id')::uuid AND account_id = v_merchant FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'checkout missing'; END IF;
    v_co_id := v_co.id; v_amount := v_co.total; v_reference := v_co.reference; v_items := v_co.items;
    IF v_co.status = 'open' AND v_co.expires_at IS NOT NULL AND v_co.expires_at <= now() THEN v_decline := 'checkout_expired';
    ELSIF v_co.status <> 'open' THEN v_decline := CASE WHEN v_co.status = 'paid' THEN 'checkout_paid' ELSE 'checkout_not_open' END;
    END IF;
  ELSE
    v_amount := (p -> 'create' ->> 'total')::bigint;
    v_reference := p -> 'create' ->> 'reference';
    -- every payment is a checkout: an amount-only payment writes one too (paid, with its tip and who served; canceled again if it is declined)
    v_items := p -> 'create' -> 'lines';
    INSERT INTO public.checkouts (account_id, terminal_id, reference, total, items, status, served_by, tip_amount)
    VALUES (v_merchant, v_terminal, v_reference, v_amount, v_items, 'paid', v_served, v_tip) RETURNING id INTO v_co_id;
    v_created := true;
  END IF;

  -- The tip is part of what the payer pays (the checkout's own total stays the items).
  v_amount := v_amount + v_tip;

  -- Stock: lock the products (stable order) and re-check availability; taken only if the payment completes.
  IF v_decline IS NULL THEN
    FOR r IN SELECT (i ->> 'product_id')::uuid AS product_id, sum((i ->> 'quantity')::int)::int AS qty
               FROM jsonb_array_elements(v_items) i WHERE i ->> 'product_id' IS NOT NULL GROUP BY 1 ORDER BY 1 LOOP
      SELECT * INTO v_prod FROM public.products WHERE id = r.product_id AND account_id = v_merchant FOR NO KEY UPDATE;
      IF NOT FOUND THEN v_decline := 'product_unavailable'; EXIT; END IF;
      v_bad := public.product_blocker(v_prod, r.qty);
      IF v_bad IS NOT NULL THEN v_decline := v_bad; EXIT; END IF;
    END LOOP;
  END IF;

  -- Locks: both balance rows (stable order), then the payer wallet.
  FOR r IN SELECT account_id, balance, credit_limit, credit_spent FROM public.balances
            WHERE account_id IN (v_payer, v_merchant) ORDER BY account_id FOR NO KEY UPDATE LOOP
    IF r.account_id = v_payer THEN pb := r; END IF;
  END LOOP;
  SELECT status, allow_pay, daily_limit, CASE WHEN spent_day = v_today THEN spent_today ELSE 0 END AS spent, balance, type INTO w
    FROM public.wallets WHERE id = v_payer_w FOR NO KEY UPDATE;
  SELECT status INTO v_pa FROM public.accounts WHERE id = v_payer;
  SELECT status, type INTO v_ma FROM public.accounts WHERE id = v_merchant;
  SELECT coalesce(sum(balance), 0) INTO v_em FROM public.wallets WHERE account_id = v_payer AND balance IS NOT NULL;
  SELECT id INTO v_mw FROM public.wallets WHERE account_id = v_merchant AND type = 'default';
  IF pb IS NULL OR v_mw IS NULL THEN RAISE EXCEPTION 'balances row missing'; END IF;

  -- An earmarked wallet spends only its own balance (a hard limit, never credit); otherwise the account's funds minus what is earmarked
  -- for other wallets, plus approved credit.
  v_funds := CASE WHEN w.balance IS NOT NULL THEN w.balance ELSE greatest(pb.balance - v_em, 0) END;
  v_credit_avail := CASE WHEN w.balance IS NOT NULL THEN 0 ELSE greatest(pb.credit_limit - pb.credit_spent, 0) END;
  IF v_decline IS NOT NULL THEN NULL;
  ELSIF v_pa IS DISTINCT FROM 'active' OR w.status IS DISTINCT FROM 'active' THEN v_decline := 'payer_unavailable';
  ELSIF NOT w.allow_pay THEN v_decline := 'pay_not_allowed';
  ELSIF pb.balance < 0 OR pb.credit_spent > pb.credit_limit THEN v_decline := 'account_restricted';
  ELSIF v_ma.status IS DISTINCT FROM 'active' OR v_ma.type IS DISTINCT FROM 'B' THEN v_decline := 'merchant_unavailable';
  ELSIF v_tag_limit IS NOT NULL AND v_amount > v_tag_limit THEN v_decline := 'tag_limit_exceeded';
  ELSIF v_funds + v_credit_avail < v_amount THEN v_decline := CASE WHEN w.balance IS NOT NULL THEN 'wallet_balance_exceeded' ELSE 'insufficient_balance' END;
  ELSIF w.daily_limit IS NOT NULL AND w.spent + v_amount > w.daily_limit THEN v_decline := 'spend_limit_exceeded';
  END IF;

  IF v_decline IS NOT NULL THEN
    INSERT INTO public.transactions (type, status, status_code, from_wallet_id, to_wallet_id, amount, tag_id, terminal_id, checkout_id, account_id, reference, idem, meta)
    VALUES ('pay', 'declined', v_decline, v_payer_w, v_mw, v_amount, v_tag, v_terminal, v_co_id, v_actor, v_reference, v_idem,
            CASE WHEN jsonb_array_length(v_items) > 0 THEN jsonb_build_object('items', v_items) ELSE '{}'::jsonb END)
    RETURNING id INTO v_id;
    -- A one-step checkout that failed to settle is dead; the POS starts a new one.
    IF v_created THEN UPDATE public.checkouts SET status = 'canceled', tip_amount = 0 WHERE id = v_co_id; END IF;
    RETURN jsonb_build_object('kind', 'declined', 'replayed', false, 'row', public.app_payrow(v_id));
  END IF;

  v_from_balance := least(v_funds, v_amount);
  v_from_credit := v_amount - v_from_balance;
  UPDATE public.balances SET balance = balance - v_from_balance, credit_spent = credit_spent + v_from_credit WHERE account_id = v_payer;
  UPDATE public.balances SET balance = balance + v_amount WHERE account_id = v_merchant;
  UPDATE public.wallets SET spent_today = CASE WHEN spent_day = v_today THEN spent_today + v_amount ELSE v_amount END, spent_day = v_today,
                            balance = CASE WHEN balance IS NOT NULL THEN balance - v_from_balance ELSE balance END
   WHERE id = v_payer_w;
  INSERT INTO public.transactions (type, status, from_wallet_id, to_wallet_id, amount, credit_amount, tag_id, terminal_id, checkout_id, account_id, reference, idem, meta)
  VALUES ('pay', 'completed', v_payer_w, v_mw, v_amount, v_from_credit, v_tag, v_terminal, v_co_id, v_actor, v_reference, v_idem,
          CASE WHEN jsonb_array_length(v_items) > 0 THEN jsonb_build_object('items', v_items) ELSE '{}'::jsonb END)
  RETURNING id INTO v_id;
  IF v_tip > 0 THEN
    INSERT INTO public.tips (transaction_id, account_id, staff_account_id, amount)
    SELECT v_id, v_merchant, (e ->> 'staff_account_id')::uuid, (e ->> 'amount')::bigint FROM jsonb_array_elements(p -> 'tips') e;
    IF (SELECT coalesce(sum(amount), 0) FROM public.tips WHERE transaction_id = v_id) <> v_tip THEN RAISE EXCEPTION 'tips do not add up to the tip'; END IF;
  END IF;

  -- Take the stock and count the sale (products in id order, the lock order); an existing checkout is now paid.
  FOR r IN SELECT (i ->> 'product_id')::uuid AS product_id, sum((i ->> 'quantity')::int)::int AS qty
             FROM jsonb_array_elements(v_items) i WHERE i ->> 'product_id' IS NOT NULL GROUP BY 1 ORDER BY 1 LOOP
    UPDATE public.products SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - r.qty END, total_sold = total_sold + r.qty,
                               sold_today = CASE WHEN sold_day = v_today THEN sold_today + r.qty ELSE r.qty END, sold_day = v_today
     WHERE id = r.product_id;
  END LOOP;
  IF v_co_id IS NOT NULL AND NOT v_created THEN UPDATE public.checkouts SET status = 'paid', tip_amount = v_tip WHERE id = v_co_id; END IF;
  RETURN jsonb_build_object('kind', 'ok', 'replayed', false, 'row', public.app_payrow(v_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.app_pay_tap(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_merchant uuid := (p ->> 'merchant')::uuid;
  v_idem text := 'pay:' || (p ->> 'merchant') || ':' || (p ->> 'key');
  v_counter bigint := (p ->> 'counter')::bigint;
  v_plan jsonb; tg record; v_prev record; v_out jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE idem = v_idem) THEN
    v_plan := public.app_pay_plan(p);
    IF v_plan ->> 'kind' = 'error' THEN RETURN v_plan; END IF;
  END IF;

  SELECT t.id, t.counter, t.locked, t.wallet_id, t.transaction_limit, w.account_id INTO tg
    FROM public.tags t LEFT JOIN public.wallets w ON w.id = t.wallet_id WHERE t.uid = p ->> 'uid' FOR NO KEY UPDATE OF t;
  IF NOT FOUND THEN RETURN public.app_err('tag_not_found', 404); END IF;

  SELECT t.id, t.status, t.amount, t.tag_id, coalesce((SELECT c.tip_amount FROM public.checkouts c WHERE c.id = t.checkout_id), 0) AS tip_amount INTO v_prev
    FROM public.transactions t WHERE t.idem = v_idem;
  IF FOUND THEN
    IF v_prev.tag_id IS DISTINCT FROM tg.id OR (nullif(p ->> 'amount', '') IS NOT NULL AND v_prev.amount - v_prev.tip_amount <> (p ->> 'amount')::bigint)
       OR coalesce(nullif(p ->> 'tip', '')::bigint, 0) <> v_prev.tip_amount THEN
      RETURN jsonb_build_object('kind', 'conflict');
    END IF;
    RETURN jsonb_build_object('kind', CASE v_prev.status WHEN 'completed' THEN 'ok' ELSE 'declined' END, 'replayed', true, 'row', public.app_payrow(v_prev.id),
                              'payer', (SELECT jsonb_build_object('display_name', display_name, 'photo', photo) FROM public.wallets WHERE id = tg.wallet_id));
  END IF;

  -- A proof is single-use: the counter must advance, and it is consumed here whatever happens next.
  IF tg.counter IS NOT NULL AND v_counter <= tg.counter THEN RETURN public.app_err('proof_replayed', 409); END IF;
  UPDATE public.tags SET counter = v_counter, last_read_at = now() WHERE id = tg.id;
  IF tg.wallet_id IS NULL OR tg.account_id IS NULL THEN RETURN public.app_err('tag_unassigned', 422); END IF;
  IF tg.locked THEN RETURN public.app_err('tag_locked', 422); END IF;
  IF tg.account_id = v_merchant THEN RETURN public.app_err('self_payment', 422); END IF;

  v_out := public.app_pay_checkout(jsonb_build_object(
    'payer_wallet', tg.wallet_id, 'payer_account', tg.account_id, 'merchant', v_merchant, 'actor', v_merchant,
    'terminal_id', p -> 'terminal_id', 'tag_id', tg.id, 'tag_limit', tg.transaction_limit, 'key', p ->> 'key',
    'checkout_id', v_plan -> 'checkout_id', 'create', v_plan -> 'create', 'expect_amount', p -> 'amount',
    'tip', v_plan -> 'tip', 'tips', v_plan -> 'tips', 'served_by', v_plan -> 'served_by', 'expect_tip', coalesce(p -> 'tip', to_jsonb(0))));
  RETURN v_out || jsonb_build_object('payer', (SELECT jsonb_build_object('display_name', display_name, 'photo', photo) FROM public.wallets WHERE id = tg.wallet_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.app_pay_app(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_payer uuid := (p ->> 'payer_account')::uuid;
  v_auth uuid := nullif(p ->> 'auth_wallet', '')::uuid;
  v_want uuid; v_wallet uuid; v_merchant uuid; v_terminal uuid; m record; v_key text; v_plan jsonb; v_out jsonb;
BEGIN
  -- The session's device must still be live (a revoked or expired device cannot move money even though its signed token still reads).
  IF nullif(p ->> 'device', '') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.devices WHERE id = (p ->> 'device')::uuid AND revoked_at IS NULL AND session_expires_at > now()) THEN
    RETURN public.app_err('unauthorized', 401);
  END IF;
  IF v_auth IS NOT NULL AND nullif(p ->> 'from_wallet', '') IS NOT NULL AND (p ->> 'from_wallet')::uuid <> v_auth THEN
    RETURN public.app_err('wallet_not_found', 404);
  END IF;
  v_want := coalesce(v_auth, nullif(p ->> 'from_wallet', '')::uuid);
  SELECT id INTO v_wallet FROM public.wallets WHERE account_id = v_payer AND (CASE WHEN v_want IS NULL THEN type = 'default' ELSE id = v_want END);
  IF NOT FOUND THEN RETURN public.app_err('wallet_not_found', 404); END IF;

  -- The merchant: the checkout's owner, or the terminal's.
  IF nullif(p ->> 'checkout_id', '') IS NOT NULL THEN
    SELECT account_id, terminal_id INTO v_merchant, v_terminal FROM public.checkouts WHERE id = (p ->> 'checkout_id')::uuid;
    IF NOT FOUND THEN RETURN public.app_err('checkout_not_found', 404); END IF;
  ELSE
    SELECT account_id, id INTO v_merchant, v_terminal FROM public.terminals WHERE id = (p ->> 'terminal_id')::uuid;
    IF NOT FOUND THEN RETURN public.app_err('terminal_not_found', 404); END IF;
  END IF;
  SELECT type, status INTO m FROM public.accounts WHERE id = v_merchant;
  IF NOT FOUND OR m.type <> 'B' OR m.status <> 'active' THEN RETURN public.app_err('merchant_unavailable', 404); END IF;
  IF v_merchant = v_payer THEN RETURN public.app_err('self_payment', 422); END IF;

  v_key := 'c:' || v_payer || ':' || (p ->> 'key');
  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE idem = 'pay:' || v_merchant || ':' || v_key) THEN
    v_plan := public.app_pay_plan(jsonb_build_object('merchant', v_merchant, 'checkout_id', p -> 'checkout_id', 'amount', p -> 'amount',
                                                     'items', p -> 'items', 'reference', p -> 'reference', 'terminal_id', v_terminal, 'tip', p -> 'tip'));
    IF v_plan ->> 'kind' = 'error' THEN RETURN v_plan; END IF;
  END IF;

  v_out := public.app_pay_checkout(jsonb_build_object(
    'payer_wallet', v_wallet, 'payer_account', v_payer, 'merchant', v_merchant, 'actor', v_payer,
    'terminal_id', v_terminal, 'key', v_key, 'checkout_id', v_plan -> 'checkout_id', 'create', v_plan -> 'create', 'expect_amount', p -> 'amount',
    'tip', v_plan -> 'tip', 'tips', v_plan -> 'tips', 'served_by', v_plan -> 'served_by', 'expect_tip', coalesce(p -> 'tip', to_jsonb(0))));
  RETURN v_out || jsonb_build_object('merchant', jsonb_build_object('account_id', v_merchant,
           'display_name', (SELECT coalesce(b.display_name, a.name) FROM public.accounts a LEFT JOIN public.businesses b ON b.account_id = a.id WHERE a.id = v_merchant)));
END;
$$;

CREATE OR REPLACE FUNCTION public.app_refund_settle(orig public.locked_payment, merchant uuid, amount bigint, items jsonb, approver uuid, resolved_by text, terminal uuid, idem text, tx_id uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  r record; pb record; v_restored bigint; v_attr bigint; v_credit bigint; v_to_balance bigint; v_id uuid;
  v_pay_tip bigint; v_prior bigint; v_target bigint; v_prev_target bigint; v_tip_refund bigint := 0;
BEGIN
  -- Restock first: products are locked before balances everywhere (payments do the same), so a refund and a sale cannot deadlock.
  IF items IS NOT NULL AND orig.checkout_id IS NOT NULL THEN
    FOR r IN SELECT ci.item ->> 'product_id' AS product_id, sum(x.quantity)::int AS q
               FROM jsonb_to_recordset(items) AS x(checkout_item_id text, quantity int, restock boolean)
               JOIN public.checkouts c ON c.id = orig.checkout_id
               CROSS JOIN LATERAL jsonb_array_elements(c.items) ci(item)
              WHERE x.restock AND ci.item ->> 'id' = x.checkout_item_id AND ci.item ->> 'product_id' IS NOT NULL
              GROUP BY 1 ORDER BY 1 LOOP
      UPDATE public.products SET stock = stock + r.q WHERE id = r.product_id::uuid AND stock IS NOT NULL;
    END LOOP;
  END IF;

  FOR r IN SELECT account_id, credit_spent FROM public.balances WHERE account_id IN (merchant, orig.from_account_id) ORDER BY account_id FOR NO KEY UPDATE LOOP
    IF r.account_id = orig.from_account_id THEN pb := r; END IF;
  END LOOP;
  IF pb IS NULL THEN RAISE EXCEPTION 'balances row missing'; END IF;
  SELECT coalesce(sum(credit_amount), 0) INTO v_restored FROM public.transactions WHERE type = 'refund' AND status = 'completed' AND related_id = orig.id;
  v_attr := greatest(orig.credit_amount - v_restored, 0);
  v_credit := least(amount, v_attr, pb.credit_spent);
  v_to_balance := amount - v_credit;

  -- The tip part of this refund: refunds take the non-tip part of the payment first (item refunds never reach the tip); only what goes beyond it
  -- returns tip money, and it is taken back from the people who were tipped in proportion to what each got.
  SELECT coalesce(sum(tp.amount), 0) INTO v_pay_tip FROM public.tips tp WHERE tp.transaction_id = orig.id;
  IF v_pay_tip > 0 THEN
    SELECT coalesce(sum(t.amount), 0) INTO v_prior FROM public.transactions t WHERE t.type = 'refund' AND t.status = 'completed' AND t.related_id = orig.id;
    v_prev_target := least(v_pay_tip, greatest(0, v_prior - (orig.amount - v_pay_tip)));
    v_target := least(v_pay_tip, greatest(0, v_prior + amount - (orig.amount - v_pay_tip)));
    v_tip_refund := v_target - v_prev_target;
  END IF;

  UPDATE public.balances SET balance = balance - amount WHERE account_id = merchant;
  -- back to an earmarked wallet (a Benefits wallet gets its own money back; refunds are never capped and never counted against the daily value)
  UPDATE public.wallets SET balance = balance + v_to_balance WHERE id = orig.from_wallet_id AND balance IS NOT NULL AND v_to_balance > 0;
  UPDATE public.balances SET balance = balance + v_to_balance, credit_spent = credit_spent - v_credit WHERE account_id = orig.from_account_id;
  INSERT INTO public.transactions (id, type, status, from_wallet_id, to_wallet_id, amount, credit_amount, related_id, terminal_id, checkout_id, account_id, idem, meta)
  VALUES (coalesce(tx_id, uuidv7()), 'refund', 'completed', orig.merchant_wallet_id, orig.from_wallet_id, amount, v_credit, orig.id, terminal, orig.checkout_id,
          coalesce(approver, CASE WHEN resolved_by IS NOT NULL THEN '00000000-0000-7000-8000-000000000001'::uuid ELSE merchant END), idem,
          (CASE WHEN items IS NOT NULL THEN jsonb_build_object('items', items) ELSE '{}'::jsonb END)
          || (CASE WHEN approver IS NOT NULL OR resolved_by IS NOT NULL THEN jsonb_build_object('approved', true) ELSE '{}'::jsonb END)
          || (CASE WHEN resolved_by IS NOT NULL THEN jsonb_build_object('provider_reference', resolved_by) ELSE '{}'::jsonb END))
  RETURNING id INTO v_id;

  IF v_tip_refund > 0 THEN
    -- cumulative share of each person at the new target (largest remainder, fixed tie order), less what earlier refunds already took back
    INSERT INTO public.tips (transaction_id, account_id, staff_account_id, amount)
    SELECT v_id, merchant, a.staff_account_id, -(a.alloc - coalesce(d.taken, 0))
      FROM (SELECT f.staff_account_id, f.fl + CASE WHEN f.rk <= f.spare THEN 1 ELSE 0 END AS alloc
              FROM (SELECT s.staff_account_id, (v_target * s.amount) / s.tot AS fl,
                           row_number() OVER (ORDER BY (v_target * s.amount) % s.tot DESC, s.amount DESC, s.staff_account_id) AS rk,
                           v_target - sum((v_target * s.amount) / s.tot) OVER () AS spare
                      FROM (SELECT tp.staff_account_id, tp.amount, sum(tp.amount) OVER () AS tot FROM public.tips tp WHERE tp.transaction_id = orig.id) s) f) a
      LEFT JOIN (SELECT k.staff_account_id, -sum(k.amount) AS taken FROM public.tips k JOIN public.transactions rt ON rt.id = k.transaction_id
                  WHERE rt.type = 'refund' AND rt.status = 'completed' AND rt.related_id = orig.id AND rt.id <> v_id GROUP BY 1) d
        ON d.staff_account_id = a.staff_account_id
     WHERE a.alloc - coalesce(d.taken, 0) <> 0;
    IF (SELECT coalesce(sum(tp.amount), 0) FROM public.tips tp WHERE tp.transaction_id = v_id) <> -v_tip_refund THEN RAISE EXCEPTION 'refund tips do not add up'; END IF;
  END IF;
  RETURN v_id;
END;
$$;
