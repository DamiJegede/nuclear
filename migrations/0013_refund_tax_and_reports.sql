-- Sales tax, second part (COMPETITION.md PAY-03): (1) a refund returns the original tax (`transactions.meta.tax` on the refund, worked out in
-- app_refund_settle), (2) the daily merchant snapshots carry taxable and exempt sales, tax collected and tax refunded, (3) one function,
-- merchant_day_stats, is the single definition of a merchant's day (the nightly snapshot inserts from it and the live report reads it for the days
-- after the last snapshot). Days written before sales tax existed had no tax, so the new columns are rightly zero for them.

ALTER TABLE merchant_snapshots
  ADD COLUMN taxable_v bigint NOT NULL DEFAULT 0,      -- completed payments' item sales on lines that were taxed (price - discount, tax not removed)
  ADD COLUMN exempt_v bigint NOT NULL DEFAULT 0,       -- item sales on lines that carried no tax
  ADD COLUMN tax_v bigint NOT NULL DEFAULT 0,          -- sales tax collected on completed payments
  ADD COLUMN tax_refunded_v bigint NOT NULL DEFAULT 0; -- sales tax returned by completed refunds

CREATE FUNCTION public.merchant_day_stats(p_from date, p_to date, p_merchant uuid DEFAULT NULL)
RETURNS TABLE (merchant uuid, day date, pay_n bigint, pay_done_n bigint, pay_v bigint, refund_n bigint, refund_done_n bigint, refund_v bigint,
               tips_n bigint, tips_v bigint, taxable_v bigint, exempt_v bigint, tax_v bigint, tax_refunded_v bigint)
    LANGUAGE sql STABLE
    AS $$
  WITH rng AS (
    SELECT (p_from::timestamp AT TIME ZONE 'America/New_York') AS lo, ((p_to + 1)::timestamp AT TIME ZONE 'America/New_York') AS hi
  ), pays AS (
    SELECT t.id, t.status, t.amount, t.checkout_id, t.created_at, tw.account_id AS m
      FROM transactions t JOIN wallets tw ON tw.id = t.to_wallet_id, rng
     WHERE p_merchant IS NULL AND t.type = 'pay' AND t.created_at >= rng.lo AND t.created_at < rng.hi
    UNION ALL
    SELECT x.id, x.status, x.amount, x.checkout_id, x.created_at, p_merchant
      FROM wallets mw, rng, LATERAL (SELECT t.id, t.status, t.amount, t.checkout_id, t.created_at FROM transactions t
                                      WHERE t.to_wallet_id = mw.id AND t.type = 'pay' AND t.created_at >= rng.lo AND t.created_at < rng.hi) x
     WHERE p_merchant IS NOT NULL AND mw.account_id = p_merchant
  ), refs AS (
    SELECT t.id, t.status, t.amount, t.meta, t.created_at, fw.account_id AS m
      FROM transactions t JOIN wallets fw ON fw.id = t.from_wallet_id, rng
     WHERE p_merchant IS NULL AND t.type = 'refund' AND t.created_at >= rng.lo AND t.created_at < rng.hi
    UNION ALL
    SELECT x.id, x.status, x.amount, x.meta, x.created_at, p_merchant
      FROM wallets mw, rng, LATERAL (SELECT t.id, t.status, t.amount, t.meta, t.created_at FROM transactions t
                                      WHERE t.from_wallet_id = mw.id AND t.type = 'refund' AND t.created_at >= rng.lo AND t.created_at < rng.hi) x
     WHERE p_merchant IS NOT NULL AND mw.account_id = p_merchant
  ), tp AS (
    SELECT tp.account_id AS m, tp.amount, tp.created_at FROM tips tp, rng
     WHERE tp.created_at >= rng.lo AND tp.created_at < rng.hi AND (p_merchant IS NULL OR tp.account_id = p_merchant)
  ), ev AS (
    SELECT p.m, (p.created_at AT TIME ZONE 'America/New_York')::date AS d,
           1::bigint AS pay_n, (p.status = 'completed')::int::bigint AS pay_done_n, CASE WHEN p.status = 'completed' THEN p.amount ELSE 0 END::bigint AS pay_v,
           0::bigint AS refund_n, 0::bigint AS refund_done_n, 0::bigint AS refund_v, 0::bigint AS tips_n, 0::bigint AS tips_v,
           CASE WHEN p.status = 'completed' THEN l.taxed ELSE 0 END::bigint AS taxable_v, CASE WHEN p.status = 'completed' THEN l.untaxed ELSE 0 END::bigint AS exempt_v,
           CASE WHEN p.status = 'completed' THEN coalesce(c.sales_tax, 0) ELSE 0 END::bigint AS tax_v, 0::bigint AS tax_refunded_v
      FROM pays p
      LEFT JOIN checkouts c ON c.id = p.checkout_id
      LEFT JOIN LATERAL (SELECT coalesce(sum(CASE WHEN coalesce((i ->> 'tax_rate')::int, 0) > 0 THEN ((i ->> 'unit_price')::bigint - (i ->> 'discount')::bigint) * (i ->> 'quantity')::bigint END), 0) AS taxed,
                                coalesce(sum(CASE WHEN coalesce((i ->> 'tax_rate')::int, 0) = 0 THEN ((i ->> 'unit_price')::bigint - (i ->> 'discount')::bigint) * (i ->> 'quantity')::bigint END), 0) AS untaxed
                           FROM jsonb_array_elements(c.items) i) l ON p.status = 'completed'
    UNION ALL
    SELECT r.m, (r.created_at AT TIME ZONE 'America/New_York')::date, 0, 0, 0, 1, (r.status = 'completed')::int, CASE WHEN r.status = 'completed' THEN r.amount ELSE 0 END, 0, 0, 0, 0, 0,
           CASE WHEN r.status = 'completed' THEN coalesce((r.meta ->> 'tax')::bigint, 0) ELSE 0 END
      FROM refs r
    UNION ALL
    SELECT t.m, (t.created_at AT TIME ZONE 'America/New_York')::date, 0, 0, 0, 0, 0, 0, (t.amount > 0)::int, t.amount, 0, 0, 0, 0 FROM tp t
  )
  SELECT m, d, sum(pay_n)::bigint, sum(pay_done_n)::bigint, sum(pay_v)::bigint, sum(refund_n)::bigint, sum(refund_done_n)::bigint, sum(refund_v)::bigint,
         sum(tips_n)::bigint, sum(tips_v)::bigint, sum(taxable_v)::bigint, sum(exempt_v)::bigint, sum(tax_v)::bigint, sum(tax_refunded_v)::bigint
    FROM ev GROUP BY m, d;
$$;

CREATE OR REPLACE FUNCTION public.app_merchant_snapshot(p_from date, p_to date) RETURNS bigint LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO merchant_snapshots (merchant_account_id, snapshot_date, pay_n, pay_done_n, pay_v, refund_n, refund_done_n, refund_v, tips_n, tips_v, taxable_v, exempt_v, tax_v, tax_refunded_v)
    SELECT merchant, day, pay_n, pay_done_n, pay_v, refund_n, refund_done_n, refund_v, tips_n, tips_v, taxable_v, exempt_v, tax_v, tax_refunded_v FROM public.merchant_day_stats(p_from, p_to)
    ON CONFLICT (merchant_account_id, snapshot_date) DO NOTHING
    RETURNING 1
  ) SELECT count(*) FROM ins;
$$;

-- The sales tax of refunding these item units (items: [{checkout_item_id, quantity}]): per line round(line tax x units refunded so far / line units), less what
-- earlier completed refunds of the line returned, so the parts add up to the line's tax exactly. p_added_only returns 0 when the prices already contain the
-- tax (then the item price is the whole refund and the tax is only a part of it); the refund AMOUNT uses it, the recorded tax part does not.
CREATE FUNCTION public.app_item_tax(p_checkout uuid, p_pay uuid, items jsonb, p_added_only boolean) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE WHEN p_added_only AND coalesce((SELECT (c.items -> 0 ->> 'tax_included')::boolean FROM public.checkouts c WHERE c.id = p_checkout), false) THEN 0
         ELSE coalesce(sum(((l.tax * (coalesce(pq.q, 0) + x.quantity) * 2 + l.qty) / (2 * l.qty)) - ((l.tax * coalesce(pq.q, 0) * 2 + l.qty) / (2 * l.qty))), 0) END
    FROM (SELECT i.checkout_item_id, sum(i.quantity)::int AS quantity FROM jsonb_to_recordset(items) AS i(checkout_item_id text, quantity int, restock boolean) GROUP BY 1) x
    JOIN LATERAL (SELECT coalesce((ci.item ->> 'tax')::bigint, 0) AS tax, (ci.item ->> 'quantity')::int AS qty
                    FROM public.checkouts c, jsonb_array_elements(c.items) ci(item) WHERE c.id = p_checkout AND ci.item ->> 'id' = x.checkout_item_id) l ON true
    LEFT JOIN LATERAL (SELECT sum(pi.quantity)::int AS q FROM public.transactions t, jsonb_to_recordset(t.meta -> 'items') AS pi(checkout_item_id text, quantity int, restock boolean)
                        WHERE t.type = 'refund' AND t.status = 'completed' AND t.related_id = p_pay AND t.meta ? 'items' AND pi.checkout_item_id = x.checkout_item_id) pq ON true;
$$;

CREATE OR REPLACE FUNCTION public.app_refund_settle(orig public.locked_payment, merchant uuid, amount bigint, items jsonb, approver uuid, resolved_by text, terminal uuid, idem text, tx_id uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  r record; pb record; v_restored bigint; v_attr bigint; v_credit bigint; v_to_balance bigint; v_id uuid;
  v_pay_tip bigint; v_prior bigint; v_target bigint; v_prev_target bigint; v_tip_refund bigint := 0;
  v_co_tax bigint := 0; v_tax_prior bigint := 0; v_tax_ref bigint := 0; v_nontip_total bigint; v_nontip_prior bigint; v_nontip_this bigint;
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
  SELECT coalesce(sum(t.amount), 0) INTO v_prior FROM public.transactions t WHERE t.type = 'refund' AND t.status = 'completed' AND t.related_id = orig.id;

  -- The sales tax this refund returns (checkouts.sales_tax is the tax of the original payment; every refund records its part in meta.tax). An item refund returns
  -- the tax of those units: per line, round(line tax x units refunded so far / line units) less what earlier refunds of that line returned, so the parts add up
  -- to the line's tax exactly. An amount refund returns the remaining tax in proportion to the non-tip money it returns (the last of it returns all that is left).
  -- Never more than what is left.
  SELECT coalesce(c.sales_tax, 0) INTO v_co_tax FROM public.checkouts c WHERE c.id = orig.checkout_id;
  IF v_co_tax > 0 THEN
    SELECT coalesce(sum((t.meta ->> 'tax')::bigint), 0) INTO v_tax_prior FROM public.transactions t WHERE t.type = 'refund' AND t.status = 'completed' AND t.related_id = orig.id;
    IF items IS NOT NULL THEN
      v_tax_ref := public.app_item_tax(orig.checkout_id, orig.id, items, false);
    ELSE
      v_nontip_total := orig.amount - v_pay_tip;
      v_nontip_prior := least(v_prior, v_nontip_total);
      v_nontip_this := least(amount, v_nontip_total - v_nontip_prior);
      IF v_nontip_this > 0 THEN
        v_tax_ref := CASE WHEN v_nontip_this >= v_nontip_total - v_nontip_prior THEN v_co_tax - v_tax_prior
                          ELSE ((v_co_tax - v_tax_prior) * v_nontip_this * 2 + (v_nontip_total - v_nontip_prior)) / (2 * (v_nontip_total - v_nontip_prior)) END;
      END IF;
    END IF;
    v_tax_ref := greatest(0, least(v_tax_ref, v_co_tax - v_tax_prior));
  END IF;

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
          || (CASE WHEN v_co_tax > 0 THEN jsonb_build_object('tax', v_tax_ref) ELSE '{}'::jsonb END)
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

-- Refund an item: the amount includes the items' share of the sales tax (when added on top).
CREATE OR REPLACE FUNCTION public.app_refund(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_merchant uuid := (p ->> 'merchant')::uuid;
  v_terminal uuid := nullif(p ->> 'terminal_id', '')::uuid;
  v_mode text := p ->> 'mode';
  v_idem text := 'refund:' || (p ->> 'merchant') || ':' || (p ->> 'key');
  v_approver uuid := nullif(p ->> 'approver', '')::uuid;
  orig public.locked_payment; v_prev record; s record; v_remaining bigint; v_amount bigint; v_items jsonb; v_id uuid;
  v_want jsonb; r record; v_line record; v_done int; v_pend int; v_tip bigint; v_nontip_left bigint; v_restock boolean := coalesce((p ->> 'restock')::boolean, false);
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
    -- an item refund returns the items' share of the sales tax too when the tax is added on top of the prices
    v_amount := v_amount + public.app_item_tax(orig.checkout_id, orig.id, v_items, true);
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

  -- A refund returns the tip only with the whole payment: an amount (or items) worth more than what is left of the non-tip part must be everything that
  -- remains, so a tip is never returned in part. Item refunds and amounts up to the non-tip part leave the tip alone.
  SELECT coalesce(sum(tp.amount), 0) INTO v_tip FROM public.tips tp WHERE tp.transaction_id = orig.id;
  IF v_tip > 0 AND v_mode <> 'full' THEN
    v_nontip_left := greatest(0, orig.amount - v_tip - s.completed - s.pending);
    IF v_amount > v_nontip_left AND v_amount <> v_remaining THEN
      RETURN public.app_err('refund_splits_tip', 422) || jsonb_build_object('max', v_nontip_left, 'remaining', v_remaining);
    END IF;
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
