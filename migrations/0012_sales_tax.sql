-- Sales tax (COMPETITION.md PAY-03, first part): the merchant's rate and pricing mode live on `businesses` (`tax_rate` in basis points, 825 = 8.25%;
-- `tax_included` says whether prices already contain it), each product says whether it is `taxable`, and a checkout records what was charged:
-- `checkouts.sales_tax`. `checkouts.total` is what the items cost to pay (tax added on top when it is not included), so the payment functions are unchanged
-- and the tip stays outside it; the tax is NOT part of `total - sales_tax` when it is included (the price already contained it). Each snapshot line carries
-- its `taxable`, `tax_rate`, `tax_included` and its `tax` share, so later rate or catalog changes never rewrite an old order. An amount-only payment has no
-- items and no tax (the amount is final).

ALTER TABLE businesses
  ADD COLUMN tax_rate integer NOT NULL DEFAULT 0 CONSTRAINT businesses_tax_rate_check CHECK (tax_rate BETWEEN 0 AND 3000),
  ADD COLUMN tax_included boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN taxable boolean NOT NULL DEFAULT true;
ALTER TABLE checkouts ADD COLUMN sales_tax bigint NOT NULL DEFAULT 0 CONSTRAINT checkouts_sales_tax_check CHECK (sales_tax >= 0 AND sales_tax <= total);

-- app_tax(merchant, lines): lines [{unit_price, discount, quantity, taxable, ...}] -> {lines (each with tax_rate, tax_included, tax), sales_tax, total}.
-- ONE rounding per order (half up) on the taxable net, then the tax is shared over the taxable lines by largest remainder so the shares add up exactly.
CREATE FUNCTION public.app_tax(p_merchant uuid, p_lines jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_rate int; v_inc boolean; v_k bigint; v_d bigint;
  v_n int := jsonb_array_length(p_lines);
  v_net bigint[] := ARRAY[]::bigint[]; v_tx boolean[] := ARRAY[]::boolean[]; v_share bigint[] := ARRAY[]::bigint[]; v_rem bigint[] := ARRAY[]::bigint[];
  v_sub bigint := 0; v_taxable bigint := 0; v_tax bigint; v_left bigint; v_best int; v_out jsonb := '[]'::jsonb; i int; l jsonb;
BEGIN
  SELECT coalesce(b.tax_rate, 0), coalesce(b.tax_included, false) INTO v_rate, v_inc FROM public.businesses b WHERE b.account_id = p_merchant;
  v_rate := coalesce(v_rate, 0); v_inc := coalesce(v_inc, false);
  v_k := v_rate; v_d := CASE WHEN v_inc THEN 10000 + v_rate ELSE 10000 END;
  FOR i IN 1..v_n LOOP
    l := p_lines -> (i - 1);
    v_net := v_net || ((l ->> 'unit_price')::bigint - coalesce((l ->> 'discount')::bigint, 0)) * (l ->> 'quantity')::bigint;
    v_tx := v_tx || (coalesce((l ->> 'taxable')::boolean, true) AND v_rate > 0);
    v_sub := v_sub + v_net[i];
    IF v_tx[i] THEN v_taxable := v_taxable + v_net[i]; END IF;
  END LOOP;
  v_tax := CASE WHEN v_rate = 0 THEN 0 ELSE (v_taxable * v_k * 2 + v_d) / (2 * v_d) END;
  v_left := v_tax;
  FOR i IN 1..v_n LOOP
    IF v_tx[i] THEN v_share := v_share || (v_net[i] * v_k) / v_d; v_rem := v_rem || (v_net[i] * v_k) % v_d; v_left := v_left - v_share[i];
    ELSE v_share := v_share || 0::bigint; v_rem := v_rem || -1::bigint; END IF;
  END LOOP;
  WHILE v_left > 0 LOOP
    v_best := NULL;
    FOR i IN 1..v_n LOOP
      IF v_tx[i] AND (v_best IS NULL OR v_rem[i] > v_rem[v_best]) THEN v_best := i; END IF;
    END LOOP;
    EXIT WHEN v_best IS NULL;
    v_share[v_best] := v_share[v_best] + 1; v_rem[v_best] := -1; v_left := v_left - 1;
  END LOOP;
  FOR i IN 1..v_n LOOP
    v_out := v_out || jsonb_build_array((p_lines -> (i - 1)) || jsonb_build_object('taxable', coalesce((p_lines -> (i - 1) ->> 'taxable')::boolean, true),
                                         'tax_rate', CASE WHEN v_tx[i] THEN v_rate ELSE 0 END, 'tax_included', v_inc, 'tax', v_share[i]));
  END LOOP;
  RETURN jsonb_build_object('lines', v_out, 'sales_tax', v_tax, 'total', CASE WHEN v_inc THEN v_sub ELSE v_sub + v_tax END);
END;
$$;

-- Planning a payment prices the cart with its tax; the checkout it creates records `sales_tax`.
CREATE OR REPLACE FUNCTION public.app_pay_plan_base(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_merchant uuid := (p ->> 'merchant')::uuid;
  v_co public.checkouts;
  v_status text; v_bad text; v_lines jsonb := '[]'::jsonb; v_total bigint := 0; r record; v_prod public.products; v_tax jsonb;
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
                                                               'unit_price', v_prod.price, 'discount', v_prod.discount, 'quantity', r.qty, 'taxable', v_prod.taxable));
    END LOOP;
    IF v_total <= 0 OR v_total > 1000000000 THEN RETURN public.app_err('invalid_total', 422); END IF;
    -- sales tax from the merchant's rate and each product's taxability: the lines come back with their share, the total with the tax when it is added
    v_tax := public.app_tax(v_merchant, v_lines);
    v_lines := v_tax -> 'lines'; v_total := (v_tax ->> 'total')::bigint;
    IF nullif(p ->> 'amount', '') IS NOT NULL AND (p ->> 'amount')::bigint <> v_total THEN RETURN public.app_err('amount_mismatch', 400); END IF;
    RETURN jsonb_build_object('create', jsonb_build_object('lines', v_lines, 'total', v_total, 'sales_tax', (v_tax ->> 'sales_tax')::bigint, 'reference', p -> 'reference'), 'total', v_total);
  END IF;

  RETURN jsonb_build_object('create', jsonb_build_object('lines', '[]'::jsonb, 'total', (p ->> 'amount')::bigint, 'reference', p -> 'reference'),
                            'total', (p ->> 'amount')::bigint);
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
