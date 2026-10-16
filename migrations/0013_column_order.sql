-- Column order: wallets, transactions, orbs and admins get their columns in the documented order
-- (docs/TABLES.md). Earlier migrations added columns at the end of these tables, and Postgres cannot
-- move a column, so each table is rebuilt: its rows are saved, the table dropped and recreated with
-- the same constraints, indexes and triggers, the rows restored, and every foreign key put back
-- (including those from other tables). Generated from the live schema; no behavior changes.
BEGIN;

CREATE TEMP TABLE _save_wallets AS SELECT * FROM public.wallets;
CREATE TEMP TABLE _save_transactions AS SELECT * FROM public.transactions;
CREATE TEMP TABLE _save_orbs AS SELECT * FROM public.orbs;
CREATE TEMP TABLE _save_admins AS SELECT * FROM public.admins;

DROP TABLE public.wallets CASCADE;
DROP TABLE public.transactions CASCADE;
DROP TABLE public.orbs CASCADE;
DROP TABLE public.admins CASCADE;

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
    CONSTRAINT wallets_balance_check CHECK (((balance IS NULL) OR (balance >= 0))),
    CONSTRAINT wallets_daily_limit_check CHECK ((daily_limit >= 0)),
    CONSTRAINT wallets_key_agent_only CHECK (((key_hash IS NULL) OR (type = 'agent'::text))),
    CONSTRAINT wallets_key_consistent CHECK (((key_hash IS NULL) = (key_hint IS NULL))),
    CONSTRAINT wallets_spent_today_check CHECK ((spent_today >= 0)),
    CONSTRAINT wallets_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'closed'::text]))),
    CONSTRAINT wallets_type_check CHECK ((type = ANY (ARRAY['default'::text, 'agent'::text, 'person'::text])))
);

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
    ELSE true
END),
    CONSTRAINT transactions_items_refund_only CHECK (((items IS NULL) OR ((type = 'refund'::text) AND (jsonb_typeof(items) = 'array'::text)))),
    CONSTRAINT transactions_reference_pay_only CHECK (((reference IS NULL) OR ((type = 'pay'::text) AND ((length(reference) >= 1) AND (length(reference) <= 64))))),
    CONSTRAINT transactions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'returned'::text]))),
    CONSTRAINT transactions_terminal_scope CHECK (((terminal_id IS NULL) OR (type = ANY (ARRAY['pay'::text, 'refund'::text])))),
    CONSTRAINT transactions_type_check CHECK ((type = ANY (ARRAY['fund'::text, 'send'::text, 'pay'::text, 'settle'::text, 'refund'::text, 'adjustment'::text, 'purchase'::text])))
);

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
    CONSTRAINT admins_access_id_check CHECK ((access_id ~ '^[A-Z0-9][A-Z0-9._-]{2,31}$'::text)),
    CONSTRAINT admins_failed_attempts_check CHECK ((failed_attempts >= 0)),
    CONSTRAINT admins_mfa_recovery_check CHECK ((jsonb_typeof(mfa_recovery) = 'array'::text)),
    CONSTRAINT admins_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80))),
    CONSTRAINT admins_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

INSERT INTO public.wallets ("id", "account_id", "display_name", "photo", "type", "daily_limit", "spent_today", "allow_pay", "allow_send", "status", "balance", "key_hash", "key_hint", "key_last_used_at", "created_at", "updated_at") SELECT "id", "account_id", "display_name", "photo", "type", "daily_limit", "spent_today", "allow_pay", "allow_send", "status", "balance", "key_hash", "key_hint", "key_last_used_at", "created_at", "updated_at" FROM _save_wallets;
INSERT INTO public.transactions ("id", "type", "from_account_id", "to_account_id", "from_wallet_id", "to_wallet_id", "from_bank_account_id", "to_bank_account_id", "amount", "related_transaction_id", "terminal_id", "reference", "approved_by_account_id", "checkout_id", "items", "tag_id", "pass_id", "status", "status_code", "idempotency_key", "provider_reference", "timestamp", "completed_at") SELECT "id", "type", "from_account_id", "to_account_id", "from_wallet_id", "to_wallet_id", "from_bank_account_id", "to_bank_account_id", "amount", "related_transaction_id", "terminal_id", "reference", "approved_by_account_id", "checkout_id", "items", "tag_id", "pass_id", "status", "status_code", "idempotency_key", "provider_reference", "timestamp", "completed_at" FROM _save_transactions;
INSERT INTO public.orbs ("id", "uid", "model", "software", "account_id", "terminal_id", "created_at", "updated_at") SELECT "id", "uid", "model", "software", "account_id", "terminal_id", "created_at", "updated_at" FROM _save_orbs;
INSERT INTO public.admins ("id", "access_id", "name", "access_token_hash", "status", "failed_attempts", "locked_until", "mfa_secret", "mfa_enabled_at", "mfa_last_step", "mfa_recovery", "last_login_at", "created_by", "created_at", "updated_at") SELECT "id", "access_id", "name", "access_token_hash", "status", "failed_attempts", "locked_until", "mfa_secret", "mfa_enabled_at", "mfa_last_step", "mfa_recovery", "last_login_at", "created_by", "created_at", "updated_at" FROM _save_admins;

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_access_id_key UNIQUE (access_id);
ALTER TABLE ONLY public.orbs
    ADD CONSTRAINT orbs_uid_key UNIQUE (uid);
ALTER TABLE ONLY public.orbs
    ADD CONSTRAINT orbs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_key_hash_key UNIQUE (key_hash);
ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_id_account_id_key UNIQUE (id, account_id);
CREATE INDEX wallets_account_id_idx ON public.wallets USING btree (account_id);
CREATE UNIQUE INDEX wallets_one_default_per_account ON public.wallets USING btree (account_id) WHERE (type = 'default'::text);
CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX transactions_checkout_idx ON public.transactions USING btree (checkout_id) WHERE (checkout_id IS NOT NULL);
CREATE UNIQUE INDEX transactions_checkout_paid_key ON public.transactions USING btree (checkout_id) WHERE ((type = 'pay'::text) AND (status = 'completed'::text));
CREATE INDEX transactions_from_account_idx ON public.transactions USING btree (from_account_id, "timestamp" DESC, id DESC);
CREATE INDEX transactions_from_wallet_idx ON public.transactions USING btree (from_wallet_id) WHERE (from_wallet_id IS NOT NULL);
CREATE UNIQUE INDEX transactions_idempotency_key ON public.transactions USING btree (type, from_account_id, idempotency_key) WHERE ((from_account_id IS NOT NULL) AND (type <> 'pay'::text));
CREATE INDEX transactions_pass_idx ON public.transactions USING btree (pass_id) WHERE (pass_id IS NOT NULL);
CREATE UNIQUE INDEX transactions_pay_idempotency_key ON public.transactions USING btree (to_account_id, idempotency_key) WHERE (type = 'pay'::text);
CREATE INDEX transactions_provider_ref_idx ON public.transactions USING btree (provider_reference) WHERE (provider_reference IS NOT NULL);
CREATE INDEX transactions_related_idx ON public.transactions USING btree (related_transaction_id) WHERE (related_transaction_id IS NOT NULL);
CREATE INDEX transactions_tag_idx ON public.transactions USING btree (tag_id) WHERE (tag_id IS NOT NULL);
CREATE INDEX transactions_terminal_idx ON public.transactions USING btree (terminal_id, "timestamp" DESC, id DESC) WHERE (terminal_id IS NOT NULL);
CREATE INDEX transactions_to_account_idx ON public.transactions USING btree (to_account_id, "timestamp" DESC, id DESC);
CREATE INDEX transactions_to_wallet_idx ON public.transactions USING btree (to_wallet_id) WHERE (to_wallet_id IS NOT NULL);
CREATE TRIGGER transactions_checkout_owner BEFORE INSERT OR UPDATE OF checkout_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.transactions_checkout_owner();
CREATE TRIGGER transactions_terminal_owner BEFORE INSERT OR UPDATE OF terminal_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.transactions_terminal_owner();
CREATE INDEX orbs_account_id_idx ON public.orbs USING btree (account_id) WHERE (account_id IS NOT NULL);
CREATE UNIQUE INDEX orbs_terminal_id_key ON public.orbs USING btree (terminal_id) WHERE (terminal_id IS NOT NULL);
CREATE TRIGGER orbs_business_only BEFORE INSERT OR UPDATE OF account_id ON public.orbs FOR EACH ROW EXECUTE FUNCTION public.require_business_account();
CREATE TRIGGER orbs_updated_at BEFORE UPDATE ON public.orbs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER admins_updated_at BEFORE UPDATE ON public.admins FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_approved_by_account_id_fkey FOREIGN KEY (approved_by_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_checkout_id_fkey FOREIGN KEY (checkout_id) REFERENCES public.checkouts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_from_account_id_fkey FOREIGN KEY (from_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_from_bank_account_id_from_account_id_fkey FOREIGN KEY (from_bank_account_id, from_account_id) REFERENCES public.bank_accounts(id, account_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_from_wallet_id_from_account_id_fkey FOREIGN KEY (from_wallet_id, from_account_id) REFERENCES public.wallets(id, account_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pass_id_fkey FOREIGN KEY (pass_id) REFERENCES public.passes(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_related_transaction_id_fkey FOREIGN KEY (related_transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_to_account_id_fkey FOREIGN KEY (to_account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_to_bank_account_id_to_account_id_fkey FOREIGN KEY (to_bank_account_id, to_account_id) REFERENCES public.bank_accounts(id, account_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_to_wallet_id_to_account_id_fkey FOREIGN KEY (to_wallet_id, to_account_id) REFERENCES public.wallets(id, account_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.orbs
    ADD CONSTRAINT orbs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.orbs
    ADD CONSTRAINT orbs_terminal_id_account_id_fkey FOREIGN KEY (terminal_id, account_id) REFERENCES public.terminals(id, account_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE RESTRICT;
ALTER TABLE ONLY admin_sessions ADD CONSTRAINT admin_sessions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE RESTRICT;
ALTER TABLE ONLY devices ADD CONSTRAINT devices_wallet_id_account_id_fkey FOREIGN KEY (wallet_id, account_id) REFERENCES wallets(id, account_id) ON DELETE RESTRICT;
ALTER TABLE ONLY fundings ADD CONSTRAINT fundings_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT;
ALTER TABLE ONLY ledger_entries ADD CONSTRAINT ledger_entries_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT;
ALTER TABLE ONLY passes ADD CONSTRAINT passes_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT;
ALTER TABLE ONLY tag_orders ADD CONSTRAINT tag_orders_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT;
ALTER TABLE ONLY tag_orders ADD CONSTRAINT tag_orders_wallet_id_account_id_fkey FOREIGN KEY (wallet_id, account_id) REFERENCES wallets(id, account_id) ON DELETE RESTRICT;
ALTER TABLE ONLY tags ADD CONSTRAINT tags_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT;
ALTER TABLE ONLY wallet_allocations ADD CONSTRAINT wallet_allocations_wallet_id_account_id_fkey FOREIGN KEY (wallet_id, account_id) REFERENCES wallets(id, account_id) ON DELETE RESTRICT;

COMMIT;
