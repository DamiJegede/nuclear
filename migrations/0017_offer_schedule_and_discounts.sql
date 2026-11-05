-- Offer schedules, discounts in the reports, and the offer's amount on the line (docs/OFFERS.md).
-- (1) An offer can have a schedule: days of the week (ISO 1 = Monday ... 7 = Sunday; NULL = every day), a time window (`from_time` to `to_time`, New York time like every
--     other day boundary in Nuclear; a window that ends before it starts runs past midnight and belongs to the day it started) and a date range. `offer_live(offer, at)`
--     is the one definition; `app_offers` takes the moment it prices at (default now()) and ignores offers that are not live then.
-- (2) A snapshotted offer line also stores its `amount` (the part price per unit, in cents) so reports can say what offers cost.
-- (3) merchant_day_stats and merchant_snapshots carry `discounts_v` (every line discount x units on completed payments: the products' own discounts and offers) and `offers_v`
--     (the offers' part). Days already snapshotted are filled by this migration, which lifts the freeze trigger for that one update.

ALTER TABLE offers
  ADD COLUMN days smallint[],
  ADD COLUMN from_time time,
  ADD COLUMN to_time time,
  ADD COLUMN starts_on date,
  ADD COLUMN ends_on date,
  ADD CONSTRAINT offers_days_check CHECK (days IS NULL OR (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[])),
  ADD CONSTRAINT offers_time_check CHECK ((from_time IS NULL) = (to_time IS NULL) AND (from_time IS NULL OR from_time <> to_time)),
  ADD CONSTRAINT offers_dates_check CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on);

-- Does the offer's day rule (date range and days of the week) cover this New York date?
CREATE FUNCTION public.offer_day_ok(o public.offers, d date) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (o.starts_on IS NULL OR d >= o.starts_on) AND (o.ends_on IS NULL OR d <= o.ends_on)
     AND (o.days IS NULL OR extract(isodow FROM d)::smallint = ANY (o.days));
$$;

-- Is the offer live at this moment? Active is checked by the caller; this is the schedule only.
CREATE FUNCTION public.offer_live(o public.offers, p_at timestamptz) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE v_l timestamp := p_at AT TIME ZONE 'America/New_York'; v_d date := (p_at AT TIME ZONE 'America/New_York')::date; v_t time := (p_at AT TIME ZONE 'America/New_York')::time;
BEGIN
  IF o.from_time IS NULL THEN RETURN public.offer_day_ok(o, v_d); END IF;
  IF o.from_time < o.to_time THEN RETURN v_t >= o.from_time AND v_t < o.to_time AND public.offer_day_ok(o, v_d); END IF;
  -- past midnight: the late part of the window belongs to the day before
  RETURN (v_t >= o.from_time AND public.offer_day_ok(o, v_d)) OR (v_t < o.to_time AND public.offer_day_ok(o, v_d - 1));
END;
$$;

DROP FUNCTION public.app_offers(uuid, jsonb);
CREATE FUNCTION public.app_offers(p_merchant uuid, p_lines jsonb, p_at timestamptz DEFAULT now()) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_n int := jsonb_array_length(p_lines);
  v_pid uuid[] := ARRAY[]::uuid[]; v_rem int[] := ARRAY[]::int[]; v_net bigint[] := ARRAY[]::bigint[];
  v_alloc jsonb := '[]'::jsonb;
  o record; v_sets int; v_guard int := 0; i int; l jsonb; v_out jsonb := '[]'::jsonb; v_left int; v_unit bigint;
BEGIN
  IF v_n = 0 OR NOT EXISTS (SELECT 1 FROM public.offers o2 WHERE o2.account_id = p_merchant AND o2.active AND public.offer_live(o2, p_at)) THEN RETURN p_lines; END IF;
  FOR i IN 1..v_n LOOP
    l := p_lines -> (i - 1);
    v_pid := v_pid || nullif(l ->> 'product_id', '')::uuid;
    v_rem := v_rem || (l ->> 'quantity')::int;
    v_net := v_net || ((l ->> 'unit_price')::bigint - coalesce((l ->> 'discount')::bigint, 0));
  END LOOP;
  LOOP
    v_guard := v_guard + 1; EXIT WHEN v_guard > 200;
    -- the applicable offer that saves the most per set (ties: the older offer); a product bought and given is one line, so it needs both quantities
    SELECT f.id, f.name, f.percent_off, f.buy_qty, f.get_qty, a.idx AS a_idx, b.idx AS b_idx, (a.idx = b.idx) AS same,
           CASE WHEN a.idx = b.idx THEN a.rem / (f.buy_qty + f.get_qty) ELSE least(a.rem / f.buy_qty, b.rem / f.get_qty) END AS sets
      INTO o
      FROM public.offers f
      JOIN unnest(v_pid, v_rem, v_net) WITH ORDINALITY AS a(pid, rem, net, idx) ON a.pid = f.buy_product_id
      JOIN unnest(v_pid, v_rem, v_net) WITH ORDINALITY AS b(pid, rem, net, idx) ON b.pid = coalesce(f.get_product_id, f.buy_product_id)
     WHERE f.account_id = p_merchant AND f.active AND public.offer_live(f, p_at)
       AND CASE WHEN a.idx = b.idx THEN a.rem >= f.buy_qty + f.get_qty ELSE a.rem >= f.buy_qty AND b.rem >= f.get_qty END
       AND f.get_qty * (b.net * f.percent_off / 100) > 0
     ORDER BY f.get_qty * (b.net * f.percent_off / 100) DESC, f.id
     LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_sets := o.sets;
    IF o.same THEN v_rem[o.a_idx] := v_rem[o.a_idx] - v_sets * (o.buy_qty + o.get_qty);
    ELSE v_rem[o.a_idx] := v_rem[o.a_idx] - v_sets * o.buy_qty; v_rem[o.b_idx] := v_rem[o.b_idx] - v_sets * o.get_qty; END IF;
    v_alloc := v_alloc || jsonb_build_array(jsonb_build_object('line', o.b_idx, 'offer', o.id, 'name', o.name, 'percent_off', o.percent_off, 'units', v_sets * o.get_qty));
  END LOOP;
  IF jsonb_array_length(v_alloc) = 0 THEN RETURN p_lines; END IF;
  FOR i IN 1..v_n LOOP
    l := p_lines -> (i - 1);
    v_left := (l ->> 'quantity')::int - coalesce((SELECT sum((x ->> 'units')::int) FROM jsonb_array_elements(v_alloc) x WHERE (x ->> 'line')::int = i), 0);
    IF v_left > 0 THEN v_out := v_out || jsonb_build_array(l || jsonb_build_object('quantity', v_left)); END IF;
    v_unit := (l ->> 'unit_price')::bigint - coalesce((l ->> 'discount')::bigint, 0);
    -- one line per offer that gave units on this product (the same offer applied in several rounds is one line)
    FOR o IN SELECT x ->> 'offer' AS offer, min(x ->> 'name') AS name, min((x ->> 'percent_off')::int) AS pct, sum((x ->> 'units')::int)::int AS units
               FROM jsonb_array_elements(v_alloc) WITH ORDINALITY AS e(x, ord) WHERE (x ->> 'line')::int = i GROUP BY x ->> 'offer' ORDER BY min(ord) LOOP
      v_out := v_out || jsonb_build_array(l || jsonb_build_object(
        'quantity', o.units,
        'discount', coalesce((l ->> 'discount')::bigint, 0) + (v_unit * o.pct) / 100,
        'offer', jsonb_build_object('id', o.offer, 'name', o.name, 'percent_off', o.pct, 'amount', (v_unit * o.pct) / 100))
        || CASE WHEN l ? 'id' THEN jsonb_build_object('id', gen_random_uuid()) ELSE '{}'::jsonb END);
    END LOOP;
  END LOOP;
  RETURN v_out;
END;
$$;

ALTER TABLE merchant_snapshots
  ADD COLUMN discounts_v bigint NOT NULL DEFAULT 0,    -- line discounts x units on completed payments (the products' own discounts and offers)
  ADD COLUMN offers_v bigint NOT NULL DEFAULT 0;       -- the part of that which offers gave

DROP FUNCTION public.merchant_day_stats(date, date, uuid);
CREATE FUNCTION public.merchant_day_stats(p_from date, p_to date, p_merchant uuid DEFAULT NULL)
RETURNS TABLE (merchant uuid, day date, pay_n bigint, pay_done_n bigint, pay_v bigint, refund_n bigint, refund_done_n bigint, refund_v bigint,
               tips_n bigint, tips_v bigint, taxable_v bigint, exempt_v bigint, tax_v bigint, tax_refunded_v bigint, discounts_v bigint, offers_v bigint)
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
           CASE WHEN p.status = 'completed' THEN coalesce(c.sales_tax, 0) ELSE 0 END::bigint AS tax_v, 0::bigint AS tax_refunded_v,
           CASE WHEN p.status = 'completed' THEN l.disc ELSE 0 END::bigint AS discounts_v, CASE WHEN p.status = 'completed' THEN l.offr ELSE 0 END::bigint AS offers_v
      FROM pays p
      LEFT JOIN checkouts c ON c.id = p.checkout_id
      LEFT JOIN LATERAL (SELECT coalesce(sum(CASE WHEN coalesce((i ->> 'tax_rate')::int, 0) > 0 THEN ((i ->> 'unit_price')::bigint - (i ->> 'discount')::bigint) * (i ->> 'quantity')::bigint END), 0) AS taxed,
                                coalesce(sum(CASE WHEN coalesce((i ->> 'tax_rate')::int, 0) = 0 THEN ((i ->> 'unit_price')::bigint - (i ->> 'discount')::bigint) * (i ->> 'quantity')::bigint END), 0) AS untaxed,
                                coalesce(sum(((i ->> 'discount')::bigint) * (i ->> 'quantity')::bigint), 0) AS disc,
                                coalesce(sum(coalesce((i -> 'offer' ->> 'amount')::bigint, 0) * (i ->> 'quantity')::bigint), 0) AS offr
                           FROM jsonb_array_elements(c.items) i) l ON p.status = 'completed'
    UNION ALL
    SELECT r.m, (r.created_at AT TIME ZONE 'America/New_York')::date, 0, 0, 0, 1, (r.status = 'completed')::int, CASE WHEN r.status = 'completed' THEN r.amount ELSE 0 END, 0, 0, 0, 0, 0,
           CASE WHEN r.status = 'completed' THEN coalesce((r.meta ->> 'tax')::bigint, 0) ELSE 0 END, 0, 0
      FROM refs r
    UNION ALL
    SELECT t.m, (t.created_at AT TIME ZONE 'America/New_York')::date, 0, 0, 0, 0, 0, 0, (t.amount > 0)::int, t.amount, 0, 0, 0, 0, 0, 0 FROM tp t
  )
  SELECT m, d, sum(pay_n)::bigint, sum(pay_done_n)::bigint, sum(pay_v)::bigint, sum(refund_n)::bigint, sum(refund_done_n)::bigint, sum(refund_v)::bigint,
         sum(tips_n)::bigint, sum(tips_v)::bigint, sum(taxable_v)::bigint, sum(exempt_v)::bigint, sum(tax_v)::bigint, sum(tax_refunded_v)::bigint, sum(discounts_v)::bigint, sum(offers_v)::bigint
    FROM ev GROUP BY m, d;
$$;

CREATE OR REPLACE FUNCTION public.app_merchant_snapshot(p_from date, p_to date) RETURNS bigint LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO merchant_snapshots (merchant_account_id, snapshot_date, pay_n, pay_done_n, pay_v, refund_n, refund_done_n, refund_v, tips_n, tips_v, taxable_v, exempt_v, tax_v, tax_refunded_v, discounts_v, offers_v)
    SELECT merchant, day, pay_n, pay_done_n, pay_v, refund_n, refund_done_n, refund_v, tips_n, tips_v, taxable_v, exempt_v, tax_v, tax_refunded_v, discounts_v, offers_v FROM public.merchant_day_stats(p_from, p_to)
    ON CONFLICT (merchant_account_id, snapshot_date) DO NOTHING
    RETURNING 1
  ) SELECT count(*) FROM ins;
$$;

-- Fill the days that were snapshotted before discounts were counted (the snapshots are frozen, so the trigger is lifted for this one update).
ALTER TABLE merchant_snapshots DISABLE TRIGGER merchant_snapshots_final;
UPDATE merchant_snapshots s SET discounts_v = d.discounts_v, offers_v = d.offers_v
  FROM public.merchant_day_stats((SELECT min(snapshot_date) FROM merchant_snapshots), (SELECT max(snapshot_date) FROM merchant_snapshots)) d
 WHERE d.merchant = s.merchant_account_id AND d.day = s.snapshot_date AND (d.discounts_v <> 0 OR d.offers_v <> 0);
ALTER TABLE merchant_snapshots ENABLE TRIGGER merchant_snapshots_final;


-- (4) An item refund worth nothing (only units an offer gave free) says so: `nothing_to_refund` instead of `invalid_amount`.
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
    -- units an offer gave away were paid $0.00: a selection of only those has nothing to return (refund the units that were paid for)
    IF v_amount <= 0 THEN RETURN public.app_err('nothing_to_refund', 422); END IF;
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
