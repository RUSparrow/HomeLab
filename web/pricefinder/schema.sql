-- Схема базы PriceFinder (PostgreSQL на хосте, база pricewatcher).
-- Восстановление: sudo -u postgres psql -d pricewatcher -f schema.sql
\restrict qmnKtF3aefV5OM3NraYqKhghuw3PXLkn4zBqKVBwD9KJRJgabHdNGw3lYY4C5Rh
CREATE TABLE public.offers (
    id integer NOT NULL,
    product_id integer NOT NULL,
    store text NOT NULL,
    title text NOT NULL,
    price numeric(12,2),
    currency character varying(3),
    in_stock boolean,
    url text NOT NULL,
    last_seen timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    price_source text,
    price_eur numeric(12,2)
);
CREATE SEQUENCE public.offers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.offers_id_seq OWNED BY public.offers.id;
CREATE TABLE public.products (
    id integer NOT NULL,
    name text NOT NULL,
    search_query text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;
ALTER TABLE ONLY public.offers ALTER COLUMN id SET DEFAULT nextval('public.offers_id_seq'::regclass);
ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);
ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX offers_unique_product_store_url ON public.offers USING btree (product_id, store, url);
ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
\unrestrict qmnKtF3aefV5OM3NraYqKhghuw3PXLkn4zBqKVBwD9KJRJgabHdNGw3lYY4C5Rh
