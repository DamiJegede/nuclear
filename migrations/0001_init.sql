
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
    CONSTRAINT accounts_type_check CHECK ((type = ANY (ARRAY['C'::bpchar, 'B'::bpchar, 'O'::bpchar, 'S'::bpchar])))
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
    legal_name text,
    display_name text,
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
    program_mode text DEFAULT 'flexible'::text NOT NULL,
    program_cadence text,
    program_day_of_month smallint,
    program_weekday smallint,
    program_start_date date,
    program_next_run_date date,
    program_warned_for date,
    program_last_attempt_at timestamp with time zone,
    program_chosen_at timestamp with time zone,
    api_key_hash text,
    api_key_hint text,
    api_key_created_at timestamp with time zone,
    api_key_last_used_at timestamp with time zone,
    CONSTRAINT businesses_names_together CHECK (((legal_name IS NULL) = (display_name IS NULL))),
    CONSTRAINT businesses_program_mode_check CHECK ((program_mode = ANY (ARRAY['fixed'::text, 'flexible'::text]))),
    CONSTRAINT businesses_program_cadence_check CHECK ((program_cadence = ANY (ARRAY['monthly'::text, 'weekly'::text, 'biweekly'::text]))),
    CONSTRAINT businesses_program_day_check CHECK (((program_day_of_month >= 1) AND (program_day_of_month <= 28))),
    CONSTRAINT businesses_program_weekday_check CHECK (((program_weekday >= 0) AND (program_weekday <= 6))),
    CONSTRAINT businesses_program_fixed_check CHECK (((program_mode = 'flexible'::text) OR ((program_cadence IS NOT NULL) AND (program_next_run_date IS NOT NULL)))),
    CONSTRAINT businesses_program_monthly_check CHECK (((program_cadence IS DISTINCT FROM 'monthly'::text) OR (program_day_of_month IS NOT NULL))),
    CONSTRAINT businesses_program_weekly_check CHECK (((program_cadence IS NULL) OR (program_cadence = 'monthly'::text) OR (program_weekday IS NOT NULL))),
    CONSTRAINT businesses_program_biweekly_check CHECK (((program_cadence IS DISTINCT FROM 'biweekly'::text) OR (program_start_date IS NOT NULL))),
    CONSTRAINT businesses_api_key_check CHECK (((api_key_hash IS NULL) = (api_key_hint IS NULL))),
    CONSTRAINT businesses_api_key_hint_check CHECK (((api_key_hint IS NULL) OR (length(api_key_hint) = 4))),
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
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    wallet_id uuid,
    platform text,
    push_token text,
    redeemed_at timestamp with time zone,
    session_expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_accessed_at timestamp with time zone,
    CONSTRAINT devices_check CHECK (((redeemed_at IS NULL) = (session_expires_at IS NULL))),
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
    sold_day date,
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
    balance_midnight bigint,
    credit_midnight bigint,
    wallets_midnight bigint,
    effects_delta bigint DEFAULT 0 NOT NULL,
    effects_credit bigint DEFAULT 0 NOT NULL,
    effects_wallets bigint DEFAULT 0 NOT NULL,
    edge_flows bigint DEFAULT 0 NOT NULL,
    drift bigint DEFAULT 0 NOT NULL,
    drift_credit bigint DEFAULT 0 NOT NULL,
    drift_wallets bigint DEFAULT 0 NOT NULL,
    drift_conservation bigint DEFAULT 0 NOT NULL,
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
    orb_uid text,
    orb_model text,
    orb_software text,
    orb_paired_at timestamp with time zone,
    CONSTRAINT terminals_orb_all_or_none CHECK ((((orb_uid IS NULL) = (orb_model IS NULL)) AND ((orb_uid IS NULL) = (orb_software IS NULL)) AND ((orb_uid IS NULL) = (orb_paired_at IS NULL)))),
    CONSTRAINT terminals_orb_uid_format CHECK (((orb_uid IS NULL) OR (orb_uid ~ '^[0-9A-F]{12}$'::text))),
    CONSTRAINT terminals_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80)))
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
    spent_day date,
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
    CONSTRAINT wallets_type_check CHECK ((type = ANY (ARRAY['default'::text, 'agent'::text, 'person'::text, 'benefits'::text, 'escrow'::text, 'system'::text])))
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
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


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
-- Name: logs logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logs
    ADD CONSTRAINT logs_pkey PRIMARY KEY (id);

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
-- Name: bank_accounts_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bank_accounts_account_id_idx ON public.bank_accounts USING btree (account_id);

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

CREATE INDEX devices_unredeemed_idx ON public.devices USING btree (created_at) WHERE (redeemed_at IS NULL);

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
-- Name: employees employees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: fundings fundings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fundings_updated_at BEFORE UPDATE ON public.fundings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: logs logs_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER logs_no_truncate BEFORE TRUNCATE ON public.logs FOR EACH STATEMENT EXECUTE FUNCTION public.logs_immutable();

--
-- Name: logs logs_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER logs_no_update BEFORE DELETE OR UPDATE ON public.logs FOR EACH ROW EXECUTE FUNCTION public.logs_immutable();

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

-- Organization (type O) settings live on the business row: the Benefits program (Fixed or Flexible, created with the organization) and its one live Benefits API key.
CREATE UNIQUE INDEX businesses_api_key_hash_key ON public.businesses USING btree (api_key_hash) WHERE (api_key_hash IS NOT NULL);
CREATE INDEX businesses_program_due_idx ON public.businesses USING btree (program_next_run_date) WHERE (program_mode = 'fixed'::text);

-- A terminal holds at most one Orb, and an Orb (its MAC address) is on at most one terminal: freeing it clears these columns.
CREATE UNIQUE INDEX terminals_orb_uid_key ON public.terminals USING btree (orb_uid) WHERE (orb_uid IS NOT NULL);

-- ---------------------------------------------------------------------------------------------------------------
-- Scheme v2 core (docs/SCHEME-V2.md): the system account and wallets, immutable wallet-to-wallet transactions,
-- and the workflow tables around them (checkouts, settlements, refunds). There is no ledger table.
-- ---------------------------------------------------------------------------------------------------------------

-- The program day (America/New_York). Daily counters roll themselves: a row whose day is not today counts as zero, and the
-- next write starts the new day (docs/SCHEME-V2.md, section 4). There is no daily reset job.
CREATE FUNCTION public.program_today() RETURNS date
    LANGUAGE sql STABLE
    AS $$ SELECT (now() AT TIME ZONE 'America/New_York')::date $$;
ALTER TABLE public.wallets ALTER COLUMN spent_day SET DEFAULT program_today(), ALTER COLUMN spent_day SET NOT NULL;
ALTER TABLE public.products ALTER COLUMN sold_day SET DEFAULT program_today(), ALTER COLUMN sold_day SET NOT NULL;

-- What an account can spend from its shared funds: the balance less everything set aside in earmarked wallets. For an organization that is
-- its balance less the escrow wallet (credit held for employees who have not claimed it yet).
CREATE FUNCTION public.shared_funds(acct uuid) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$ SELECT coalesce((SELECT balance FROM balances WHERE account_id = acct), 0) - coalesce((SELECT sum(balance) FROM wallets WHERE account_id = acct AND balance IS NOT NULL), 0) $$;
CREATE UNIQUE INDEX wallets_escrow_key ON public.wallets USING btree (account_id) WHERE (type = 'escrow');

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_escrow_earmarked CHECK (type <> 'escrow' OR balance IS NOT NULL),
    ADD CONSTRAINT wallets_system_unearmarked CHECK (type <> 'system' OR balance IS NULL);

-- The system account ("Nuclear") and its two system wallets have fixed ids (constants in lib/system.ts): nothing is looked up.
INSERT INTO accounts (id, type, name, status) VALUES ('00000000-0000-7000-8000-000000000001', 'S', 'Nuclear', 'active');
INSERT INTO balances (account_id) VALUES ('00000000-0000-7000-8000-000000000001');
INSERT INTO wallets (id, account_id, display_name, type) VALUES
  ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'Nuclear Bank', 'system'),
  ('00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000001', 'Nuclear Shop', 'system');

-- A merchant's order: an open payment request a customer can pay (by tap or in the app). Items are a snapshot.
-- Expired is derived from expires_at; the status is written once at the end (paid or canceled).
CREATE TABLE public.checkouts (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    terminal_id uuid,
    reference text,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    total bigint NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT checkouts_pkey PRIMARY KEY (id),
    CONSTRAINT checkouts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT,
    CONSTRAINT checkouts_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id) ON DELETE RESTRICT,
    CONSTRAINT checkouts_items_array CHECK (jsonb_typeof(items) = 'array'),
    CONSTRAINT checkouts_reference_check CHECK (((reference IS NULL) OR ((length(reference) >= 1) AND (length(reference) <= 64)))),
    CONSTRAINT checkouts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'paid'::text, 'canceled'::text]))),
    CONSTRAINT checkouts_total_check CHECK ((total > 0))
);
CREATE INDEX checkouts_account_idx ON public.checkouts USING btree (account_id, status, created_at DESC, id DESC);
CREATE TRIGGER checkouts_updated_at BEFORE UPDATE ON public.checkouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per merchant per day: the payout (credit) or collection (debit) sent to the bank. Run totals are a group by on settle_date.
CREATE TABLE public.settlements (
    id uuid DEFAULT uuidv7() NOT NULL,
    settle_date date NOT NULL,
    merchant_account_id uuid NOT NULL,
    bank_account_id uuid NOT NULL,
    direction text NOT NULL,
    amount bigint NOT NULL,
    status text DEFAULT 'submitted'::text NOT NULL,
    provider_reference text,
    failure_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlements_pkey PRIMARY KEY (id),
    CONSTRAINT settlements_day_merchant_key UNIQUE (settle_date, merchant_account_id),
    CONSTRAINT settlements_merchant_fkey FOREIGN KEY (merchant_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT,
    CONSTRAINT settlements_bank_fkey FOREIGN KEY (bank_account_id, merchant_account_id) REFERENCES public.bank_accounts(id, account_id) ON DELETE RESTRICT,
    CONSTRAINT settlements_amount_check CHECK (amount > 0),
    CONSTRAINT settlements_direction_check CHECK (direction IN ('credit', 'debit')),
    CONSTRAINT settlements_status_check CHECK (status IN ('submitted', 'settled', 'returned', 'failed')),
    CONSTRAINT settlements_resolved_check CHECK ((status = 'submitted') = (resolved_at IS NULL))
);
CREATE INDEX settlements_open_idx ON public.settlements USING btree (status) WHERE (status = 'submitted');
CREATE INDEX settlements_merchant_idx ON public.settlements USING btree (merchant_account_id, settle_date DESC);
CREATE TRIGGER settlements_updated_at BEFORE UPDATE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Every transaction is from one wallet to one wallet and is written once with its final outcome. A correction is a new row.
CREATE TABLE public.transactions (
    id uuid DEFAULT uuidv7() NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    status_code text,
    from_wallet_id uuid NOT NULL,
    to_wallet_id uuid NOT NULL,
    amount bigint NOT NULL,
    credit_amount bigint DEFAULT 0 NOT NULL,
    related_id uuid,
    tag_id uuid,
    pass_id uuid,
    terminal_id uuid,
    checkout_id uuid,
    funding_id uuid,
    settlement_id uuid,
    account_id uuid NOT NULL,
    reference text,
    idem text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transactions_pkey PRIMARY KEY (id),
    CONSTRAINT transactions_idem_key UNIQUE (idem),
    CONSTRAINT transactions_type_check CHECK (type IN ('fund', 'fund_return', 'send', 'pay', 'refund', 'purchase', 'allocate', 'claim', 'move', 'settle', 'settle_return', 'collect', 'adjustment')),
    CONSTRAINT transactions_status_check CHECK (status IN ('completed', 'declined')),
    CONSTRAINT transactions_status_code_check CHECK ((status = 'declined') = (status_code IS NOT NULL)),
    CONSTRAINT transactions_amount_check CHECK (amount > 0),
    CONSTRAINT transactions_credit_check CHECK (credit_amount >= 0 AND credit_amount <= amount),
    CONSTRAINT transactions_credit_types CHECK (credit_amount = 0 OR type IN ('pay', 'fund', 'refund')),
    CONSTRAINT transactions_sides_check CHECK (type = 'move' OR from_wallet_id <> to_wallet_id),
    CONSTRAINT transactions_tag_pass_check CHECK (tag_id IS NULL OR pass_id IS NULL),
    CONSTRAINT transactions_credential_pay_only CHECK ((tag_id IS NULL AND pass_id IS NULL) OR type = 'pay'),
    CONSTRAINT transactions_related_types CHECK (related_id IS NULL OR type IN ('refund', 'fund_return', 'settle_return', 'adjustment')),
    CONSTRAINT transactions_terminal_scope CHECK (terminal_id IS NULL OR type IN ('pay', 'refund')),
    CONSTRAINT transactions_checkout_scope CHECK (checkout_id IS NULL OR type IN ('pay', 'refund')),
    CONSTRAINT transactions_funding_scope CHECK (funding_id IS NULL OR type IN ('fund', 'fund_return')),
    CONSTRAINT transactions_settlement_scope CHECK (settlement_id IS NULL OR type IN ('settle', 'settle_return', 'collect')),
    CONSTRAINT transactions_reference_check CHECK (reference IS NULL OR (type IN ('pay', 'refund') AND length(reference) BETWEEN 1 AND 64)),
    CONSTRAINT transactions_meta_object CHECK (jsonb_typeof(meta) = 'object'),
    CONSTRAINT transactions_from_wallet_fkey FOREIGN KEY (from_wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_to_wallet_fkey FOREIGN KEY (to_wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_account_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_related_fkey FOREIGN KEY (related_id) REFERENCES public.transactions(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_tag_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_pass_fkey FOREIGN KEY (pass_id) REFERENCES public.passes(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_terminal_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_checkout_fkey FOREIGN KEY (checkout_id) REFERENCES public.checkouts(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_funding_fkey FOREIGN KEY (funding_id) REFERENCES public.fundings(id) ON DELETE RESTRICT,
    CONSTRAINT transactions_settlement_fkey FOREIGN KEY (settlement_id) REFERENCES public.settlements(id) ON DELETE RESTRICT
);
CREATE INDEX transactions_from_wallet_idx ON public.transactions USING btree (from_wallet_id, created_at DESC, id DESC);
CREATE INDEX transactions_to_wallet_idx ON public.transactions USING btree (to_wallet_id, created_at DESC, id DESC);
CREATE INDEX transactions_created_idx ON public.transactions USING btree (created_at DESC, id DESC);
CREATE UNIQUE INDEX transactions_checkout_paid_key ON public.transactions USING btree (checkout_id) WHERE (type = 'pay' AND status = 'completed');
CREATE INDEX transactions_related_idx ON public.transactions USING btree (related_id) WHERE (related_id IS NOT NULL);
CREATE INDEX transactions_terminal_idx ON public.transactions USING btree (terminal_id, created_at DESC) WHERE (terminal_id IS NOT NULL);

-- Immutable: no update, no truncate; the only permitted delete is a declined row older than 90 days (the retention job).
CREATE FUNCTION public.transactions_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'declined' AND OLD.created_at < now() - interval '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'transactions are immutable; write a new transaction to correct one';
END;
$$;
CREATE TRIGGER transactions_no_update BEFORE DELETE OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.transactions_immutable();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON public.transactions FOR EACH STATEMENT EXECUTE FUNCTION public.transactions_immutable();

-- A terminal or checkout named on a payment or refund belongs to the merchant that is the receiving (pay) or sending (refund) side.
CREATE FUNCTION public.transactions_merchant_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  merchant uuid;
BEGIN
  IF NEW.terminal_id IS NULL AND NEW.checkout_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT account_id INTO merchant FROM wallets WHERE id = CASE NEW.type WHEN 'pay' THEN NEW.to_wallet_id ELSE NEW.from_wallet_id END;
  IF NEW.terminal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM terminals t WHERE t.id = NEW.terminal_id AND t.account_id = merchant) THEN
    RAISE EXCEPTION 'terminal does not belong to the merchant account' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.checkout_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM checkouts c WHERE c.id = NEW.checkout_id AND c.account_id = merchant) THEN
    RAISE EXCEPTION 'checkout does not belong to the merchant account' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transactions_merchant_scope BEFORE INSERT ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.transactions_merchant_scope();

-- Refund requests. A pending request reserves its amount (and item quantities); approving writes the refund transaction
-- with this row's id as its own id, and rejecting just closes it. A refund that needs no approval is written directly.
CREATE TABLE public.refunds (
    id uuid DEFAULT uuidv7() NOT NULL,
    merchant_account_id uuid NOT NULL,
    pay_transaction_id uuid NOT NULL,
    terminal_id uuid,
    amount bigint NOT NULL,
    mode text NOT NULL,
    items jsonb,
    reference text,
    status text DEFAULT 'pending'::text NOT NULL,
    idem text NOT NULL,
    approved_by_account_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT refunds_pkey PRIMARY KEY (id),
    CONSTRAINT refunds_idem_key UNIQUE (idem),
    CONSTRAINT refunds_amount_check CHECK (amount > 0),
    CONSTRAINT refunds_mode_check CHECK (mode IN ('full', 'partial', 'items')),
    CONSTRAINT refunds_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT refunds_items_check CHECK ((mode = 'items') = (items IS NOT NULL)),
    CONSTRAINT refunds_resolved_check CHECK ((status = 'pending') = (resolved_at IS NULL)),
    CONSTRAINT refunds_merchant_fkey FOREIGN KEY (merchant_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT,
    CONSTRAINT refunds_pay_fkey FOREIGN KEY (pay_transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT,
    CONSTRAINT refunds_terminal_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id) ON DELETE RESTRICT,
    CONSTRAINT refunds_approver_fkey FOREIGN KEY (approved_by_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT
);
CREATE INDEX refunds_pending_idx ON public.refunds USING btree (merchant_account_id, created_at DESC, id DESC) WHERE (status = 'pending');
CREATE INDEX refunds_pay_idx ON public.refunds USING btree (pay_transaction_id);

-- Links from the workflow tables to the transactions they produced.
ALTER TABLE ONLY public.benefit_run_rows ADD CONSTRAINT benefit_run_rows_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.fundings ADD CONSTRAINT fundings_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.orders ADD CONSTRAINT orders_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

-- The account-level read view used by activity feeds, admin lists and support pages: the old column names, with the system wallets
-- (the bank, the shop) shown as no account (null side), a declined row reported as `failed`, and each pending refund request
-- (workflow row, not a transaction) listed as a pending refund, and a rejected one as a failed refund.
CREATE VIEW public.txn AS
SELECT t.id, t.type,
       CASE t.status WHEN 'declined' THEN 'failed' ELSE t.status END AS status,
       t.status_code,
       CASE WHEN fw.type = 'system' THEN NULL ELSE fw.account_id END AS from_account_id,
       CASE WHEN tw.type = 'system' THEN NULL ELSE tw.account_id END AS to_account_id,
       CASE WHEN fw.type = 'system' THEN NULL ELSE t.from_wallet_id END AS from_wallet_id,
       CASE WHEN tw.type = 'system' THEN NULL ELSE t.to_wallet_id END AS to_wallet_id,
       t.amount, t.credit_amount, t.related_id AS related_transaction_id, t.terminal_id, t.reference,
       CASE WHEN t.type = 'refund' AND t.meta ? 'approved' THEN t.account_id END AS approved_by_account_id,
       t.checkout_id, t.meta -> 'items' AS items, t.tag_id, t.pass_id, t.idem AS idempotency_key,
       t.meta ->> 'provider_reference' AS provider_reference,
       t.created_at AS "timestamp",
       CASE WHEN t.status = 'completed' THEN t.created_at END AS completed_at,
       t.settlement_id, t.funding_id, t.account_id AS actor_account_id, t.meta
  FROM public.transactions t
  JOIN public.wallets fw ON fw.id = t.from_wallet_id
  JOIN public.wallets tw ON tw.id = t.to_wallet_id
UNION ALL
SELECT r.id, 'refund', CASE r.status WHEN 'pending' THEN 'pending' ELSE 'failed' END,
       CASE r.status WHEN 'pending' THEN 'awaiting_approval' ELSE 'rejected' END,
       r.merchant_account_id, pw.account_id, pay.to_wallet_id, pay.from_wallet_id,
       r.amount, 0::bigint, r.pay_transaction_id, r.terminal_id, r.reference,
       NULL::uuid, pay.checkout_id, r.items, NULL::uuid, NULL::uuid, r.idem,
       NULL::text, r.created_at, NULL::timestamptz, NULL::uuid, NULL::uuid, r.merchant_account_id, '{}'::jsonb
  FROM public.refunds r
  JOIN public.transactions pay ON pay.id = r.pay_transaction_id
  JOIN public.wallets pw ON pw.id = pay.from_wallet_id
 WHERE r.status IN ('pending', 'rejected');

-- What each completed transaction did to each account, for reconciliation (docs/SCHEME-V2.md, section 8): `delta` is the change to the
-- account's balance, `credit_delta` the change to its credit drawn, and `wdelta` the change to the wallet's own balance for the wallets
-- whose balance can be checked exactly (Benefits and escrow wallets). Declined rows and the system wallets have no effect. A balance
-- equals the sum of its effects; earmarks of ordinary wallets are checked only as a bound.
CREATE VIEW public.account_effects AS
SELECT t.id AS tx_id, t.created_at, fw.account_id, t.from_wallet_id AS wallet_id,
       CASE t.type WHEN 'send' THEN -t.amount WHEN 'pay' THEN -(t.amount - t.credit_amount) WHEN 'refund' THEN -t.amount
                   WHEN 'purchase' THEN -t.amount WHEN 'claim' THEN -t.amount WHEN 'settle' THEN -t.amount
                   WHEN 'fund_return' THEN -t.amount WHEN 'adjustment' THEN -t.amount ELSE 0 END AS delta,
       CASE t.type WHEN 'pay' THEN t.credit_amount ELSE 0 END AS credit_delta,
       CASE WHEN fw.type IN ('benefits', 'escrow') THEN
         CASE t.type WHEN 'pay' THEN -(t.amount - t.credit_amount) WHEN 'purchase' THEN -t.amount WHEN 'claim' THEN -t.amount
                     WHEN 'move' THEN -t.amount WHEN 'send' THEN -t.amount ELSE 0 END
       ELSE 0 END AS wdelta
  FROM public.transactions t JOIN public.wallets fw ON fw.id = t.from_wallet_id
 WHERE t.status = 'completed' AND fw.type <> 'system'
UNION ALL
SELECT t.id, t.created_at, tw.account_id, t.to_wallet_id,
       CASE t.type WHEN 'fund' THEN t.amount - t.credit_amount WHEN 'send' THEN t.amount WHEN 'pay' THEN t.amount
                   WHEN 'refund' THEN t.amount - t.credit_amount WHEN 'claim' THEN t.amount WHEN 'settle_return' THEN t.amount
                   WHEN 'collect' THEN t.amount WHEN 'adjustment' THEN t.amount ELSE 0 END,
       CASE t.type WHEN 'fund' THEN -t.credit_amount WHEN 'refund' THEN -t.credit_amount ELSE 0 END,
       CASE WHEN tw.type IN ('benefits', 'escrow') THEN
         CASE t.type WHEN 'send' THEN t.amount WHEN 'refund' THEN t.amount - t.credit_amount WHEN 'claim' THEN t.amount
                     WHEN 'allocate' THEN t.amount WHEN 'move' THEN t.amount ELSE 0 END
       ELSE 0 END
  FROM public.transactions t JOIN public.wallets tw ON tw.id = t.to_wallet_id
 WHERE t.status = 'completed' AND tw.type <> 'system';
