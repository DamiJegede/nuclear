-- Scheme v2: the money moves as SQL functions (docs/SCHEME-V2.md, section 6). Each is ONE database call that locks, checks, writes and returns,
-- so the row locks are held for the milliseconds the function runs instead of across several network round trips. A call is its own
-- transaction (a plain `select app_send(...)`); every decline is returned as data after writing the declined transaction, so a decline
-- commits just like a success. The functions take and return jsonb (amounts as JSON numbers, far below 2^53) and hold exactly the rules
-- the application used to apply in several statements; the test suites exercise them through the API.

-- An answer for something that is refused before anything is recorded (an unknown wallet, a bad combination): nothing is written.
CREATE FUNCTION public.app_err(code text, http int) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT jsonb_build_object('kind', 'error', 'error', code, 'status', http) $$;

-- A transaction as readers see it (the txn view's column names), as json.
CREATE FUNCTION public.app_txrow(tx_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object('id', id, 'type', type, 'status', status, 'status_code', status_code, 'amount', amount,
                            'from_account_id', from_account_id, 'to_account_id', to_account_id,
                            'from_wallet_id', from_wallet_id, 'to_wallet_id', to_wallet_id,
                            'timestamp', "timestamp", 'completed_at', completed_at)
    FROM public.txn WHERE id = tx_id
$$;

-- The daily-cap numbers of a consumer's balances row for today: a row from an earlier day rolls itself (opening = what it holds less its
-- Benefits wallets, nothing added yet). Returns the room left for ordinary money: cap - opening - added today - pending loads, never below 0.
CREATE FUNCTION public.cap_headroom(acct uuid, bal bigint, opening bigint, opening_day date, added bigint, pending bigint, cap bigint) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  SELECT greatest(cap - CASE WHEN opening_day < public.program_today()
                             THEN bal - coalesce((SELECT sum(w.balance) FROM public.wallets w WHERE w.account_id = acct AND w.type = 'benefits'), 0)
                             ELSE opening + added END - pending, 0)
$$;

-- Where a consumer's row stands today after `add` more ordinary money arrives: (opening, added).
CREATE FUNCTION public.cap_after(acct uuid, bal bigint, opening bigint, opening_day date, added bigint, add_amount bigint, OUT new_opening bigint, OUT new_added bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE WHEN opening_day < public.program_today()
              THEN bal - coalesce((SELECT sum(w.balance) FROM public.wallets w WHERE w.account_id = acct AND w.type = 'benefits'), 0)
              ELSE opening END,
         CASE WHEN opening_day < public.program_today() THEN 0 ELSE added END + add_amount
$$;

-- Wallet to wallet send of funded balance (never credit). p: actor, device?, auth_wallet?, from_wallet?, to_wallet, amount, key, cap.
CREATE FUNCTION public.app_send(p jsonb) RETURNS jsonb
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
  SELECT status, allow_send, daily_limit, CASE WHEN spent_day = v_today THEN spent_today ELSE 0 END AS spent, balance INTO sw
    FROM public.wallets WHERE id = f.id FOR NO KEY UPDATE;
  SELECT status INTO v_fa_status FROM public.accounts WHERE id = f.account_id;
  SELECT status INTO v_rw_status FROM public.wallets WHERE id = t.id FOR SHARE;
  SELECT status INTO v_ra_status FROM public.accounts WHERE id = t.account_id;
  SELECT coalesce(sum(balance), 0) INTO v_em FROM public.wallets WHERE account_id = f.account_id AND balance IS NOT NULL;

  SELECT id, status, amount, from_wallet_id, to_wallet_id INTO v_prev FROM public.transactions WHERE idem = v_idem;
  IF FOUND THEN
    IF v_prev.from_wallet_id <> f.id OR v_prev.to_wallet_id <> t.id OR v_prev.amount <> v_amount THEN
      RETURN public.app_err('idempotency_mismatch', 409);
    END IF;
    RETURN jsonb_build_object('kind', CASE v_prev.status WHEN 'completed' THEN 'ok' ELSE 'declined' END, 'replayed', true, 'tx', public.app_txrow(v_prev.id));
  END IF;

  -- An earmarked wallet spends only its own balance; otherwise the account's funds minus what is earmarked for other wallets.
  v_funds := CASE WHEN sw.balance IS NOT NULL THEN sw.balance ELSE greatest(sb.balance - v_em, 0) END;
  IF t.atype = 'C' THEN v_room := public.cap_headroom(t.account_id, rb.balance, rb.ordinary_opening, rb.opening_day, rb.added_today, rb.balance_pending, v_cap); END IF;

  IF v_fa_status IS DISTINCT FROM 'active' OR sw.status IS DISTINCT FROM 'active' THEN v_code := 'sender_unavailable';
  ELSIF NOT sw.allow_send THEN v_code := 'send_not_allowed';
  ELSIF sb.balance < 0 OR sb.credit_spent > sb.credit_limit THEN v_code := 'account_restricted';
  ELSIF v_rw_status IS DISTINCT FROM 'active' OR v_ra_status IS DISTINCT FROM 'active' THEN v_code := 'recipient_unavailable';
  ELSIF v_funds < v_amount THEN v_code := CASE WHEN sw.balance IS NOT NULL THEN 'wallet_balance_exceeded' ELSE 'insufficient_balance' END;
  ELSIF sw.daily_limit IS NOT NULL AND sw.spent + v_amount > sw.daily_limit THEN v_code := 'spend_limit_exceeded';
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

-- A payment as readers see it, as json.
CREATE FUNCTION public.app_payrow(tx_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object('id', id, 'status', status, 'status_code', status_code, 'amount', amount,
                            'from_account_id', from_account_id, 'to_account_id', to_account_id, 'from_wallet_id', from_wallet_id,
                            'tag_id', tag_id, 'terminal_id', terminal_id, 'checkout_id', checkout_id, 'reference', reference,
                            'idempotency_key', idempotency_key, 'timestamp', "timestamp", 'completed_at', completed_at)
    FROM public.txn WHERE id = tx_id
$$;

-- Can this product line be sold now? Returns the reason it cannot, or null.
CREATE FUNCTION public.product_blocker(prod public.products, qty int) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE WHEN NOT prod.active OR prod.status <> 'available' THEN 'product_unavailable'
              WHEN prod.currency <> 'USD' THEN 'currency_unsupported'
              WHEN prod.stock IS NOT NULL AND prod.stock < qty THEN 'out_of_stock' END
$$;

-- Planning a payment before anything is consumed (a tap, a key): resolve the checkout or price the one-step cart, and refuse unsellable
-- carts early, so a catalogue mistake never burns a tap. p: merchant, checkout_id?, amount?, items? ([{product_id, quantity}]), reference?.
-- Answers {checkout_id, total} for an existing checkout, {create: {lines, total, reference}, total} for a one-step payment, or an error.
CREATE FUNCTION public.app_pay_plan(p jsonb) RETURNS jsonb
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

-- Settle a checkout (or a bare amount) with a payment: idempotent per attempt key, locks the checkout, its products (stable order), then
-- both balance rows and the payer wallet. A decline is written as a declined transaction; stock is taken only when the payment completes.
-- p: payer_wallet, payer_account, merchant, actor, terminal_id?, tag_id?, tag_limit?, key, checkout_id? | create {lines,total,reference}, expect_amount?.
CREATE FUNCTION public.app_pay_checkout(p jsonb) RETURNS jsonb
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
BEGIN
  -- Replay first, so a retry never creates a second checkout.
  SELECT id, status, amount, from_wallet_id, tag_id, checkout_id, reference INTO v_prev
    FROM public.transactions WHERE idem = v_idem;
  IF FOUND THEN
    IF nullif(p ->> 'expect_amount', '') IS NOT NULL AND (p ->> 'expect_amount')::bigint <> v_prev.amount THEN RETURN jsonb_build_object('kind', 'conflict'); END IF;
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
    IF jsonb_array_length(p -> 'create' -> 'lines') > 0 THEN
      v_items := p -> 'create' -> 'lines';
      INSERT INTO public.checkouts (account_id, terminal_id, reference, total, items, status)
      VALUES (v_merchant, v_terminal, v_reference, v_amount, v_items, 'paid') RETURNING id INTO v_co_id;
      v_created := true;
    END IF;
  END IF;

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
    IF v_created THEN UPDATE public.checkouts SET status = 'canceled' WHERE id = v_co_id; END IF;
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

  -- Take the stock and count the sale (products in id order, the lock order); an existing checkout is now paid.
  FOR r IN SELECT (i ->> 'product_id')::uuid AS product_id, sum((i ->> 'quantity')::int)::int AS qty
             FROM jsonb_array_elements(v_items) i WHERE i ->> 'product_id' IS NOT NULL GROUP BY 1 ORDER BY 1 LOOP
    UPDATE public.products SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - r.qty END, total_sold = total_sold + r.qty,
                               sold_today = CASE WHEN sold_day = v_today THEN sold_today + r.qty ELSE r.qty END, sold_day = v_today
     WHERE id = r.product_id;
  END LOOP;
  IF v_co_id IS NOT NULL AND NOT v_created THEN UPDATE public.checkouts SET status = 'paid' WHERE id = v_co_id; END IF;
  RETURN jsonb_build_object('kind', 'ok', 'replayed', false, 'row', public.app_payrow(v_id));
END;
$$;

-- Pay with a tap: the terminal's account is the merchant. p: merchant, terminal_id, uid, counter, key, checkout_id? | amount?/items?, reference?.
-- Everything is one call: plan (before the tap is burned), the tag (its proof is single-use and is consumed with the outcome, even when
-- the attempt is declined, unassigned or locked), then the payment.
CREATE FUNCTION public.app_pay_tap(p jsonb) RETURNS jsonb
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

  SELECT id, status, amount, tag_id INTO v_prev FROM public.transactions WHERE idem = v_idem;
  IF FOUND THEN
    IF v_prev.tag_id IS DISTINCT FROM tg.id OR (nullif(p ->> 'amount', '') IS NOT NULL AND v_prev.amount <> (p ->> 'amount')::bigint) THEN
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
    'checkout_id', v_plan -> 'checkout_id', 'create', v_plan -> 'create', 'expect_amount', p -> 'amount'));
  RETURN v_out || jsonb_build_object('payer', (SELECT jsonb_build_object('display_name', display_name, 'photo', photo) FROM public.wallets WHERE id = tg.wallet_id));
END;
$$;

-- Pay in the customer's app (the customer's own call is the confirmation). p: payer_account, auth_wallet?, from_wallet?, checkout_id? | terminal_id +
-- amount?/items?, reference?, key (the customer's key; namespaced per payer here).
CREATE FUNCTION public.app_pay_app(p jsonb) RETURNS jsonb
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
                                                     'items', p -> 'items', 'reference', p -> 'reference'));
    IF v_plan ->> 'kind' = 'error' THEN RETURN v_plan; END IF;
  END IF;

  v_out := public.app_pay_checkout(jsonb_build_object(
    'payer_wallet', v_wallet, 'payer_account', v_payer, 'merchant', v_merchant, 'actor', v_payer,
    'terminal_id', v_terminal, 'key', v_key, 'checkout_id', v_plan -> 'checkout_id', 'create', v_plan -> 'create', 'expect_amount', p -> 'amount'));
  RETURN v_out || jsonb_build_object('merchant', jsonb_build_object('account_id', v_merchant,
           'display_name', (SELECT coalesce(b.display_name, a.name) FROM public.accounts a LEFT JOIN public.businesses b ON b.account_id = a.id WHERE a.id = v_merchant)));
END;
$$;

-- A refund as readers see it, as json: a refund transaction, or a request that is waiting (or was rejected) on the refunds table.
CREATE FUNCTION public.app_refundrow(tx_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object('id', id, 'status', status, 'status_code', status_code, 'amount', amount, 'from_account_id', from_account_id,
                            'to_account_id', to_account_id, 'to_wallet_id', to_wallet_id, 'related_transaction_id', related_transaction_id,
                            'terminal_id', terminal_id, 'approved_by_account_id', approved_by_account_id, 'items', items,
                            'idempotency_key', idempotency_key, 'timestamp', "timestamp", 'completed_at', completed_at)
    FROM public.txn WHERE id = tx_id AND type = 'refund'
$$;

-- Completed refunds and reserved (pending) refunds against one payment.
CREATE FUNCTION public.app_refund_sums(pay uuid, OUT completed bigint, OUT pending bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT (SELECT coalesce(sum(amount), 0) FROM public.transactions WHERE type = 'refund' AND status = 'completed' AND related_id = pay),
         (SELECT coalesce(sum(amount), 0) FROM public.refunds WHERE pay_transaction_id = pay AND status = 'pending')
$$;

-- What a refund needs to know about the payment it refunds (read under the payment's row lock).
CREATE TYPE public.locked_payment AS (id uuid, status text, amount bigint, credit_amount bigint, from_wallet_id uuid, from_account_id uuid, checkout_id uuid, merchant_wallet_id uuid);

-- Move the money for a refund and write its transaction (an approved request keeps its own id). The merchant's balance is debited (it may
-- go below zero); the credit the customer still owes from that payment is restored first, the rest becomes funded balance. The caller
-- holds the original payment's row lock. Returns the new transaction's id.
CREATE FUNCTION public.app_refund_settle(orig public.locked_payment, merchant uuid, amount bigint, items jsonb, approver uuid, resolved_by text, terminal uuid, idem text, tx_id uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  r record; pb record; v_restored bigint; v_attr bigint; v_credit bigint; v_to_balance bigint; v_id uuid;
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
  RETURN v_id;
END;
$$;

-- Lock a payment of this merchant (by id, or by its terminal attempt) and read what a refund needs.
CREATE FUNCTION public.app_lock_payment(merchant uuid, pay_id uuid, attempt text) RETURNS public.locked_payment
    LANGUAGE plpgsql
    AS $$
DECLARE o public.locked_payment;
BEGIN
  IF pay_id IS NOT NULL THEN
    SELECT t.id, t.status, t.amount, t.credit_amount, t.from_wallet_id, fw.account_id AS from_account_id, t.checkout_id,
           (SELECT id FROM public.wallets WHERE account_id = merchant AND type = 'default') AS merchant_wallet_id INTO o
      FROM public.transactions t JOIN public.wallets fw ON fw.id = t.from_wallet_id JOIN public.wallets tw ON tw.id = t.to_wallet_id
     WHERE t.id = pay_id AND t.type = 'pay' AND tw.account_id = merchant FOR NO KEY UPDATE OF t;
  ELSE
    SELECT t.id, t.status, t.amount, t.credit_amount, t.from_wallet_id, fw.account_id AS from_account_id, t.checkout_id,
           (SELECT id FROM public.wallets WHERE account_id = merchant AND type = 'default') AS merchant_wallet_id INTO o
      FROM public.transactions t JOIN public.wallets fw ON fw.id = t.from_wallet_id
     WHERE t.type = 'pay' AND t.idem = 'pay:' || merchant || ':t:' || attempt FOR NO KEY UPDATE OF t;
  END IF;
  RETURN o;
END;
$$;

-- Create a refund against a completed payment. p: merchant, terminal_id, payment_id? | attempt?, mode (full|partial|items), amount?, items? ([{checkout_item_id,
-- quantity}]), restock?, key, disposition (execute|queue), approver?, resolved_by?. Bounded by the unrefunded amount minus pending (reserved)
-- refunds, with the payment row locked so concurrent requests serialize. Idempotent per (merchant, key).
CREATE FUNCTION public.app_refund(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_merchant uuid := (p ->> 'merchant')::uuid;
  v_terminal uuid := nullif(p ->> 'terminal_id', '')::uuid;
  v_mode text := p ->> 'mode';
  v_idem text := 'refund:' || (p ->> 'merchant') || ':' || (p ->> 'key');
  v_approver uuid := nullif(p ->> 'approver', '')::uuid;
  orig public.locked_payment; v_prev record; s record; v_remaining bigint; v_amount bigint; v_items jsonb; v_id uuid;
  v_want jsonb; r record; v_line record; v_done int; v_pend int; v_restock boolean := coalesce((p ->> 'restock')::boolean, false);
BEGIN
  orig := public.app_lock_payment(v_merchant, nullif(p ->> 'payment_id', '')::uuid, p ->> 'attempt');
  IF orig.id IS NULL THEN RETURN public.app_err('payment_not_found', 404); END IF;

  SELECT id, status, related_transaction_id INTO v_prev FROM public.txn WHERE type = 'refund' AND idempotency_key = v_idem;
  IF FOUND THEN
    IF v_prev.related_transaction_id <> orig.id THEN RETURN public.app_err('idempotency_mismatch', 409); END IF;
    SELECT * INTO s FROM public.app_refund_sums(orig.id);
    RETURN jsonb_build_object('kind', CASE v_prev.status WHEN 'completed' THEN 'ok' WHEN 'pending' THEN 'pending' ELSE 'declined' END, 'replayed', true,
                              'remaining', orig.amount - s.completed - s.pending, 'row', public.app_refundrow(v_prev.id));
  END IF;

  IF orig.status <> 'completed' THEN RETURN public.app_err('payment_not_refundable', 422); END IF;
  SELECT * INTO s FROM public.app_refund_sums(orig.id);
  v_remaining := orig.amount - s.completed - s.pending;

  IF v_mode = 'full' THEN
    IF v_remaining <= 0 THEN RETURN public.app_err(CASE WHEN s.pending > 0 THEN 'refund_pending' ELSE 'already_refunded' END, 422); END IF;
    v_amount := v_remaining;
  ELSIF v_mode = 'items' THEN
    IF orig.checkout_id IS NULL THEN RETURN public.app_err('payment_has_no_items', 422); END IF;
    -- the wanted units per line (the same line twice is one)
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'quantity', q) ORDER BY ord), '[]'::jsonb) INTO v_want
      FROM (SELECT x ->> 'checkout_item_id' AS id, sum((x ->> 'quantity')::int) AS q, min(ord) AS ord
              FROM jsonb_array_elements(p -> 'items') WITH ORDINALITY AS e(x, ord) GROUP BY 1) w;
    IF jsonb_array_length(v_want) = 0 THEN RETURN public.app_err('invalid_items', 422); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.checkouts c, jsonb_array_elements(c.items) WHERE c.id = orig.checkout_id) THEN
      RETURN public.app_err('payment_has_no_items', 422);
    END IF;
    v_amount := 0; v_items := '[]'::jsonb;
    FOR r IN SELECT x ->> 'id' AS id, (x ->> 'quantity')::int AS q FROM jsonb_array_elements(v_want) x LOOP
      SELECT (i ->> 'quantity')::int AS quantity, (i ->> 'unit_price')::bigint AS unit_price, (i ->> 'discount')::bigint AS discount INTO v_line
        FROM public.checkouts c, jsonb_array_elements(c.items) i WHERE c.id = orig.checkout_id AND i ->> 'id' = r.id;
      IF NOT FOUND THEN RETURN public.app_err('item_not_found', 404); END IF;
      -- free units = quantity - refunded - reserved by pending refunds (read under the payment's row lock)
      SELECT coalesce(sum((x ->> 'quantity')::int), 0) INTO v_done
        FROM public.transactions t, jsonb_array_elements(t.meta -> 'items') x
       WHERE t.type = 'refund' AND t.status = 'completed' AND t.related_id = orig.id AND t.meta ? 'items' AND x ->> 'checkout_item_id' = r.id;
      SELECT coalesce(sum((x ->> 'quantity')::int), 0) INTO v_pend
        FROM public.refunds q, jsonb_array_elements(q.items) x
       WHERE q.pay_transaction_id = orig.id AND q.status = 'pending' AND q.items IS NOT NULL AND x ->> 'checkout_item_id' = r.id;
      IF r.q > v_line.quantity - v_done - v_pend THEN RETURN public.app_err('item_quantity_exceeded', 422); END IF;
      v_amount := v_amount + (v_line.unit_price - v_line.discount) * r.q;
      v_items := v_items || jsonb_build_array(jsonb_build_object('checkout_item_id', r.id, 'quantity', r.q, 'restock', v_restock));
    END LOOP;
    IF v_amount <= 0 THEN RETURN public.app_err('invalid_amount', 422); END IF;
  ELSE
    v_amount := nullif(p ->> 'amount', '')::bigint;
    IF v_amount IS NULL OR v_amount <= 0 THEN RETURN public.app_err('invalid_amount', 422); END IF;
  END IF;

  IF v_amount > v_remaining THEN
    INSERT INTO public.transactions (type, status, status_code, from_wallet_id, to_wallet_id, amount, related_id, terminal_id, checkout_id, account_id, idem, meta)
    VALUES ('refund', 'declined', 'exceeds_refundable', orig.merchant_wallet_id, orig.from_wallet_id, v_amount, orig.id, v_terminal, orig.checkout_id, v_merchant, v_idem,
            CASE WHEN v_items IS NOT NULL THEN jsonb_build_object('items', v_items) ELSE '{}'::jsonb END)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('kind', 'declined', 'replayed', false, 'remaining', v_remaining, 'row', public.app_refundrow(v_id));
  END IF;

  IF p ->> 'disposition' = 'queue' THEN
    -- A pending request reserves its amount and units; the refund transaction is written when it is approved.
    INSERT INTO public.refunds (merchant_account_id, pay_transaction_id, terminal_id, amount, mode, items, idem)
    VALUES (v_merchant, orig.id, v_terminal, v_amount, v_mode, v_items, v_idem) RETURNING id INTO v_id;
    RETURN jsonb_build_object('kind', 'pending', 'replayed', false, 'remaining', v_remaining - v_amount, 'row', public.app_refundrow(v_id));
  END IF;

  v_id := public.app_refund_settle(orig, v_merchant, v_amount, v_items, v_approver, nullif(p ->> 'resolved_by', ''), v_terminal, v_idem, NULL);
  RETURN jsonb_build_object('kind', 'ok', 'replayed', false, 'remaining', v_remaining - v_amount, 'row', public.app_refundrow(v_id));
END;
$$;

-- Approve or reject a pending refund request. p: merchant, refund_id, action (approve|reject), approver?, resolved_by?. Approving moves the money
-- now and writes the refund transaction under the request's own id; rejecting only closes the request. Both are idempotent.
CREATE FUNCTION public.app_refund_resolve(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_merchant uuid := (p ->> 'merchant')::uuid;
  v_rid uuid := (p ->> 'refund_id')::uuid;
  v_action text := p ->> 'action';
  v_approver uuid := nullif(p ->> 'approver', '')::uuid;
  v_by text := nullif(p ->> 'resolved_by', '');
  q record; cur record; orig public.locked_payment; s record; v_done record; v_remaining bigint; v_id uuid;
BEGIN
  SELECT id, status, pay_transaction_id, terminal_id, amount, items, idem INTO q FROM public.refunds WHERE id = v_rid AND merchant_account_id = v_merchant;
  IF NOT FOUND THEN
    -- A refund that was never a request (it executed at once) is already completed: approving it again changes nothing.
    SELECT id, status, related_transaction_id INTO v_done FROM public.txn WHERE id = v_rid AND type = 'refund' AND from_account_id = v_merchant;
    IF NOT FOUND THEN RETURN public.app_err('refund_not_found', 404); END IF;
    IF v_action = 'approve' AND v_done.status = 'completed' THEN
      SELECT * INTO s FROM public.app_refund_sums(v_done.related_transaction_id);
      RETURN jsonb_build_object('kind', 'ok', 'replayed', true,
        'remaining', (SELECT amount FROM public.transactions WHERE id = v_done.related_transaction_id) - s.completed - s.pending, 'row', public.app_refundrow(v_rid));
    END IF;
    RETURN public.app_err('refund_not_pending', 422);
  END IF;

  orig := public.app_lock_payment(v_merchant, q.pay_transaction_id, NULL);
  IF orig.id IS NULL THEN RETURN public.app_err('payment_not_found', 404); END IF;
  SELECT status INTO cur FROM public.refunds WHERE id = v_rid FOR NO KEY UPDATE;
  SELECT * INTO s FROM public.app_refund_sums(orig.id);
  v_remaining := orig.amount - s.completed - s.pending;

  IF v_action = 'approve' THEN
    IF cur.status = 'approved' THEN RETURN jsonb_build_object('kind', 'ok', 'replayed', true, 'remaining', v_remaining, 'row', public.app_refundrow(v_rid)); END IF;
    IF cur.status <> 'pending' THEN RETURN public.app_err('refund_not_pending', 422); END IF;
    v_id := public.app_refund_settle(orig, v_merchant, q.amount, q.items, v_approver, v_by, q.terminal_id, q.idem, v_rid);
    UPDATE public.refunds SET status = 'approved', approved_by_account_id = coalesce(v_approver, '00000000-0000-7000-8000-000000000001'::uuid), resolved_at = now() WHERE id = v_rid;
    RETURN jsonb_build_object('kind', 'ok', 'replayed', false, 'remaining', v_remaining, 'row', public.app_refundrow(v_rid));
  END IF;

  IF cur.status = 'approved' THEN RETURN public.app_err('refund_not_pending', 422); END IF;
  IF cur.status = 'pending' THEN
    UPDATE public.refunds SET status = 'rejected', resolved_at = now() WHERE id = v_rid;
    SELECT * INTO s FROM public.app_refund_sums(orig.id);
    v_remaining := orig.amount - s.completed - s.pending;
  END IF;
  RETURN jsonb_build_object('kind', 'declined', 'replayed', cur.status = 'rejected', 'remaining', v_remaining, 'row', public.app_refundrow(v_rid));
END;
$$;

-- Buy a tag model or a merchandise item with wallet balance. p: account, wallet?, kind (tag|shop), product_id, quantity, shipping?, key. The money goes to
-- the Nuclear Shop system wallet (whose balance row is never touched). Lock order: the buyer's balances row, the wallet, then the product's stock is
-- claimed last by one conditional update, so a popular item is locked for milliseconds. Stock problems are answered before anything is written; money
-- problems are written as a declined purchase.
CREATE FUNCTION public.app_purchase(p jsonb) RETURNS jsonb
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
  SELECT status, daily_limit, CASE WHEN spent_day = v_today THEN spent_today ELSE 0 END AS spent, balance INTO w FROM public.wallets WHERE id = v_wallet FOR NO KEY UPDATE;
  SELECT status INTO v_astatus FROM public.accounts WHERE id = v_acct;
  SELECT coalesce(sum(balance), 0) INTO v_em FROM public.wallets WHERE account_id = v_acct AND balance IS NOT NULL;

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
  v_funds := CASE WHEN w.balance IS NOT NULL THEN w.balance ELSE greatest(b.balance - v_em, 0) END;
  IF v_astatus IS DISTINCT FROM 'active' OR w.status IS DISTINCT FROM 'active' THEN v_code := 'buyer_unavailable';
  ELSIF b.balance < 0 OR b.credit_spent > b.credit_limit THEN v_code := 'account_restricted';
  ELSIF v_funds < v_total THEN v_code := CASE WHEN w.balance IS NOT NULL THEN 'wallet_balance_exceeded' ELSE 'insufficient_balance' END;   -- funded balance only, never credit
  ELSIF w.daily_limit IS NOT NULL AND w.spent + v_total > w.daily_limit THEN v_code := 'spend_limit_exceeded';
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
