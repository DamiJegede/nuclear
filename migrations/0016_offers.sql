-- Offers (docs/OFFERS.md): a merchant's "buy X, get Y free or part price" deals. One rule covers them all: buy `buy_qty` of a product, get `get_qty` of a
-- product (the same one when `get_product_id` is NULL) at `percent_off` (100 = free). `app_offers(merchant, lines)` takes a cart's priced lines and returns them
-- with each offer applied: a product's units are split into a full-price line and, per offer, an offer-price line (`discount` = the product's own discount plus
-- the offer's share, `offer` = {id, name, percent_off}), so tax, refunds, receipts and stock all keep working on ordinary lines. Every unit is used once (as the
-- thing bought or the thing given); the offer that saves the customer most per set goes first and is applied as many times as the basket allows. The part price
-- is rounded down (the customer pays the rounded-up remainder). It is the same function for a checkout the POS creates and for a one-step payment.

CREATE TABLE offers (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    buy_product_id uuid NOT NULL,
    buy_qty integer NOT NULL,
    get_product_id uuid,
    get_qty integer NOT NULL,
    percent_off integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT offers_pkey PRIMARY KEY (id),
    CONSTRAINT offers_account_fkey FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT offers_buy_product_fkey FOREIGN KEY (buy_product_id) REFERENCES products(id) ON DELETE CASCADE,
    CONSTRAINT offers_get_product_fkey FOREIGN KEY (get_product_id) REFERENCES products(id) ON DELETE CASCADE,
    CONSTRAINT offers_name_check CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT offers_buy_qty_check CHECK (buy_qty BETWEEN 1 AND 20),
    CONSTRAINT offers_get_qty_check CHECK (get_qty BETWEEN 1 AND 20),
    CONSTRAINT offers_percent_check CHECK (percent_off BETWEEN 1 AND 100)
);
CREATE INDEX offers_account_idx ON offers (account_id, created_at, id);

CREATE FUNCTION public.app_offers(p_merchant uuid, p_lines jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_n int := jsonb_array_length(p_lines);
  v_pid uuid[] := ARRAY[]::uuid[]; v_rem int[] := ARRAY[]::int[]; v_net bigint[] := ARRAY[]::bigint[];
  v_alloc jsonb := '[]'::jsonb;
  o record; v_sets int; v_guard int := 0; i int; l jsonb; v_out jsonb := '[]'::jsonb; v_left int; v_unit bigint;
BEGIN
  IF v_n = 0 OR NOT EXISTS (SELECT 1 FROM public.offers WHERE account_id = p_merchant AND active) THEN RETURN p_lines; END IF;
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
     WHERE f.account_id = p_merchant AND f.active
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
        'offer', jsonb_build_object('id', o.offer, 'name', o.name, 'percent_off', o.pct))
        || CASE WHEN l ? 'id' THEN jsonb_build_object('id', gen_random_uuid()) ELSE '{}'::jsonb END);
    END LOOP;
  END LOOP;
  RETURN v_out;
END;
$$;

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
    -- the merchant's offers (buy X get Y free or part price) split the lines into full-price and offer-price units, then the tax is worked out on what is paid
    v_lines := public.app_offers(v_merchant, v_lines);
    v_tax := public.app_tax(v_merchant, v_lines);
    v_lines := v_tax -> 'lines'; v_total := (v_tax ->> 'total')::bigint;
    IF nullif(p ->> 'amount', '') IS NOT NULL AND (p ->> 'amount')::bigint <> v_total THEN RETURN public.app_err('amount_mismatch', 400); END IF;
    RETURN jsonb_build_object('create', jsonb_build_object('lines', v_lines, 'total', v_total, 'sales_tax', (v_tax ->> 'sales_tax')::bigint, 'reference', p -> 'reference'), 'total', v_total);
  END IF;

  RETURN jsonb_build_object('create', jsonb_build_object('lines', '[]'::jsonb, 'total', (p ->> 'amount')::bigint, 'reference', p -> 'reference'),
                            'total', (p ->> 'amount')::bigint);
END;
$$;
