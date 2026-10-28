-- A routing number is not a bank. `banks` (0005) becomes `routing_numbers`: one row per 9-digit number with what the bank directory says about it
-- (name as the directory spells it, instant payments, networks). The institution people know (Chase, Wells Fargo) is its own table, `institutions`, with
-- the display name and the logo, uploaded once however many routing numbers the institution has. bank_accounts points at its routing number, and
-- the institution is one join further (routing_numbers.institution_id): the instant-payment facts belong to the routing number (FedNow registers each one).
CREATE TABLE public.institutions (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    icon text,
    domain text,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT institutions_pkey PRIMARY KEY (id),
    CONSTRAINT institutions_name_key UNIQUE (name),
    CONSTRAINT institutions_name_check CHECK (length(name) BETWEEN 1 AND 120),
    CONSTRAINT institutions_icon_key CHECK (icon IS NULL OR icon ~ '^institutions/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$'),
    CONSTRAINT institutions_domain_check CHECK (domain IS NULL OR domain ~ '^[a-z0-9.-]{3,100}$')
);
CREATE TRIGGER institutions_updated_at BEFORE UPDATE ON public.institutions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.banks RENAME TO routing_numbers;
ALTER TABLE public.routing_numbers RENAME COLUMN name TO directory_name;
ALTER TABLE public.routing_numbers DROP CONSTRAINT banks_icon_key;
ALTER TABLE public.routing_numbers DROP COLUMN icon;
ALTER TABLE public.routing_numbers ADD COLUMN institution_id uuid;
ALTER TABLE public.routing_numbers ADD CONSTRAINT routing_numbers_institution_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE SET NULL;
CREATE INDEX routing_numbers_institution_idx ON public.routing_numbers USING btree (institution_id) WHERE institution_id IS NOT NULL;
ALTER TABLE public.routing_numbers RENAME CONSTRAINT banks_pkey TO routing_numbers_pkey;
ALTER TABLE public.routing_numbers RENAME CONSTRAINT banks_routing_key TO routing_numbers_routing_key;
ALTER TABLE public.routing_numbers RENAME CONSTRAINT banks_routing_format TO routing_numbers_routing_format;
ALTER TABLE public.routing_numbers RENAME CONSTRAINT banks_name_check TO routing_numbers_directory_name_check;
ALTER TABLE public.routing_numbers RENAME CONSTRAINT banks_networks_check TO routing_numbers_networks_check;
ALTER INDEX public.banks_refresh_idx RENAME TO routing_numbers_refresh_idx;
ALTER TRIGGER banks_updated_at ON public.routing_numbers RENAME TO routing_numbers_updated_at;

ALTER TABLE public.bank_accounts RENAME COLUMN bank_id TO routing_number_id;
ALTER TABLE public.bank_accounts RENAME CONSTRAINT bank_accounts_bank_fkey TO bank_accounts_routing_number_fkey;
ALTER INDEX public.bank_accounts_bank_idx RENAME TO bank_accounts_routing_number_idx;
