-- Fund holds (docs/TABS.md, "Fund holds"; owner, 2026-10-31). A hold sets money aside on a wallet for one shared tab: the money stays in the balance but
-- nothing else can spend, send, buy with, move or earmark it. `wallets.held` is the sum of the wallet's active holds (the only new column: nothing is added
-- to `balances`); `fund_holds` says who holds what for which tab. A wallet with its own money (earmarked or Benefits) spends `balance - held`; a shared wallet's
-- holds come off the account's shared pool, in the SAME sum that already gives the earmark (`v_em`), so the hot path gains no query. A hold also reserves the
-- wallet's daily limit (`spent_today + held + amount <= limit`). With no holds nothing changes.
-- `fund_holds.tab_id` gets its foreign key with the tab tables (0015). Holds are written only by the tab functions (0015) and the release helpers.

ALTER TABLE wallets
  ADD COLUMN held bigint NOT NULL DEFAULT 0 CONSTRAINT wallets_held_check CHECK (held >= 0),
  ADD CONSTRAINT wallets_held_within_own_balance CHECK (balance IS NULL OR held <= balance);

CREATE TABLE fund_holds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  kind text NOT NULL DEFAULT 'tab' CONSTRAINT fund_holds_kind_check CHECK (kind IN ('tab')),
  tab_id uuid,
  amount bigint NOT NULL CONSTRAINT fund_holds_amount_check CHECK (amount > 0 AND amount <= 1000000000),
  status text NOT NULL DEFAULT 'active' CONSTRAINT fund_holds_status_check CHECK (status IN ('active', 'captured', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text CONSTRAINT fund_holds_end_reason_check CHECK (end_reason IN ('paid', 'reopened', 'left', 'removed', 'mode_changed', 'canceled', 'expired', 'withdrawn_by_system')),
  transaction_id uuid REFERENCES transactions(id),
  CONSTRAINT fund_holds_ended_check CHECK ((status = 'active') = (ended_at IS NULL AND end_reason IS NULL)),
  CONSTRAINT fund_holds_captured_check CHECK ((status = 'captured') = (end_reason = 'paid'))
);
CREATE UNIQUE INDEX fund_holds_active_key ON fund_holds (tab_id, wallet_id) WHERE status = 'active';
CREATE INDEX fund_holds_wallet_idx ON fund_holds (wallet_id) WHERE status = 'active';
CREATE INDEX fund_holds_tab_idx ON fund_holds (tab_id);

-- An ended hold never changes; an active one may change its amount only.
CREATE FUNCTION public.fund_holds_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fund holds are never deleted'; END IF;
  IF OLD.status <> 'active' THEN RAISE EXCEPTION 'an ended fund hold is frozen'; END IF;
  IF NEW.account_id <> OLD.account_id OR NEW.wallet_id <> OLD.wallet_id OR NEW.tab_id IS DISTINCT FROM OLD.tab_id OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'a fund hold keeps its holder and tab';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fund_holds_frozen BEFORE UPDATE OR DELETE ON fund_holds FOR EACH ROW EXECUTE FUNCTION public.fund_holds_frozen();

-- What an account can spend from its shared funds: the balance less what is set aside in earmarked wallets and in the holds of shared wallets.
CREATE OR REPLACE FUNCTION public.shared_funds(acct uuid) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$ SELECT coalesce((SELECT balance FROM balances WHERE account_id = acct), 0)
               - coalesce((SELECT sum(CASE WHEN balance IS NOT NULL THEN balance ELSE held END) FROM wallets WHERE account_id = acct), 0) $$;

-- app_send, availability and daily limit read the wallet's holds.
CREATE OR REPLACE FUNCTION public.app_send(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_actor uuid := (p ->> 'actor')::uuid;
  v_auth uuid := nullif(p ->> 'auth_wallet', '')::uuid;
  v_want uuid;
  v_amount bigint := (p ->> 'amount')::bigint;
  v_cap bigint := (p ->> 'cap')::bigint;
  v_today date := public.program_today();
  f record; t record; r record; sb record; rb record; sw record;
  v_idem text; v_prev record;
  v_fa_status text; v_ra_status text; v_rw_status text;
  v_em bigint; v_funds bigint; v_code text;
  v_id uuid; v_room bigint; v_open bigint; v_added bigint;
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

  SELECT id, account_id, type INTO f FROM public.wallets
   WHERE account_id = v_actor AND (CASE WHEN v_want IS NULL THEN type = 'default' ELSE id = v_want END);
  IF NOT FOUND THEN RETURN public.app_err('wallet_not_found', 404); END IF;
  SELECT w.id, w.account_id, w.type AS wtype, a.type AS atype INTO t
    FROM public.wallets w JOIN public.accounts a ON a.id = w.account_id WHERE w.id = (p ->> 'to_wallet')::uuid;
  IF NOT FOUND THEN RETURN public.app_err('recipient_not_found', 404); END IF;
  IF t.id = f.id THEN RETURN public.app_err('same_wallet', 422); END IF;
  -- Benefits money never leaves the account as a transfer, and only its bound employer can put money into a Benefits wallet.
  IF f.type = 'benefits' THEN RETURN public.app_err('benefits_wallet_not_transferable', 422); END IF;
  IF t.wtype = 'benefits' THEN RETURN public.app_err('recipient_not_eligible', 422); END IF;
  -- Wallets of one account share funds; budget changes authority, it does not move money.
  IF t.account_id = f.account_id THEN RETURN public.app_err('same_account', 422); END IF;
  IF t.atype <> 'C' OR t.wtype IN ('system', 'escrow') THEN RETURN public.app_err('recipient_not_eligible', 422); END IF;

  v_idem := 'send:' || f.account_id || ':' || (p ->> 'key');

  -- Lock order: both balance rows (stable order), then the sender wallet. The key is read under those locks, so a concurrent retry waits and replays.
  FOR r IN SELECT account_id, balance, credit_limit, credit_spent, balance_pending, ordinary_opening, opening_day, added_today
             FROM public.balances WHERE account_id IN (f.account_id, t.account_id) ORDER BY account_id FOR NO KEY UPDATE LOOP
    IF r.account_id = f.account_id THEN sb := r; END IF;
    IF r.account_id = t.account_id THEN rb := r; END IF;
  END LOOP;
  IF sb IS NULL OR rb IS NULL THEN RAISE EXCEPTION 'balances row missing'; END IF;
  SELECT status, allow_send, daily_limit, CASE WHEN spent_day = v_today THEN spent_today ELSE 0 END AS spent, balance, held INTO sw
    FROM public.wallets WHERE id = f.id FOR NO KEY UPDATE;
  SELECT status INTO v_fa_status FROM public.accounts WHERE id = f.account_id;
  SELECT status INTO v_rw_status FROM public.wallets WHERE id = t.id FOR SHARE;
  SELECT status INTO v_ra_status FROM public.accounts WHERE id = t.account_id;
  SELECT coalesce(sum(CASE WHEN balance IS NOT NULL THEN balance ELSE held END), 0) INTO v_em FROM public.wallets WHERE account_id = f.account_id;

  SELECT id, status, amount, from_wallet_id, to_wallet_id INTO v_prev FROM public.transactions WHERE idem = v_idem;
  IF FOUND THEN
    IF v_prev.from_wallet_id <> f.id OR v_prev.to_wallet_id <> t.id OR v_prev.amount <> v_amount THEN
      RETURN public.app_err('idempotency_mismatch', 409);
    END IF;
    RETURN jsonb_build_object('kind', CASE v_prev.status WHEN 'completed' THEN 'ok' ELSE 'declined' END, 'replayed', true, 'tx', public.app_txrow(v_prev.id));
  END IF;

  -- An earmarked wallet spends only its own balance; otherwise the account's funds minus what is earmarked for other wallets.
  v_funds := CASE WHEN sw.balance IS NOT NULL THEN greatest(sw.balance - sw.held, 0) ELSE greatest(sb.balance - v_em, 0) END;
  IF t.atype = 'C' THEN v_room := public.cap_headroom(t.account_id, rb.balance, rb.ordinary_opening, rb.opening_day, rb.added_today, rb.balance_pending, v_cap); END IF;

  IF v_fa_status IS DISTINCT FROM 'active' OR sw.status IS DISTINCT FROM 'active' THEN v_code := 'sender_unavailable';
  ELSIF NOT sw.allow_send THEN v_code := 'send_not_allowed';
  ELSIF sb.balance < 0 OR sb.credit_spent > sb.credit_limit THEN v_code := 'account_restricted';
  ELSIF v_rw_status IS DISTINCT FROM 'active' OR v_ra_status IS DISTINCT FROM 'active' THEN v_code := 'recipient_unavailable';
  ELSIF v_funds < v_amount THEN v_code := CASE WHEN sw.balance IS NOT NULL THEN 'wallet_balance_exceeded' ELSE 'insufficient_balance' END;
  ELSIF sw.daily_limit IS NOT NULL AND sw.spent + sw.held + v_amount > sw.daily_limit THEN v_code := 'spend_limit_exceeded';
  ELSIF t.atype = 'C' AND v_room < v_amount THEN v_code := 'recipient_limit_exceeded';
  END IF;

  IF v_code IS NOT NULL THEN
    INSERT INTO public.transactions (type, status, status_code, from_wallet_id, to_wallet_id, amount, account_id, idem)
    VALUES ('send', 'declined', v_code, f.id, t.id, v_amount, v_actor, v_idem) RETURNING id INTO v_id;
    RETURN jsonb_build_object('kind', 'declined', 'replayed', false, 'tx', public.app_txrow(v_id));
  END IF;

  UPDATE public.balances SET balance = balance - v_amount WHERE account_id = f.account_id;
  IF t.atype = 'C' THEN
    SELECT new_opening, new_added INTO v_open, v_added FROM public.cap_after(t.account_id, rb.balance, rb.ordinary_opening, rb.opening_day, rb.added_today, v_amount);
    UPDATE public.balances SET balance = balance + v_amount, ordinary_opening = v_open, added_today = v_added, opening_day = greatest(opening_day, v_today)
     WHERE account_id = t.account_id;
  ELSE
    UPDATE public.balances SET balance = balance + v_amount WHERE account_id = t.account_id;
  END IF;
  UPDATE public.wallets SET spent_today = CASE WHEN spent_day = v_today THEN spent_today + v_amount ELSE v_amount END, spent_day = v_today,
                            balance = CASE WHEN balance IS NOT NULL THEN balance - v_amount ELSE balance END
   WHERE id = f.id;
  UPDATE public.wallets SET balance = balance + v_amount WHERE id = t.id AND balance IS NOT NULL;
  INSERT INTO public.transactions (type, status, from_wallet_id, to_wallet_id, amount, account_id, idem)
  VALUES ('send', 'completed', f.id, t.id, v_amount, v_actor, v_idem) RETURNING id INTO v_id;
  RETURN jsonb_build_object('kind', 'ok', 'replayed', false, 'tx', public.app_txrow(v_id));
END;
$$;

-- app_pay_checkout (the payment core of every payment).
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
    INSERT INTO public.checkouts (account_id, terminal_id, reference, total, items, status, served_by, tip_amount, sales_tax)
    VALUES (v_merchant, v_terminal, v_reference, v_amount, v_items, 'paid', v_served, v_tip, coalesce((p -> 'create' ->> 'sales_tax')::bigint, 0)) RETURNING id INTO v_co_id;
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
  SELECT status, allow_pay, daily_limit, CASE WHEN spent_day = v_today THEN spent_today ELSE 0 END AS spent, balance, held, type INTO w
    FROM public.wallets WHERE id = v_payer_w FOR NO KEY UPDATE;
  SELECT status INTO v_pa FROM public.accounts WHERE id = v_payer;
  SELECT status, type INTO v_ma FROM public.accounts WHERE id = v_merchant;
  SELECT coalesce(sum(CASE WHEN balance IS NOT NULL THEN balance ELSE held END), 0) INTO v_em FROM public.wallets WHERE account_id = v_payer;
  SELECT id INTO v_mw FROM public.wallets WHERE account_id = v_merchant AND type = 'default';
  IF pb IS NULL OR v_mw IS NULL THEN RAISE EXCEPTION 'balances row missing'; END IF;

  -- An earmarked wallet spends only its own balance (a hard limit, never credit); otherwise the account's funds minus what is earmarked
  -- for other wallets, plus approved credit.
  v_funds := CASE WHEN w.balance IS NOT NULL THEN greatest(w.balance - w.held, 0) ELSE greatest(pb.balance - v_em, 0) END;
  v_credit_avail := CASE WHEN w.balance IS NOT NULL THEN 0 ELSE greatest(pb.credit_limit - pb.credit_spent, 0) END;
  IF v_decline IS NOT NULL THEN NULL;
  ELSIF v_pa IS DISTINCT FROM 'active' OR w.status IS DISTINCT FROM 'active' THEN v_decline := 'payer_unavailable';
  ELSIF NOT w.allow_pay THEN v_decline := 'pay_not_allowed';
  ELSIF pb.balance < 0 OR pb.credit_spent > pb.credit_limit THEN v_decline := 'account_restricted';
  ELSIF v_ma.status IS DISTINCT FROM 'active' OR v_ma.type IS DISTINCT FROM 'B' THEN v_decline := 'merchant_unavailable';
  ELSIF v_tag_limit IS NOT NULL AND v_amount > v_tag_limit THEN v_decline := 'tag_limit_exceeded';
  ELSIF v_funds + v_credit_avail < v_amount THEN v_decline := CASE WHEN w.balance IS NOT NULL THEN 'wallet_balance_exceeded' ELSE 'insufficient_balance' END;
  ELSIF w.daily_limit IS NOT NULL AND w.spent + w.held + v_amount > w.daily_limit THEN v_decline := 'spend_limit_exceeded';
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

-- app_purchase (the store).
CREATE OR REPLACE FUNCTION public.app_purchase(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_acct uuid := (p ->> 'account')::uuid;
  v_kind text := p ->> 'kind';
  v_product uuid := (p ->> 'product_id')::uuid;
  v_qty int := (p ->> 'quantity')::int;
  v_idem text := 'purchase:' || (p ->> 'account') || ':' || (p ->> 'key');
  v_today date := public.program_today();
  v_wallet uuid; v_wtype text; b record; w record; v_astatus text; v_em bigint; v_prev record;
  m record; v_name text; v_price bigint; v_currency text; v_model_type text; v_digital boolean := false;
  v_total bigint; v_funds bigint; v_code text; v_tx uuid; v_order public.orders; v_claimed uuid;
BEGIN
  -- The session's device must still be live (a revoked or expired device cannot move money even though its signed token still reads).
  IF nullif(p ->> 'device', '') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.devices WHERE id = (p ->> 'device')::uuid AND revoked_at IS NULL AND session_expires_at > now()) THEN
    RETURN public.app_err('unauthorized', 401);
  END IF;
  IF nullif(p ->> 'wallet', '') IS NOT NULL THEN
    SELECT id, type INTO v_wallet, v_wtype FROM public.wallets WHERE id = (p ->> 'wallet')::uuid AND account_id = v_acct;
  ELSE
    SELECT id, type INTO v_wallet, v_wtype FROM public.wallets WHERE account_id = v_acct AND type = 'default';
  END IF;
  IF v_wallet IS NULL THEN RETURN public.app_err('wallet_not_found', 404); END IF;

  SELECT balance, credit_limit, credit_spent INTO b FROM public.balances WHERE account_id = v_acct FOR NO KEY UPDATE;
  SELECT status, daily_limit, CASE WHEN spent_day = v_today THEN spent_today ELSE 0 END AS spent, balance, held INTO w FROM public.wallets WHERE id = v_wallet FOR NO KEY UPDATE;
  SELECT status INTO v_astatus FROM public.accounts WHERE id = v_acct;
  SELECT coalesce(sum(CASE WHEN balance IS NOT NULL THEN balance ELSE held END), 0) INTO v_em FROM public.wallets WHERE account_id = v_acct;

  -- The earlier attempt for this key (a retry returns it), read under the lock.
  SELECT t.id AS tx_id, t.status AS tx_status, t.status_code AS tx_code, o.id AS oid, o.type, o.model_id, o.shop_id, o.quantity AS oqty INTO v_prev
    FROM public.transactions t LEFT JOIN public.orders o ON o.transaction_id = t.id WHERE t.type = 'purchase' AND t.idem = v_idem;
  IF FOUND THEN
    IF v_prev.tx_status = 'declined' THEN
      RETURN jsonb_build_object('kind', 'declined', 'transaction_id', v_prev.tx_id, 'code', coalesce(v_prev.tx_code, 'declined'), 'replayed', true);
    END IF;
    IF v_prev.oid IS NULL OR v_prev.type <> v_kind OR v_prev.oqty <> v_qty
       OR (CASE WHEN v_kind = 'tag' THEN v_prev.model_id ELSE v_prev.shop_id END) IS DISTINCT FROM v_product THEN
      RETURN public.app_err('idempotency_mismatch', 409);
    END IF;
    SELECT * INTO v_order FROM public.orders WHERE id = v_prev.oid;
    RETURN jsonb_build_object('kind', 'ok', 'order', to_jsonb(v_order), 'replayed', true);
  END IF;

  IF v_kind = 'tag' THEN
    IF p -> 'shipping' IS NULL OR jsonb_typeof(p -> 'shipping') <> 'object' THEN RETURN public.app_err('shipping_required', 422); END IF;
    SELECT type, name, currency, price, quantity, sold, status INTO m FROM public.tag_models WHERE id = v_product;
    IF NOT FOUND OR m.status <> 'available' OR m.price <= 0 THEN RETURN public.app_err('model_not_found', 404); END IF;
    IF m.quantity - m.sold < v_qty THEN RETURN public.app_err(CASE WHEN m.quantity - m.sold <= 0 THEN 'sold_out' ELSE 'not_enough_stock' END, 409); END IF;
    v_name := m.name; v_price := m.price; v_currency := m.currency; v_model_type := m.type;
  ELSE
    SELECT name, currency, price, stock, status, kind, file INTO m FROM public.shop WHERE id = v_product;
    IF NOT FOUND OR m.status <> 'available' OR m.price <= 0 THEN RETURN public.app_err('item_not_found', 404); END IF;
    v_digital := m.kind = 'digital';
    IF v_digital AND m.file IS NULL THEN RETURN public.app_err('item_not_found', 404); END IF;
    IF v_digital AND v_qty <> 1 THEN RETURN public.app_err('digital_quantity_one', 422); END IF;
    IF NOT v_digital AND (p -> 'shipping' IS NULL OR jsonb_typeof(p -> 'shipping') <> 'object') THEN RETURN public.app_err('shipping_required', 422); END IF;
    IF m.stock IS NOT NULL AND m.stock < v_qty THEN RETURN public.app_err(CASE WHEN m.stock <= 0 THEN 'sold_out' ELSE 'not_enough_stock' END, 409); END IF;
    v_name := m.name; v_price := m.price; v_currency := m.currency;
  END IF;

  v_total := v_price * v_qty;
  v_funds := CASE WHEN w.balance IS NOT NULL THEN greatest(w.balance - w.held, 0) ELSE greatest(b.balance - v_em, 0) END;
  IF v_astatus IS DISTINCT FROM 'active' OR w.status IS DISTINCT FROM 'active' THEN v_code := 'buyer_unavailable';
  ELSIF b.balance < 0 OR b.credit_spent > b.credit_limit THEN v_code := 'account_restricted';
  ELSIF v_funds < v_total THEN v_code := CASE WHEN w.balance IS NOT NULL THEN 'wallet_balance_exceeded' ELSE 'insufficient_balance' END;   -- funded balance only, never credit
  ELSIF w.daily_limit IS NOT NULL AND w.spent + w.held + v_total > w.daily_limit THEN v_code := 'spend_limit_exceeded';
  END IF;

  IF v_code IS NOT NULL THEN
    INSERT INTO public.transactions (type, status, status_code, from_wallet_id, to_wallet_id, amount, account_id, idem, meta)
    VALUES ('purchase', 'declined', v_code, v_wallet, '00000000-0000-7000-8000-000000000003', v_total, v_acct, v_idem,
            jsonb_build_object('kind', v_kind, 'product_id', v_product, 'quantity', v_qty)) RETURNING id INTO v_tx;
    RETURN jsonb_build_object('kind', 'declined', 'transaction_id', v_tx, 'code', v_code, 'replayed', false);
  END IF;

  -- The stock claim is conditional: if another buyer took the last units meanwhile, nothing is written and the buyer is told so.
  IF v_kind = 'tag' THEN
    UPDATE public.tag_models SET sold = sold + v_qty WHERE id = v_product AND quantity - sold >= v_qty RETURNING id INTO v_claimed;
  ELSE
    UPDATE public.shop SET sold = sold + v_qty, stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - v_qty END
     WHERE id = v_product AND (stock IS NULL OR stock >= v_qty) RETURNING id INTO v_claimed;
  END IF;
  IF v_claimed IS NULL THEN
    RETURN public.app_err(CASE WHEN (CASE WHEN v_kind = 'tag' THEN (SELECT quantity - sold FROM public.tag_models WHERE id = v_product)
                                          ELSE (SELECT stock FROM public.shop WHERE id = v_product) END) <= 0 THEN 'sold_out' ELSE 'not_enough_stock' END, 409);
  END IF;

  UPDATE public.balances SET balance = balance - v_total WHERE account_id = v_acct;
  UPDATE public.wallets SET spent_today = CASE WHEN spent_day = v_today THEN spent_today + v_total ELSE v_total END, spent_day = v_today,
                            balance = CASE WHEN balance IS NOT NULL THEN balance - v_total ELSE balance END
   WHERE id = v_wallet;
  INSERT INTO public.transactions (type, status, from_wallet_id, to_wallet_id, amount, account_id, idem, meta)
  VALUES ('purchase', 'completed', v_wallet, '00000000-0000-7000-8000-000000000003', v_total, v_acct, v_idem,
          jsonb_build_object('kind', v_kind, 'product_id', v_product, 'quantity', v_qty)) RETURNING id INTO v_tx;
  INSERT INTO public.orders (type, account_id, wallet_id, model_id, shop_id, name, model_type, quantity, unit_price, total, currency, shipping, delivery, transaction_id)
  VALUES (v_kind, v_acct, v_wallet, CASE WHEN v_kind = 'tag' THEN v_product END, CASE WHEN v_kind = 'shop' THEN v_product END,
          v_name, v_model_type, v_qty, v_price, v_total, v_currency, CASE WHEN v_digital THEN NULL ELSE p -> 'shipping' END,
          CASE WHEN v_digital THEN 'download' ELSE 'ship' END, v_tx) RETURNING * INTO v_order;
  RETURN jsonb_build_object('kind', 'ok', 'order', to_jsonb(v_order), 'replayed', false);
END;
$$;
