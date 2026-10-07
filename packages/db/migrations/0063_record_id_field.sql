-- Record ID field type (Airtable-style rec_… identifier on each row).

CREATE OR REPLACE FUNCTION data.is_field_type(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t IN ('text','long_text','number','currency','percent','date','datetime','duration','checkbox',
               'single_select','multi_select','email','phone','url','rating','collaborator','attachment','barcode',
               'link','contact','formula','lookup','rollup','count','autonumber','created_time','modified_time',
               'created_by','modified_by','button','ai_generated','json','record_id')
$$;

-- Encode a uuid as `<prefix>_<22 base62 chars>` (same alphabet as @tabula/types).
CREATE OR REPLACE FUNCTION data.encode_public_id(prefix text, id uuid)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  b bytea := uuid_send(id);
  n numeric := 0;
  i int;
  out text := '';
  rem int;
BEGIN
  FOR i IN 0..15 LOOP
    n := n * 256 + get_byte(b, i);
  END LOOP;
  IF n = 0 THEN
    out := repeat('0', 22);
  ELSE
    WHILE n > 0 LOOP
      rem := (n % 62)::int;
      out := substr(alphabet, rem + 1, 1) || out;
      n := trunc(n / 62);
    END LOOP;
    out := lpad(out, 22, '0');
  END IF;
  RETURN prefix || '_' || out;
END;
$$;
