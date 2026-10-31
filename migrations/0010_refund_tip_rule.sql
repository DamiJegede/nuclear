-- Refunds and the tip (owner decision, 2026-10-30): a tip is returned only with the whole payment. A `partial` or `items` refund worth more than what is left of
-- the non-tip part, and not equal to everything that remains, is refused (422 `refund_splits_tip`, with `max` and `remaining`); `full` always works and returns
-- the whole tip. app_refund is redefined with that check; the rest of the money functions are unchanged.

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
