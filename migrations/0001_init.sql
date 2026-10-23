-- Nuclear schema v2, step 0: the consolidated v1 schema (pg_dump of migrations 0001-0041) as the single initial migration.
-- The rebuild evolves THIS file in place (nothing here has been applied to nuclear-dev; the dev database is dropped and rebuilt at cutover).
-- See docs/SCHEME-V2.md. The archived v1 migrations are in migrations-v1/.
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.6 (Homebrew)
-- Dumped by pg_dump version 18.6 (Homebrew)

--
-- Name: checkout_item_same_merchant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.checkout_item_same_merchant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.product_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM checkouts c JOIN products p ON p.account_id = c.account_id
        WHERE c.id = NEW.checkout_id AND p.id = NEW.product_id) THEN
    RAISE EXCEPTION 'product does not belong to the checkout merchant' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: ledger_check_balanced(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ledger_check_balanced() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  net bigint;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END), 0)
    INTO net
    FROM ledger_entries
   WHERE posting_key = NEW.posting_key
     AND transaction_id IS NOT DISTINCT FROM NEW.transaction_id
     AND funding_id IS NOT DISTINCT FROM NEW.funding_id;
  IF net <> 0 THEN
    RAISE EXCEPTION 'unbalanced ledger posting % (net %)', NEW.posting_key, net;
  END IF;
  RETURN NULL;
END;
$$;

--
-- Name: ledger_entries_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ledger_entries_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only; post a reversing entry instead';
END;
$$;

--
-- Name: logs_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.logs_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'logs is append-only';
END;
$$;

--
-- Name: products_sync_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.products_sync_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.stock IS NOT NULL THEN
    NEW.status := CASE WHEN NEW.stock = 0 THEN 'sold_out' ELSE 'available' END;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: require_business_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.require_business_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.account_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND type = 'B') THEN
    RAISE EXCEPTION '% requires a business (type B) account', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

--
-- Name: snapshots_final(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapshots_final() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a snapshot is final and cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'reconciled' - 'reconciliation') IS DISTINCT FROM (to_jsonb(OLD) - 'reconciled' - 'reconciliation') THEN
    RAISE EXCEPTION 'a snapshot is final: only its ledger-check result can be written';
  END IF;
  IF OLD.reconciled IS NOT NULL AND (NEW.reconciled IS DISTINCT FROM OLD.reconciled OR NEW.reconciliation IS DISTINCT FROM OLD.reconciliation) THEN
    RAISE EXCEPTION 'a snapshot''s ledger-check result is written once';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: staff_account_types(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_account_types() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND type = 'B') THEN
    RAISE EXCEPTION 'staff.account_id requires a business (type B) account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.staff_account_id AND type = 'C') THEN
    RAISE EXCEPTION 'staff.staff_account_id requires a consumer (type C) account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: transactions_checkout_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transactions_checkout_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.checkout_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM checkouts c
        WHERE c.id = NEW.checkout_id
          AND c.account_id = CASE NEW.type WHEN 'pay' THEN NEW.to_account_id
                                           WHEN 'refund' THEN NEW.from_account_id END) THEN
    RAISE EXCEPTION 'checkout does not belong to the merchant account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: transactions_terminal_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transactions_terminal_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.terminal_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM terminals t
        WHERE t.id = NEW.terminal_id
          AND t.account_id = CASE NEW.type WHEN 'pay' THEN NEW.to_account_id
                                           WHEN 'refund' THEN NEW.from_account_id END) THEN
    RAISE EXCEPTION 'terminal does not belong to the merchant account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: wallets_benefits_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallets_benefits_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type OR NEW.org_account_id IS DISTINCT FROM OLD.org_account_id OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'a wallet''s type, owner and employer cannot change';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT uuidv7() NOT NULL,
    type character(1) NOT NULL,
    handle text,
    name text NOT NULL,
    phone text,
    email text,
    password_hash text,
    photo text,
    tier text DEFAULT 'free'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    bio text,
    email_verified_at timestamp with time zone,
    CONSTRAINT accounts_bio_check CHECK (((bio IS NULL) OR (length(bio) <= 128))),
    CONSTRAINT accounts_handle_check CHECK ((handle ~ '^[a-z0-9]{4,12}$'::text)),
    CONSTRAINT accounts_photo_key CHECK (((photo IS NULL) OR (photo ~ '^accounts/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$'::text))),
    CONSTRAINT accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending'::text, 'declined'::text, 'suspended'::text, 'closed'::text]))),
    CONSTRAINT accounts_tier_check CHECK ((tier = ANY (ARRAY['free'::text, 'plus'::text, 'insider'::text]))),
    CONSTRAINT accounts_type_check CHECK ((type = ANY (ARRAY['C'::bpchar, 'B'::bpchar, 'O'::bpchar])))
);

--
-- Name: admin_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_sessions (
    id uuid DEFAULT uuidv7() NOT NULL,
    admin_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);

--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    id uuid DEFAULT uuidv7() NOT NULL,
    access_id text NOT NULL,
    name text NOT NULL,
    access_token_hash text CONSTRAINT admins_password_hash_not_null NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    mfa_secret text,
    mfa_enabled_at timestamp with time zone,
    mfa_last_step bigint,
    mfa_recovery jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_login_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'admin'::text NOT NULL,
    CONSTRAINT admins_access_id_check CHECK ((access_id ~ '^[A-Z0-9][A-Z0-9._-]{2,31}$'::text)),
    CONSTRAINT admins_failed_attempts_check CHECK ((failed_attempts >= 0)),
    CONSTRAINT admins_mfa_recovery_check CHECK ((jsonb_typeof(mfa_recovery) = 'array'::text)),
    CONSTRAINT admins_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80))),
    CONSTRAINT admins_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'accounting'::text, 'sales'::text, 'support'::text, 'tags'::text, 'merchants'::text]))),
    CONSTRAINT admins_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    name text DEFAULT 'Default'::text NOT NULL,
    key_hash text NOT NULL,
    key_hint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT api_keys_key_hint_check CHECK ((length(key_hint) = 4)),
    CONSTRAINT api_keys_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 60)))
);

--
-- Name: balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.balances (
    account_id uuid NOT NULL,
    balance bigint DEFAULT 0 NOT NULL,
    balance_pending bigint DEFAULT 0 NOT NULL,
    credit_limit bigint DEFAULT 0 NOT NULL,
    credit_spent bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ordinary_opening bigint DEFAULT 0 NOT NULL,
    opening_day date DEFAULT ((now() AT TIME ZONE 'America/New_York'::text))::date NOT NULL,
    added_today bigint DEFAULT 0 NOT NULL,
    CONSTRAINT balances_added_today_check CHECK ((added_today >= 0)),
    CONSTRAINT balances_balance_pending_check CHECK ((balance_pending >= 0)),
    CONSTRAINT balances_credit_limit_check CHECK ((credit_limit >= 0)),
    CONSTRAINT balances_credit_spent_check CHECK ((credit_spent >= 0))
);

--
-- Name: bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_accounts (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    routing_number text NOT NULL,
    account_number text NOT NULL,
    last4 character(4) NOT NULL,
    provider_account_id text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bank_account_encrypted CHECK ((account_number ~ '^(v1\.[A-Za-z0-9_-]{20,}|SANDBOX)$'::text)),
    CONSTRAINT bank_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'removed'::text]))),
    CONSTRAINT bank_routing_format CHECK ((routing_number ~ '^([0-9]{9}|SANDBOX)$'::text))
);

--
-- Name: benefit_programs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.benefit_programs (
    org_account_id uuid NOT NULL,
    mode text DEFAULT 'flexible'::text NOT NULL,
    cadence text,
    day_of_month smallint,
    weekday smallint,
    start_date date,
    next_run_date date,
    warned_for date,
    last_attempt_at timestamp with time zone,
    chosen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT benefit_programs_cadence_check CHECK ((cadence = ANY (ARRAY['monthly'::text, 'weekly'::text, 'biweekly'::text]))),
    CONSTRAINT benefit_programs_check CHECK (((mode = 'flexible'::text) OR ((cadence IS NOT NULL) AND (next_run_date IS NOT NULL)))),
    CONSTRAINT benefit_programs_check1 CHECK (((cadence IS DISTINCT FROM 'monthly'::text) OR (day_of_month IS NOT NULL))),
    CONSTRAINT benefit_programs_check2 CHECK (((cadence IS NULL) OR (cadence = 'monthly'::text) OR (weekday IS NOT NULL))),
    CONSTRAINT benefit_programs_check3 CHECK (((cadence IS DISTINCT FROM 'biweekly'::text) OR (start_date IS NOT NULL))),
    CONSTRAINT benefit_programs_day_of_month_check CHECK (((day_of_month >= 1) AND (day_of_month <= 28))),
    CONSTRAINT benefit_programs_mode_check CHECK ((mode = ANY (ARRAY['fixed'::text, 'flexible'::text]))),
    CONSTRAINT benefit_programs_weekday_check CHECK (((weekday >= 0) AND (weekday <= 6)))
);

--
-- Name: benefit_run_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.benefit_run_rows (
    id uuid DEFAULT uuidv7() NOT NULL,
    run_id uuid NOT NULL,
    employee_ref uuid NOT NULL,
    amount bigint NOT NULL,
    mode text NOT NULL,
    transaction_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT benefit_run_rows_amount_check CHECK ((amount > 0)),
    CONSTRAINT benefit_run_rows_mode_check CHECK ((mode = ANY (ARRAY['sent'::text, 'held'::text])))
);

--
-- Name: benefit_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.benefit_runs (
    id uuid DEFAULT uuidv7() NOT NULL,
    org_account_id uuid NOT NULL,
    source text DEFAULT 'csv'::text NOT NULL,
    run_date date NOT NULL,
    status text DEFAULT 'credited'::text NOT NULL,
    idempotency_key text NOT NULL,
    row_count integer NOT NULL,
    total bigint NOT NULL,
    sent bigint DEFAULT 0 NOT NULL,
    held bigint DEFAULT 0 NOT NULL,
    failure_code text,
    attempts integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT benefit_runs_attempts_check CHECK ((attempts >= 1)),
    CONSTRAINT benefit_runs_check CHECK (((status <> 'credited'::text) OR ((sent + held) = total))),
    CONSTRAINT benefit_runs_held_check CHECK ((held >= 0)),
    CONSTRAINT benefit_runs_row_count_check CHECK ((row_count > 0)),
    CONSTRAINT benefit_runs_sent_check CHECK ((sent >= 0)),
    CONSTRAINT benefit_runs_source_check CHECK ((source = ANY (ARRAY['csv'::text, 'api'::text, 'schedule'::text]))),
    CONSTRAINT benefit_runs_status_check CHECK ((status = ANY (ARRAY['credited'::text, 'waiting_for_funds'::text, 'missed'::text]))),
    CONSTRAINT benefit_runs_total_check CHECK ((total > 0))
);

--
-- Name: businesses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.businesses (
    account_id uuid NOT NULL,
    account_type character(1) DEFAULT 'B'::bpchar NOT NULL,
    legal_name text NOT NULL,
    display_name text NOT NULL,
    tax_id text,
    bank_account_id uuid,
    address text,
    city text,
    state text,
    post_code text,
    country character(2),
    website text,
    latitude double precision,
    longitude double precision,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT businesses_account_type_check CHECK ((account_type = ANY (ARRAY['B'::bpchar, 'O'::bpchar])))
);

--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT categories_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120)))
);

--
-- Name: checkout_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkout_items (
    id uuid DEFAULT uuidv7() NOT NULL,
    checkout_id uuid NOT NULL,
    product_id uuid,
    name text NOT NULL,
    unit_price bigint NOT NULL,
    discount bigint DEFAULT 0 NOT NULL,
    quantity integer NOT NULL,
    refunded_quantity integer DEFAULT 0 NOT NULL,
    refund_pending_quantity integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT checkout_items_check CHECK (((discount >= 0) AND (discount <= unit_price))),
    CONSTRAINT checkout_items_check1 CHECK (((refunded_quantity + refund_pending_quantity) <= quantity)),
    CONSTRAINT checkout_items_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
    CONSTRAINT checkout_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT checkout_items_refund_pending_quantity_check CHECK ((refund_pending_quantity >= 0)),
    CONSTRAINT checkout_items_refunded_quantity_check CHECK ((refunded_quantity >= 0)),
    CONSTRAINT checkout_items_unit_price_check CHECK ((unit_price >= 0))
);

--
-- Name: checkouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkouts (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    terminal_id uuid,
    reference text,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    total bigint NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT checkouts_reference_check CHECK (((reference IS NULL) OR ((length(reference) >= 1) AND (length(reference) <= 64)))),
    CONSTRAINT checkouts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'paid'::text, 'canceled'::text, 'expired'::text]))),
    CONSTRAINT checkouts_total_check CHECK ((total > 0))
);

--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    wallet_id uuid,
    platform text,
    push_token text,
    session_token_hash text,
    session_expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_accessed_at timestamp with time zone,
    CONSTRAINT devices_check CHECK (((session_token_hash IS NULL) = (session_expires_at IS NULL))),
    CONSTRAINT devices_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))
);

--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id uuid DEFAULT uuidv7() NOT NULL,
    org_account_id uuid NOT NULL,
    employee_account_id uuid,
    employee_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    balance bigint DEFAULT 0 NOT NULL,
    claim_token_hash text,
    reminded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    fixed_benefit bigint,
    CONSTRAINT employees_balance_check CHECK ((balance >= 0)),
    CONSTRAINT employees_check CHECK (((employee_account_id IS NULL) OR (balance = 0))),
    CONSTRAINT employees_check1 CHECK (((employee_account_id IS NULL) OR (claim_token_hash IS NULL))),
    CONSTRAINT employees_email_check CHECK (((length(email) >= 3) AND (length(email) <= 254))),
    CONSTRAINT employees_employee_id_check CHECK ((employee_id ~ '^[A-Za-z0-9]{1,64}$'::text)),
    CONSTRAINT employees_fixed_benefit_check CHECK (((fixed_benefit IS NULL) OR ((fixed_benefit > 0) AND (fixed_benefit <= 10000000)))),
    CONSTRAINT employees_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
    CONSTRAINT employees_status_check CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text])))
);

--
-- Name: fundings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fundings (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    bank_account_id uuid NOT NULL,
    amount bigint NOT NULL,
    status text DEFAULT 'created'::text NOT NULL,
    failure_code text,
    idempotency_key text NOT NULL,
    provider_reference text,
    transaction_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    returned_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fundings_amount_check CHECK ((amount > 0)),
    CONSTRAINT fundings_check CHECK (((transaction_id IS NULL) OR (released_at IS NOT NULL))),
    CONSTRAINT fundings_check1 CHECK (((returned_at IS NULL) OR (released_at IS NOT NULL))),
    CONSTRAINT fundings_status_check CHECK ((status = ANY (ARRAY['created'::text, 'pending'::text, 'completed'::text, 'failed'::text, 'canceled'::text, 'returned'::text])))
);

--
-- Name: ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_entries (
    id bigint NOT NULL,
    transaction_id uuid,
    funding_id uuid,
    posting_key text NOT NULL,
    line_no smallint NOT NULL,
    account_id uuid,
    bucket text NOT NULL,
    direction text NOT NULL,
    amount bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    wallet_id uuid,
    CONSTRAINT ledger_entries_amount_check CHECK ((amount > 0)),
    CONSTRAINT ledger_entries_bucket_check CHECK ((bucket = ANY (ARRAY['funded_balance'::text, 'credit_receivable'::text, 'pending_funding'::text, 'bank_settlement'::text, 'platform_clearing'::text, 'employee_escrow'::text]))),
    CONSTRAINT ledger_entries_check CHECK ((num_nonnulls(transaction_id, funding_id) = 1)),
    CONSTRAINT ledger_entries_direction_check CHECK ((direction = ANY (ARRAY['debit'::text, 'credit'::text]))),
    CONSTRAINT ledger_entries_line_no_check CHECK ((line_no > 0))
);

--
-- Name: ledger_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ledger_entries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ledger_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.logs (
    id uuid DEFAULT uuidv7() NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    actor_label text,
    action text NOT NULL,
    target_type text,
    target_id uuid,
    target_label text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT logs_action_check CHECK (((length(action) >= 1) AND (length(action) <= 80))),
    CONSTRAINT logs_actor_type_check CHECK ((actor_type = ANY (ARRAY['admin'::text, 'operator'::text, 'customer'::text, 'agent'::text, 'system'::text]))),
    CONSTRAINT logs_details_check CHECK ((jsonb_typeof(details) = 'object'::text))
);

--
-- Name: orbs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orbs (
    id uuid DEFAULT uuidv7() NOT NULL,
    uid text NOT NULL,
    model text NOT NULL,
    software text NOT NULL,
    account_id uuid,
    terminal_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT orbs_check CHECK (((terminal_id IS NULL) OR (account_id IS NOT NULL))),
    CONSTRAINT orbs_uid_format CHECK ((uid ~ '^[0-9A-F]{12}$'::text))
);

--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT uuidv7() NOT NULL,
    type text DEFAULT 'tag'::text NOT NULL,
    account_id uuid NOT NULL,
    wallet_id uuid NOT NULL,
    model_id uuid,
    shop_id uuid,
    name text NOT NULL,
    model_type text,
    quantity integer NOT NULL,
    unit_price bigint NOT NULL,
    total bigint NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    shipping jsonb,
    status text DEFAULT 'paid'::text NOT NULL,
    transaction_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery text DEFAULT 'ship'::text NOT NULL,
    CONSTRAINT orders_check CHECK ((total = (unit_price * quantity))),
    CONSTRAINT orders_check1 CHECK ((((type = 'tag'::text) AND (model_id IS NOT NULL) AND (shop_id IS NULL) AND (model_type IS NOT NULL)) OR ((type = 'shop'::text) AND (shop_id IS NOT NULL) AND (model_id IS NULL) AND (model_type IS NULL)))),
    CONSTRAINT orders_delivery_check CHECK ((delivery = ANY (ARRAY['ship'::text, 'download'::text]))),
    CONSTRAINT orders_delivery_shipping CHECK (((delivery = 'ship'::text) = (shipping IS NOT NULL))),
    CONSTRAINT orders_download_is_shop CHECK (((delivery = 'ship'::text) OR (type = 'shop'::text))),
    CONSTRAINT orders_model_type_check CHECK ((model_type = ANY (ARRAY['band'::text, 'card'::text]))),
    CONSTRAINT orders_quantity_check CHECK (((quantity >= 1) AND (quantity <= 20))),
    CONSTRAINT orders_shipping_check CHECK ((jsonb_typeof(shipping) = 'object'::text)),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['paid'::text, 'shipped'::text, 'cancelled'::text]))),
    CONSTRAINT orders_total_check CHECK ((total > 0)),
    CONSTRAINT orders_type_check CHECK ((type = ANY (ARRAY['tag'::text, 'shop'::text]))),
    CONSTRAINT orders_unit_price_check CHECK ((unit_price >= 0))
);

--
-- Name: passes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passes (
    id uuid DEFAULT uuidv7() NOT NULL,
    wallet_id uuid NOT NULL,
    platform text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT passes_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text]))),
    CONSTRAINT passes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    category_id uuid,
    name text NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    price bigint NOT NULL,
    photo text,
    stock integer,
    active boolean DEFAULT true NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    total_sold bigint DEFAULT 0 NOT NULL,
    sold_today integer DEFAULT 0 NOT NULL,
    discount bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT products_check CHECK (((discount >= 0) AND (discount <= price))),
    CONSTRAINT products_check1 CHECK (((stock IS NULL) OR ((stock = 0) = (status = 'sold_out'::text)))),
    CONSTRAINT products_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
    CONSTRAINT products_photo_key CHECK (((photo IS NULL) OR (photo ~ '^products/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$'::text))),
    CONSTRAINT products_price_check CHECK ((price >= 0)),
    CONSTRAINT products_sold_today_check CHECK ((sold_today >= 0)),
    CONSTRAINT products_status_check CHECK ((status = ANY (ARRAY['available'::text, 'sold_out'::text]))),
    CONSTRAINT products_stock_check CHECK ((stock >= 0)),
    CONSTRAINT products_total_sold_check CHECK ((total_sold >= 0))
);

--
-- Name: settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlements (
    id uuid DEFAULT uuidv7() NOT NULL,
    cutoff_date date NOT NULL,
    cutoff_at timestamp with time zone NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    merchants integer DEFAULT 0 NOT NULL,
    payout_total bigint DEFAULT 0 NOT NULL,
    collection_total bigint DEFAULT 0 NOT NULL,
    provider_reference text,
    failure_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlements_check CHECK (((status <> 'completed'::text) OR (completed_at IS NOT NULL))),
    CONSTRAINT settlements_collection_total_check CHECK ((collection_total >= 0)),
    CONSTRAINT settlements_merchants_check CHECK ((merchants >= 0)),
    CONSTRAINT settlements_payout_total_check CHECK ((payout_total >= 0)),
    CONSTRAINT settlements_status_check CHECK ((status = ANY (ARRAY['running'::text, 'submitted'::text, 'completed'::text, 'failed'::text])))
);

--
-- Name: shop; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shop (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    description text,
    photo text,
    price bigint NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    stock integer,
    sold integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'physical'::text NOT NULL,
    file text,
    CONSTRAINT shop_digital_needs_file CHECK (((kind = 'physical'::text) OR (status <> 'available'::text) OR (file IS NOT NULL))),
    CONSTRAINT shop_digital_no_stock CHECK (((kind = 'physical'::text) OR (stock IS NULL))),
    CONSTRAINT shop_file_check CHECK (((file IS NULL) OR (file ~ '^downloads/[0-9a-f-]{36}-[0-9]+\.[a-z0-9]{1,5}$'::text))),
    CONSTRAINT shop_file_digital CHECK (((kind = 'digital'::text) OR (file IS NULL))),
    CONSTRAINT shop_kind_check CHECK ((kind = ANY (ARRAY['physical'::text, 'digital'::text]))),
    CONSTRAINT shop_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
    CONSTRAINT shop_photo_key CHECK (((photo IS NULL) OR (photo ~ '^shop/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$'::text))),
    CONSTRAINT shop_price_check CHECK ((price >= 0)),
    CONSTRAINT shop_sold_check CHECK ((sold >= 0)),
    CONSTRAINT shop_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'available'::text, 'closed'::text]))),
    CONSTRAINT shop_stock_check CHECK (((stock IS NULL) OR (stock >= 0)))
);

--
-- Name: snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshots (
    id uuid DEFAULT uuidv7() NOT NULL,
    snapshot_date date NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    scheme_balance bigint DEFAULT 0 NOT NULL,
    consumer_balance bigint DEFAULT 0 NOT NULL,
    merchant_balance bigint DEFAULT 0 NOT NULL,
    organization_balance bigint DEFAULT 0 NOT NULL,
    merchant_debt bigint DEFAULT 0 NOT NULL,
    pending_loads bigint DEFAULT 0 NOT NULL,
    credit_outstanding bigint DEFAULT 0 NOT NULL,
    credit_limit bigint DEFAULT 0 NOT NULL,
    benefits_wallet_balance bigint DEFAULT 0 NOT NULL,
    employee_escrow bigint DEFAULT 0 NOT NULL,
    users_total bigint DEFAULT 0 NOT NULL,
    users_active bigint DEFAULT 0 NOT NULL,
    users_suspended bigint DEFAULT 0 NOT NULL,
    users_closed bigint DEFAULT 0 NOT NULL,
    wallets bigint DEFAULT 0 NOT NULL,
    merchants_total bigint DEFAULT 0 NOT NULL,
    merchants_active bigint DEFAULT 0 NOT NULL,
    merchants_transacting bigint DEFAULT 0 NOT NULL,
    terminals bigint DEFAULT 0 NOT NULL,
    organizations_total bigint DEFAULT 0 NOT NULL,
    organizations_active bigint DEFAULT 0 NOT NULL,
    employees_total bigint DEFAULT 0 NOT NULL,
    employees_claimed bigint DEFAULT 0 NOT NULL,
    employees_unclaimed bigint DEFAULT 0 NOT NULL,
    users_new bigint DEFAULT 0 NOT NULL,
    merchants_new bigint DEFAULT 0 NOT NULL,
    organizations_new bigint DEFAULT 0 NOT NULL,
    employees_added bigint DEFAULT 0 NOT NULL,
    merchants_paid bigint DEFAULT 0 NOT NULL,
    sends_count bigint DEFAULT 0 NOT NULL,
    sends_volume bigint DEFAULT 0 NOT NULL,
    taps_count bigint DEFAULT 0 NOT NULL,
    taps_volume bigint DEFAULT 0 NOT NULL,
    in_app_count bigint DEFAULT 0 NOT NULL,
    in_app_volume bigint DEFAULT 0 NOT NULL,
    agents_count bigint DEFAULT 0 NOT NULL,
    agents_volume bigint DEFAULT 0 NOT NULL,
    refunds_count bigint DEFAULT 0 NOT NULL,
    refunds_volume bigint DEFAULT 0 NOT NULL,
    loads_count bigint DEFAULT 0 NOT NULL,
    loads_volume bigint DEFAULT 0 NOT NULL,
    purchases_count bigint DEFAULT 0 NOT NULL,
    purchases_volume bigint DEFAULT 0 NOT NULL,
    payouts_count bigint DEFAULT 0 NOT NULL,
    payouts_volume bigint DEFAULT 0 NOT NULL,
    collections_count bigint DEFAULT 0 NOT NULL,
    collections_volume bigint DEFAULT 0 NOT NULL,
    claims_count bigint DEFAULT 0 NOT NULL,
    claims_volume bigint DEFAULT 0 NOT NULL,
    benefit_runs_count bigint DEFAULT 0 NOT NULL,
    benefit_credited bigint DEFAULT 0 NOT NULL,
    benefit_sent bigint DEFAULT 0 NOT NULL,
    benefit_held bigint DEFAULT 0 NOT NULL,
    benefit_runs_missed bigint DEFAULT 0 NOT NULL,
    lifetime_sends_count bigint DEFAULT 0 NOT NULL,
    lifetime_sends_volume bigint DEFAULT 0 NOT NULL,
    lifetime_taps_count bigint DEFAULT 0 NOT NULL,
    lifetime_taps_volume bigint DEFAULT 0 NOT NULL,
    lifetime_in_app_count bigint DEFAULT 0 NOT NULL,
    lifetime_in_app_volume bigint DEFAULT 0 NOT NULL,
    lifetime_refunds_count bigint DEFAULT 0 NOT NULL,
    lifetime_refunds_volume bigint DEFAULT 0 NOT NULL,
    lifetime_loads_count bigint DEFAULT 0 NOT NULL,
    lifetime_loads_volume bigint DEFAULT 0 NOT NULL,
    lifetime_purchases_count bigint DEFAULT 0 NOT NULL,
    lifetime_purchases_volume bigint DEFAULT 0 NOT NULL,
    lifetime_payouts_count bigint DEFAULT 0 NOT NULL,
    lifetime_payouts_volume bigint DEFAULT 0 NOT NULL,
    lifetime_collections_count bigint DEFAULT 0 NOT NULL,
    lifetime_collections_volume bigint DEFAULT 0 NOT NULL,
    lifetime_claims_count bigint DEFAULT 0 NOT NULL,
    lifetime_claims_volume bigint DEFAULT 0 NOT NULL,
    lifetime_agents_count bigint DEFAULT 0 NOT NULL,
    lifetime_agents_volume bigint DEFAULT 0 NOT NULL,
    lifetime_benefit_credited bigint DEFAULT 0 NOT NULL,
    lifetime_benefit_runs_count bigint DEFAULT 0 NOT NULL,
    reconciled boolean,
    reconciliation jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    staff_account_id uuid NOT NULL,
    bank_account_id uuid,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_check CHECK ((account_id <> staff_account_id)),
    CONSTRAINT staff_role_check CHECK ((role = ANY (ARRAY['read'::text, 'write'::text])))
);

--
-- Name: system; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: tag_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tag_models (
    id uuid DEFAULT uuidv7() NOT NULL,
    type text NOT NULL,
    name text NOT NULL,
    photo text,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    price bigint NOT NULL,
    country character(2),
    quantity integer NOT NULL,
    sold integer DEFAULT 0 NOT NULL,
    limited boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tag_models_check CHECK ((sold <= quantity)),
    CONSTRAINT tag_models_photo_key CHECK (((photo IS NULL) OR (photo ~ '^tags/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$'::text))),
    CONSTRAINT tag_models_price_check CHECK ((price >= 0)),
    CONSTRAINT tag_models_quantity_check CHECK ((quantity >= 0)),
    CONSTRAINT tag_models_sold_check CHECK ((sold >= 0)),
    CONSTRAINT tag_models_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'preorder'::text, 'available'::text, 'closed'::text]))),
    CONSTRAINT tag_models_type_check CHECK ((type = ANY (ARRAY['band'::text, 'card'::text])))
);

--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT uuidv7() NOT NULL,
    uid text NOT NULL,
    model_id uuid NOT NULL,
    wallet_id uuid,
    label text,
    counter bigint,
    last_read_at timestamp with time zone,
    locked boolean DEFAULT false NOT NULL,
    transaction_limit bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tags_counter_check CHECK ((counter >= 0)),
    CONSTRAINT tags_transaction_limit_check CHECK ((transaction_limit > 0)),
    CONSTRAINT tags_uid_check CHECK ((uid = upper(uid)))
);

--
-- Name: terminals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terminals (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    session_token_hash text,
    allow_refunds boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT terminals_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80)))
);

--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT uuidv7() NOT NULL,
    type text NOT NULL,
    from_account_id uuid,
    to_account_id uuid,
    from_wallet_id uuid,
    to_wallet_id uuid,
    from_bank_account_id uuid,
    to_bank_account_id uuid,
    amount bigint NOT NULL,
    related_transaction_id uuid,
    terminal_id uuid,
    reference text,
    approved_by_account_id uuid,
    checkout_id uuid,
    items jsonb,
    tag_id uuid,
    pass_id uuid,
    status text NOT NULL,
    status_code text,
    idempotency_key text NOT NULL,
    provider_reference text,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    settlement_id uuid,
    CONSTRAINT transactions_amount_check CHECK ((amount > 0)),
    CONSTRAINT transactions_approval_refund_only CHECK (((approved_by_account_id IS NULL) OR (type = 'refund'::text))),
    CONSTRAINT transactions_check CHECK (((tag_id IS NULL) OR (pass_id IS NULL))),
    CONSTRAINT transactions_check1 CHECK ((((tag_id IS NULL) AND (pass_id IS NULL)) OR (type = 'pay'::text))),
    CONSTRAINT transactions_check2 CHECK (((related_transaction_id IS NULL) OR (type = ANY (ARRAY['refund'::text, 'adjustment'::text])))),
    CONSTRAINT transactions_check4 CHECK (((status <> 'completed'::text) OR (completed_at IS NOT NULL))),
    CONSTRAINT transactions_checkout_scope CHECK (((checkout_id IS NULL) OR (type = ANY (ARRAY['pay'::text, 'refund'::text])))),
    CONSTRAINT transactions_endpoints_check CHECK (
CASE type
    WHEN 'fund'::text THEN ((from_account_id IS NOT NULL) AND (to_account_id IS NOT NULL) AND (from_bank_account_id IS NOT NULL) AND (to_bank_account_id IS NULL) AND (from_wallet_id IS NULL) AND (to_wallet_id IS NULL))
    WHEN 'send'::text THEN ((from_account_id IS NOT NULL) AND (to_account_id IS NOT NULL) AND (from_wallet_id IS NOT NULL) AND (to_wallet_id IS NOT NULL) AND (from_bank_account_id IS NULL) AND (to_bank_account_id IS NULL))
    WHEN 'pay'::text THEN ((from_account_id IS NOT NULL) AND (to_account_id IS NOT NULL) AND (from_wallet_id IS NOT NULL) AND (to_wallet_id IS NULL) AND (from_bank_account_id IS NULL) AND (to_bank_account_id IS NULL))
    WHEN 'settle'::text THEN ((from_account_id IS NOT NULL) AND (to_account_id IS NOT NULL) AND (from_wallet_id IS NULL) AND (to_wallet_id IS NULL) AND (num_nonnulls(from_bank_account_id, to_bank_account_id) = 1))
    WHEN 'refund'::text THEN ((from_account_id IS NOT NULL) AND (to_account_id IS NOT NULL) AND (from_wallet_id IS NULL) AND (to_wallet_id IS NOT NULL) AND (from_bank_account_id IS NULL) AND (to_bank_account_id IS NULL) AND (related_transaction_id IS NOT NULL))
    WHEN 'purchase'::text THEN ((from_account_id IS NOT NULL) AND (from_wallet_id IS NOT NULL) AND (to_account_id IS NULL) AND (to_wallet_id IS NULL) AND (from_bank_account_id IS NULL) AND (to_bank_account_id IS NULL))
    WHEN 'allocate'::text THEN ((from_account_id IS NOT NULL) AND (from_wallet_id IS NOT NULL) AND (to_account_id IS NULL) AND (to_wallet_id IS NULL) AND (from_bank_account_id IS NULL) AND (to_bank_account_id IS NULL))
    WHEN 'claim'::text THEN ((to_account_id IS NOT NULL) AND (to_wallet_id IS NOT NULL) AND (from_account_id IS NULL) AND (from_wallet_id IS NULL) AND (from_bank_account_id IS NULL) AND (to_bank_account_id IS NULL))
    WHEN 'move'::text THEN ((from_account_id IS NOT NULL) AND (to_account_id = from_account_id) AND (from_wallet_id IS NOT NULL) AND (to_wallet_id IS NOT NULL) AND (from_wallet_id <> to_wallet_id) AND (from_bank_account_id IS NULL) AND (to_bank_account_id IS NULL))
    ELSE true
END),
    CONSTRAINT transactions_items_refund_only CHECK (((items IS NULL) OR ((type = 'refund'::text) AND (jsonb_typeof(items) = 'array'::text)))),
    CONSTRAINT transactions_reference_pay_only CHECK (((reference IS NULL) OR ((type = 'pay'::text) AND ((length(reference) >= 1) AND (length(reference) <= 64))))),
    CONSTRAINT transactions_settlement_only CHECK (((settlement_id IS NULL) OR (type = 'settle'::text))),
    CONSTRAINT transactions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'returned'::text]))),
    CONSTRAINT transactions_terminal_scope CHECK (((terminal_id IS NULL) OR (type = ANY (ARRAY['pay'::text, 'refund'::text])))),
    CONSTRAINT transactions_type_check CHECK ((type = ANY (ARRAY['fund'::text, 'send'::text, 'pay'::text, 'settle'::text, 'refund'::text, 'adjustment'::text, 'purchase'::text, 'allocate'::text, 'claim'::text, 'move'::text])))
);

--
-- Name: uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uploads (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    type text NOT NULL,
    path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT uploads_path_check CHECK (((length(path) >= 1) AND (length(path) <= 300))),
    CONSTRAINT uploads_type_check CHECK ((type ~ '^[a-z_]{1,40}$'::text))
);

--
-- Name: wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallets (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    display_name text NOT NULL,
    photo text,
    type text NOT NULL,
    daily_limit bigint,
    spent_today bigint DEFAULT 0 NOT NULL,
    allow_pay boolean DEFAULT true NOT NULL,
    allow_send boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    balance bigint,
    key_hash text,
    key_hint text,
    key_last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    org_account_id uuid,
    CONSTRAINT wallets_balance_check CHECK (((balance IS NULL) OR (balance >= 0))),
    CONSTRAINT wallets_benefits_binding CHECK (((type = 'benefits'::text) = (org_account_id IS NOT NULL))),
    CONSTRAINT wallets_benefits_funded CHECK (((type <> 'benefits'::text) OR (balance IS NOT NULL))),
    CONSTRAINT wallets_daily_limit_check CHECK ((daily_limit >= 0)),
    CONSTRAINT wallets_key_agent_only CHECK (((key_hash IS NULL) OR (type = 'agent'::text))),
    CONSTRAINT wallets_key_consistent CHECK (((key_hash IS NULL) = (key_hint IS NULL))),
    CONSTRAINT wallets_photo_key CHECK (((photo IS NULL) OR (photo ~ '^wallets/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$'::text))),
    CONSTRAINT wallets_spent_today_check CHECK ((spent_today >= 0)),
    CONSTRAINT wallets_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'closed'::text]))),
    CONSTRAINT wallets_type_check CHECK ((type = ANY (ARRAY['default'::text, 'agent'::text, 'person'::text, 'benefits'::text])))
);

--
-- Name: accounts accounts_id_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_id_type_key UNIQUE (id, type);

--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

--
-- Name: admin_sessions admin_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_pkey PRIMARY KEY (id);

--
-- Name: admin_sessions admin_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_token_hash_key UNIQUE (token_hash);

--
-- Name: admins admins_access_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_access_id_key UNIQUE (access_id);

--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);

--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);

--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

--
-- Name: balances balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balances
    ADD CONSTRAINT balances_pkey PRIMARY KEY (account_id);

--
-- Name: bank_accounts bank_accounts_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_id_account_id_key UNIQUE (id, account_id);

--
-- Name: bank_accounts bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_pkey PRIMARY KEY (id);

--
-- Name: bank_accounts bank_accounts_provider_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_provider_account_id_key UNIQUE (provider_account_id);

--
-- Name: benefit_programs benefit_programs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_programs
    ADD CONSTRAINT benefit_programs_pkey PRIMARY KEY (org_account_id);

--
-- Name: benefit_run_rows benefit_run_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_run_rows
    ADD CONSTRAINT benefit_run_rows_pkey PRIMARY KEY (id);

--
-- Name: benefit_run_rows benefit_run_rows_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_run_rows
    ADD CONSTRAINT benefit_run_rows_transaction_id_key UNIQUE (transaction_id);

--
-- Name: benefit_runs benefit_runs_org_account_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_runs
    ADD CONSTRAINT benefit_runs_org_account_id_idempotency_key_key UNIQUE (org_account_id, idempotency_key);

--
-- Name: benefit_runs benefit_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_runs
    ADD CONSTRAINT benefit_runs_pkey PRIMARY KEY (id);

--
-- Name: businesses businesses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_pkey PRIMARY KEY (account_id);

--
-- Name: categories categories_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_id_account_id_key UNIQUE (id, account_id);

--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

--
-- Name: checkout_items checkout_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkout_items
    ADD CONSTRAINT checkout_items_pkey PRIMARY KEY (id);

--
-- Name: checkouts checkouts_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkouts
    ADD CONSTRAINT checkouts_id_account_id_key UNIQUE (id, account_id);

--
-- Name: checkouts checkouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkouts
    ADD CONSTRAINT checkouts_pkey PRIMARY KEY (id);

--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);

--
-- Name: devices devices_session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_session_token_hash_key UNIQUE (session_token_hash);

--
-- Name: employees employees_org_account_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_org_account_id_employee_id_key UNIQUE (org_account_id, employee_id);

--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);

--
-- Name: fundings fundings_account_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fundings
    ADD CONSTRAINT fundings_account_id_idempotency_key_key UNIQUE (account_id, idempotency_key);

--
-- Name: fundings fundings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fundings
    ADD CONSTRAINT fundings_pkey PRIMARY KEY (id);

--
-- Name: fundings fundings_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fundings
    ADD CONSTRAINT fundings_transaction_id_key UNIQUE (transaction_id);

--
-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id);

--
-- Name: logs logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logs
    ADD CONSTRAINT logs_pkey PRIMARY KEY (id);

--
-- Name: orbs orbs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orbs
    ADD CONSTRAINT orbs_pkey PRIMARY KEY (id);

--
-- Name: orbs orbs_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orbs
    ADD CONSTRAINT orbs_uid_key UNIQUE (uid);

--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

--
-- Name: orders orders_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_transaction_id_key UNIQUE (transaction_id);

--
-- Name: passes passes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passes
    ADD CONSTRAINT passes_pkey PRIMARY KEY (id);

--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

--
-- Name: settlements settlements_cutoff_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_cutoff_date_key UNIQUE (cutoff_date);

--
-- Name: settlements settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_pkey PRIMARY KEY (id);

--
-- Name: shop shop_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop
    ADD CONSTRAINT shop_pkey PRIMARY KEY (id);

--
-- Name: snapshots snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_pkey PRIMARY KEY (id);

--
-- Name: snapshots snapshots_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_snapshot_date_key UNIQUE (snapshot_date);

--
-- Name: staff staff_account_id_staff_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_account_id_staff_account_id_key UNIQUE (account_id, staff_account_id);

--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (id);

--
-- Name: system system_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system
    ADD CONSTRAINT system_pkey PRIMARY KEY (key);

--
-- Name: tag_models tag_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_models
    ADD CONSTRAINT tag_models_pkey PRIMARY KEY (id);

--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

--
-- Name: tags tags_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_uid_key UNIQUE (uid);

--
-- Name: terminals terminals_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminals
    ADD CONSTRAINT terminals_id_account_id_key UNIQUE (id, account_id);

--
-- Name: terminals terminals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminals
    ADD CONSTRAINT terminals_pkey PRIMARY KEY (id);

--
-- Name: terminals terminals_session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminals
    ADD CONSTRAINT terminals_session_token_hash_key UNIQUE (session_token_hash);

--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);

--
-- Name: uploads uploads_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploads
    ADD CONSTRAINT uploads_path_key UNIQUE (path);

--
-- Name: uploads uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploads
    ADD CONSTRAINT uploads_pkey PRIMARY KEY (id);

--
-- Name: wallets wallets_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_id_account_id_key UNIQUE (id, account_id);

--
-- Name: wallets wallets_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_key_hash_key UNIQUE (key_hash);

--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);

--
-- Name: accounts_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_email_key ON public.accounts USING btree (lower(email)) WHERE (email IS NOT NULL);

--
-- Name: accounts_handle_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_handle_key ON public.accounts USING btree (handle);

--
-- Name: admin_sessions_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_sessions_admin_idx ON public.admin_sessions USING btree (admin_id) WHERE (revoked_at IS NULL);

--
-- Name: admin_sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_sessions_expires_idx ON public.admin_sessions USING btree (expires_at);

--
-- Name: api_keys_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_account_idx ON public.api_keys USING btree (account_id, created_at DESC);

--
-- Name: api_keys_one_active_per_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX api_keys_one_active_per_account ON public.api_keys USING btree (account_id) WHERE (revoked_at IS NULL);

--
-- Name: bank_accounts_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bank_accounts_account_id_idx ON public.bank_accounts USING btree (account_id);

--
-- Name: benefit_programs_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX benefit_programs_due_idx ON public.benefit_programs USING btree (next_run_date) WHERE (mode = 'fixed'::text);

--
-- Name: benefit_run_rows_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX benefit_run_rows_employee_idx ON public.benefit_run_rows USING btree (employee_ref, id DESC);

--
-- Name: benefit_run_rows_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX benefit_run_rows_run_idx ON public.benefit_run_rows USING btree (run_id, id);

--
-- Name: benefit_runs_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX benefit_runs_org_idx ON public.benefit_runs USING btree (org_account_id, created_at DESC, id DESC);

--
-- Name: categories_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_account_id_idx ON public.categories USING btree (account_id);

--
-- Name: checkout_items_checkout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checkout_items_checkout_idx ON public.checkout_items USING btree (checkout_id);

--
-- Name: checkout_items_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checkout_items_product_idx ON public.checkout_items USING btree (product_id) WHERE (product_id IS NOT NULL);

--
-- Name: checkouts_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checkouts_account_idx ON public.checkouts USING btree (account_id, created_at DESC, id DESC);

--
-- Name: checkouts_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checkouts_open_idx ON public.checkouts USING btree (account_id) WHERE (status = 'open'::text);

--
-- Name: devices_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_account_id_idx ON public.devices USING btree (account_id);

--
-- Name: devices_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_expires_idx ON public.devices USING btree (session_expires_at) WHERE (session_expires_at IS NOT NULL);

--
-- Name: devices_revoked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_revoked_idx ON public.devices USING btree (revoked_at) WHERE (revoked_at IS NOT NULL);

--
-- Name: devices_unredeemed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_unredeemed_idx ON public.devices USING btree (created_at) WHERE (session_token_hash IS NULL);

--
-- Name: devices_wallet_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_wallet_id_idx ON public.devices USING btree (wallet_id) WHERE (wallet_id IS NOT NULL);

--
-- Name: employees_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employees_account_idx ON public.employees USING btree (employee_account_id) WHERE (employee_account_id IS NOT NULL);

--
-- Name: employees_claim_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX employees_claim_token_key ON public.employees USING btree (claim_token_hash) WHERE (claim_token_hash IS NOT NULL);

--
-- Name: employees_org_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employees_org_active_idx ON public.employees USING btree (org_account_id, created_at DESC, id DESC) WHERE (status = 'active'::text);

--
-- Name: employees_unclaimed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employees_unclaimed_idx ON public.employees USING btree (reminded_at NULLS FIRST) WHERE ((employee_account_id IS NULL) AND (balance > 0));

--
-- Name: fundings_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fundings_account_idx ON public.fundings USING btree (account_id, created_at DESC, id DESC);

--
-- Name: fundings_bank_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fundings_bank_account_idx ON public.fundings USING btree (bank_account_id);

--
-- Name: fundings_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fundings_open_idx ON public.fundings USING btree (status) WHERE (status = ANY (ARRAY['created'::text, 'pending'::text]));

--
-- Name: fundings_provider_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fundings_provider_ref_idx ON public.fundings USING btree (provider_reference) WHERE (provider_reference IS NOT NULL);

--
-- Name: ledger_entries_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_account_idx ON public.ledger_entries USING btree (account_id, id DESC) WHERE (account_id IS NOT NULL);

--
-- Name: ledger_entries_funding_line_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ledger_entries_funding_line_key ON public.ledger_entries USING btree (funding_id, posting_key, line_no) WHERE (funding_id IS NOT NULL);

--
-- Name: ledger_entries_txn_line_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ledger_entries_txn_line_key ON public.ledger_entries USING btree (transaction_id, posting_key, line_no) WHERE (transaction_id IS NOT NULL);

--
-- Name: ledger_entries_wallet_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_wallet_idx ON public.ledger_entries USING btree (wallet_id, id DESC) WHERE (wallet_id IS NOT NULL);

--
-- Name: logs_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logs_action_idx ON public.logs USING btree (action, created_at DESC);

--
-- Name: logs_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logs_actor_idx ON public.logs USING btree (actor_id, created_at DESC) WHERE (actor_id IS NOT NULL);

--
-- Name: logs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logs_created_idx ON public.logs USING btree (created_at DESC, id DESC);

--
-- Name: logs_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logs_target_idx ON public.logs USING btree (target_id, created_at DESC) WHERE (target_id IS NOT NULL);

--
-- Name: orbs_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orbs_account_id_idx ON public.orbs USING btree (account_id) WHERE (account_id IS NOT NULL);

--
-- Name: orbs_terminal_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX orbs_terminal_id_key ON public.orbs USING btree (terminal_id) WHERE (terminal_id IS NOT NULL);

--
-- Name: orders_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_account_idx ON public.orders USING btree (account_id, created_at DESC, id DESC);

--
-- Name: orders_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_model_idx ON public.orders USING btree (model_id) WHERE (model_id IS NOT NULL);

--
-- Name: orders_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_shop_idx ON public.orders USING btree (shop_id) WHERE (shop_id IS NOT NULL);

--
-- Name: orders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_status_idx ON public.orders USING btree (status) WHERE (status = 'paid'::text);

--
-- Name: passes_wallet_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX passes_wallet_id_idx ON public.passes USING btree (wallet_id);

--
-- Name: products_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_account_id_idx ON public.products USING btree (account_id);

--
-- Name: products_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_category_id_idx ON public.products USING btree (category_id) WHERE (category_id IS NOT NULL);

--
-- Name: staff_staff_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_staff_account_idx ON public.staff USING btree (staff_account_id);

--
-- Name: tags_model_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tags_model_id_idx ON public.tags USING btree (model_id);

--
-- Name: tags_wallet_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tags_wallet_id_idx ON public.tags USING btree (wallet_id) WHERE (wallet_id IS NOT NULL);

--
-- Name: terminals_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminals_account_id_idx ON public.terminals USING btree (account_id);

--
-- Name: transactions_checkout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_checkout_idx ON public.transactions USING btree (checkout_id) WHERE (checkout_id IS NOT NULL);

--
-- Name: transactions_checkout_paid_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_checkout_paid_key ON public.transactions USING btree (checkout_id) WHERE ((type = 'pay'::text) AND (status = 'completed'::text));

--
-- Name: transactions_completed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_completed_at_idx ON public.transactions USING btree (completed_at) WHERE (status = 'completed'::text);

--
-- Name: transactions_from_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_from_account_idx ON public.transactions USING btree (from_account_id, "timestamp" DESC, id DESC);

--
-- Name: transactions_from_wallet_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_from_wallet_idx ON public.transactions USING btree (from_wallet_id) WHERE (from_wallet_id IS NOT NULL);

--
-- Name: transactions_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_idempotency_key ON public.transactions USING btree (type, from_account_id, idempotency_key) WHERE ((from_account_id IS NOT NULL) AND (type <> 'pay'::text));

--
-- Name: transactions_pass_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_pass_idx ON public.transactions USING btree (pass_id) WHERE (pass_id IS NOT NULL);

--
-- Name: transactions_pay_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_pay_idempotency_key ON public.transactions USING btree (to_account_id, idempotency_key) WHERE (type = 'pay'::text);

--
-- Name: transactions_provider_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_provider_ref_idx ON public.transactions USING btree (provider_reference) WHERE (provider_reference IS NOT NULL);

--
-- Name: transactions_related_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_related_idx ON public.transactions USING btree (related_transaction_id) WHERE (related_transaction_id IS NOT NULL);

--
-- Name: transactions_settlement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_settlement_idx ON public.transactions USING btree (settlement_id) WHERE (settlement_id IS NOT NULL);

--
-- Name: transactions_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_tag_idx ON public.transactions USING btree (tag_id) WHERE (tag_id IS NOT NULL);

--
-- Name: transactions_terminal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_terminal_idx ON public.transactions USING btree (terminal_id, "timestamp" DESC, id DESC) WHERE (terminal_id IS NOT NULL);

--
-- Name: transactions_to_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_to_account_idx ON public.transactions USING btree (to_account_id, "timestamp" DESC, id DESC);

--
-- Name: transactions_to_wallet_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_to_wallet_idx ON public.transactions USING btree (to_wallet_id) WHERE (to_wallet_id IS NOT NULL);

--
-- Name: uploads_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX uploads_account_idx ON public.uploads USING btree (account_id, created_at DESC);

--
-- Name: wallets_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallets_account_id_idx ON public.wallets USING btree (account_id);

--
-- Name: wallets_one_benefits_per_employer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallets_one_benefits_per_employer ON public.wallets USING btree (account_id, org_account_id) WHERE ((type = 'benefits'::text) AND (status <> 'closed'::text));

--
-- Name: wallets_one_default_per_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallets_one_default_per_account ON public.wallets USING btree (account_id) WHERE (type = 'default'::text);

--
-- Name: wallets_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallets_org_idx ON public.wallets USING btree (org_account_id) WHERE (org_account_id IS NOT NULL);

--
-- Name: accounts accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: admins admins_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER admins_updated_at BEFORE UPDATE ON public.admins FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: balances balances_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER balances_updated_at BEFORE UPDATE ON public.balances FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: bank_accounts bank_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bank_accounts_updated_at BEFORE UPDATE ON public.bank_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: benefit_programs benefit_programs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER benefit_programs_updated_at BEFORE UPDATE ON public.benefit_programs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: benefit_runs benefit_runs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER benefit_runs_updated_at BEFORE UPDATE ON public.benefit_runs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: businesses businesses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER businesses_updated_at BEFORE UPDATE ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: categories categories_business_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_business_only BEFORE INSERT OR UPDATE OF account_id ON public.categories FOR EACH ROW EXECUTE FUNCTION public.require_business_account();

--
-- Name: categories categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: checkout_items checkout_items_same_merchant; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER checkout_items_same_merchant BEFORE INSERT OR UPDATE OF product_id, checkout_id ON public.checkout_items FOR EACH ROW EXECUTE FUNCTION public.checkout_item_same_merchant();

--
-- Name: checkouts checkouts_business_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER checkouts_business_only BEFORE INSERT OR UPDATE OF account_id ON public.checkouts FOR EACH ROW EXECUTE FUNCTION public.require_business_account();

--
-- Name: checkouts checkouts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER checkouts_updated_at BEFORE UPDATE ON public.checkouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: employees employees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: fundings fundings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fundings_updated_at BEFORE UPDATE ON public.fundings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: ledger_entries ledger_entries_balanced; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON public.ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ledger_check_balanced();

--
-- Name: ledger_entries ledger_entries_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON public.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_entries_immutable();

--
-- Name: ledger_entries ledger_entries_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ledger_entries_no_update BEFORE DELETE OR UPDATE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION public.ledger_entries_immutable();

--
-- Name: logs logs_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER logs_no_truncate BEFORE TRUNCATE ON public.logs FOR EACH STATEMENT EXECUTE FUNCTION public.logs_immutable();

--
-- Name: logs logs_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER logs_no_update BEFORE DELETE OR UPDATE ON public.logs FOR EACH ROW EXECUTE FUNCTION public.logs_immutable();

--
-- Name: orbs orbs_business_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbs_business_only BEFORE INSERT OR UPDATE OF account_id ON public.orbs FOR EACH ROW EXECUTE FUNCTION public.require_business_account();

--
-- Name: orbs orbs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbs_updated_at BEFORE UPDATE ON public.orbs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: orders orders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: passes passes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER passes_updated_at BEFORE UPDATE ON public.passes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: products products_business_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_business_only BEFORE INSERT OR UPDATE OF account_id ON public.products FOR EACH ROW EXECUTE FUNCTION public.require_business_account();

--
-- Name: products products_sync_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_sync_status BEFORE INSERT OR UPDATE OF stock, status ON public.products FOR EACH ROW EXECUTE FUNCTION public.products_sync_status();

--
-- Name: products products_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: settlements settlements_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_updated_at BEFORE UPDATE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: shop shop_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER shop_updated_at BEFORE UPDATE ON public.shop FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: snapshots snapshots_final; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshots_final BEFORE DELETE OR UPDATE ON public.snapshots FOR EACH ROW EXECUTE FUNCTION public.snapshots_final();

--
-- Name: staff staff_account_types; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER staff_account_types BEFORE INSERT OR UPDATE OF account_id, staff_account_id ON public.staff FOR EACH ROW EXECUTE FUNCTION public.staff_account_types();

--
-- Name: staff staff_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER staff_updated_at BEFORE UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: system system_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER system_updated_at BEFORE UPDATE ON public.system FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: tags tags_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tags_updated_at BEFORE UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: terminals terminals_business_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER terminals_business_only BEFORE INSERT OR UPDATE OF account_id ON public.terminals FOR EACH ROW EXECUTE FUNCTION public.require_business_account();

--
-- Name: terminals terminals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER terminals_updated_at BEFORE UPDATE ON public.terminals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: transactions transactions_checkout_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transactions_checkout_owner BEFORE INSERT OR UPDATE OF checkout_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.transactions_checkout_owner();

--
-- Name: transactions transactions_terminal_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transactions_terminal_owner BEFORE INSERT OR UPDATE OF terminal_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.transactions_terminal_owner();

--
-- Name: wallets wallets_benefits_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallets_benefits_immutable BEFORE UPDATE OF type, org_account_id, account_id ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.wallets_benefits_immutable();

--
-- Name: wallets wallets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: admin_sessions admin_sessions_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id) ON DELETE RESTRICT;

--
-- Name: admins admins_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE RESTRICT;

--
-- Name: api_keys api_keys_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: balances balances_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balances
    ADD CONSTRAINT balances_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: bank_accounts bank_accounts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: benefit_programs benefit_programs_org_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_programs
    ADD CONSTRAINT benefit_programs_org_account_id_fkey FOREIGN KEY (org_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: benefit_run_rows benefit_run_rows_employee_ref_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_run_rows
    ADD CONSTRAINT benefit_run_rows_employee_ref_fkey FOREIGN KEY (employee_ref) REFERENCES public.employees(id) ON DELETE RESTRICT;

--
-- Name: benefit_run_rows benefit_run_rows_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_run_rows
    ADD CONSTRAINT benefit_run_rows_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.benefit_runs(id) ON DELETE RESTRICT;

--
-- Name: benefit_run_rows benefit_run_rows_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_run_rows
    ADD CONSTRAINT benefit_run_rows_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

--
-- Name: benefit_runs benefit_runs_org_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.benefit_runs
    ADD CONSTRAINT benefit_runs_org_account_id_fkey FOREIGN KEY (org_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: businesses businesses_account_id_account_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_account_id_account_type_fkey FOREIGN KEY (account_id, account_type) REFERENCES public.accounts(id, type) ON DELETE RESTRICT;

--
-- Name: businesses businesses_bank_account_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_bank_account_id_account_id_fkey FOREIGN KEY (bank_account_id, account_id) REFERENCES public.bank_accounts(id, account_id) ON DELETE RESTRICT;

--
-- Name: categories categories_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: checkout_items checkout_items_checkout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkout_items
    ADD CONSTRAINT checkout_items_checkout_id_fkey FOREIGN KEY (checkout_id) REFERENCES public.checkouts(id) ON DELETE RESTRICT;

--
-- Name: checkout_items checkout_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkout_items
    ADD CONSTRAINT checkout_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;

--
-- Name: checkouts checkouts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkouts
    ADD CONSTRAINT checkouts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: checkouts checkouts_terminal_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkouts
    ADD CONSTRAINT checkouts_terminal_id_account_id_fkey FOREIGN KEY (terminal_id, account_id) REFERENCES public.terminals(id, account_id) ON DELETE RESTRICT;

--
-- Name: devices devices_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: devices devices_wallet_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_wallet_id_account_id_fkey FOREIGN KEY (wallet_id, account_id) REFERENCES public.wallets(id, account_id) ON DELETE RESTRICT;

--
-- Name: employees employees_employee_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_employee_account_id_fkey FOREIGN KEY (employee_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: employees employees_org_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_org_account_id_fkey FOREIGN KEY (org_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: fundings fundings_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fundings
    ADD CONSTRAINT fundings_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: fundings fundings_bank_account_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fundings
    ADD CONSTRAINT fundings_bank_account_id_account_id_fkey FOREIGN KEY (bank_account_id, account_id) REFERENCES public.bank_accounts(id, account_id) ON DELETE RESTRICT;

--
-- Name: fundings fundings_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fundings
    ADD CONSTRAINT fundings_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

--
-- Name: ledger_entries ledger_entries_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: ledger_entries ledger_entries_funding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_funding_id_fkey FOREIGN KEY (funding_id) REFERENCES public.fundings(id) ON DELETE RESTRICT;

--
-- Name: ledger_entries ledger_entries_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

--
-- Name: ledger_entries ledger_entries_wallet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT;

--
-- Name: orbs orbs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orbs
    ADD CONSTRAINT orbs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: orbs orbs_terminal_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orbs
    ADD CONSTRAINT orbs_terminal_id_account_id_fkey FOREIGN KEY (terminal_id, account_id) REFERENCES public.terminals(id, account_id) ON DELETE RESTRICT;

--
-- Name: orders orders_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: orders orders_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.tag_models(id) ON DELETE RESTRICT;

--
-- Name: orders orders_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shop(id) ON DELETE RESTRICT;

--
-- Name: orders orders_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

--
-- Name: orders orders_wallet_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_wallet_id_account_id_fkey FOREIGN KEY (wallet_id, account_id) REFERENCES public.wallets(id, account_id) ON DELETE RESTRICT;

--
-- Name: passes passes_wallet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passes
    ADD CONSTRAINT passes_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT;

--
-- Name: products products_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: products products_category_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_account_id_fkey FOREIGN KEY (category_id, account_id) REFERENCES public.categories(id, account_id) ON DELETE RESTRICT;

--
-- Name: staff staff_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: staff staff_bank_account_id_staff_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_bank_account_id_staff_account_id_fkey FOREIGN KEY (bank_account_id, staff_account_id) REFERENCES public.bank_accounts(id, account_id) ON DELETE RESTRICT;

--
-- Name: staff staff_staff_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_staff_account_id_fkey FOREIGN KEY (staff_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: tags tags_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.tag_models(id) ON DELETE RESTRICT;

--
-- Name: tags tags_wallet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT;

--
-- Name: terminals terminals_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminals
    ADD CONSTRAINT terminals_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_approved_by_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_approved_by_account_id_fkey FOREIGN KEY (approved_by_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_checkout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_checkout_id_fkey FOREIGN KEY (checkout_id) REFERENCES public.checkouts(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_from_account_id_fkey FOREIGN KEY (from_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_from_bank_account_id_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_from_bank_account_id_from_account_id_fkey FOREIGN KEY (from_bank_account_id, from_account_id) REFERENCES public.bank_accounts(id, account_id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_from_wallet_id_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_from_wallet_id_from_account_id_fkey FOREIGN KEY (from_wallet_id, from_account_id) REFERENCES public.wallets(id, account_id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_pass_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pass_id_fkey FOREIGN KEY (pass_id) REFERENCES public.passes(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_related_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_related_transaction_id_fkey FOREIGN KEY (related_transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_settlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_settlement_id_fkey FOREIGN KEY (settlement_id) REFERENCES public.settlements(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_terminal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_to_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_to_account_id_fkey FOREIGN KEY (to_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_to_bank_account_id_to_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_to_bank_account_id_to_account_id_fkey FOREIGN KEY (to_bank_account_id, to_account_id) REFERENCES public.bank_accounts(id, account_id) ON DELETE RESTRICT;

--
-- Name: transactions transactions_to_wallet_id_to_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_to_wallet_id_to_account_id_fkey FOREIGN KEY (to_wallet_id, to_account_id) REFERENCES public.wallets(id, account_id) ON DELETE RESTRICT;

--
-- Name: uploads uploads_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploads
    ADD CONSTRAINT uploads_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

--
-- Name: wallets wallets_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- Name: wallets wallets_org_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_org_account_id_fkey FOREIGN KEY (org_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

--
-- PostgreSQL database dump complete
--


-- Seed: the program day the daily counters were last reset (removed when the daily reset machinery goes away).
INSERT INTO system (key, value) VALUES ('daily_reset_day', ((now() AT TIME ZONE 'America/New_York')::date)::text);
