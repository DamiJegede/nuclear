-- Banks (one row per routing number, shared by every merchant payout bank and, later, every linked consumer bank), and how a settlement was started and sent.
--   banks.instant: true = the bank receives instant payments (RTP or FedNow), false = it does not, NULL = not checked yet or the lookup failed.
--   banks.refreshed_at: when the directory was last read successfully. banks.icon: an R2 key like the other pictures (uploaded by an admin).
CREATE TABLE public.banks (
    id uuid DEFAULT uuidv7() NOT NULL,
    routing_number text NOT NULL,
    name text,
    icon text,
    instant boolean,
    networks text[] DEFAULT '{}'::text[] NOT NULL,
    refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT banks_pkey PRIMARY KEY (id),
    CONSTRAINT banks_routing_key UNIQUE (routing_number),
    CONSTRAINT banks_routing_format CHECK (routing_number ~ '^[0-9]{9}$'),
    CONSTRAINT banks_name_check CHECK (name IS NULL OR length(name) BETWEEN 1 AND 120),
    CONSTRAINT banks_icon_key CHECK (icon IS NULL OR icon ~ '^banks/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$'),
    CONSTRAINT banks_networks_check CHECK (networks <@ ARRAY['RTP', 'FedNow']::text[])
);
CREATE INDEX banks_refresh_idx ON public.banks USING btree (refreshed_at NULLS FIRST);
CREATE TRIGGER banks_updated_at BEFORE UPDATE ON public.banks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Every bank account points at its bank (NULL for the SANDBOX placeholder, which has no routing number).
ALTER TABLE public.bank_accounts ADD COLUMN bank_id uuid;
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_bank_fkey FOREIGN KEY (bank_id) REFERENCES public.banks(id) ON DELETE RESTRICT;
CREATE INDEX bank_accounts_bank_idx ON public.bank_accounts USING btree (bank_id) WHERE bank_id IS NOT NULL;
INSERT INTO public.banks (routing_number) SELECT DISTINCT routing_number FROM public.bank_accounts WHERE routing_number ~ '^[0-9]{9}$' ON CONFLICT (routing_number) DO NOTHING;
UPDATE public.bank_accounts a SET bank_id = b.id FROM public.banks b WHERE b.routing_number = a.routing_number AND a.bank_id IS NULL;

-- A settlement is started by the nightly job or by the merchant closing out, and goes by instant payment or ACH.
ALTER TABLE public.settlements ADD COLUMN source text DEFAULT 'nightly' NOT NULL;
ALTER TABLE public.settlements ADD COLUMN rail text DEFAULT 'ach' NOT NULL;
ALTER TABLE public.settlements ADD CONSTRAINT settlements_source_check CHECK (source IN ('nightly', 'close_out'));
ALTER TABLE public.settlements ADD CONSTRAINT settlements_rail_check CHECK (rail IN ('instant', 'ach'));
