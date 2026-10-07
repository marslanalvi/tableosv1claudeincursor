-- numeric `/` rounds for 128-bit values (result scale can be 0), so the 0063
-- encoder drifted from @tabula/types. div() is exact integer division.
CREATE OR REPLACE FUNCTION data.encode_public_id(prefix text, id uuid)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  b bytea := uuid_send(id);
  n numeric := 0;
  i int;
  out text := '';
BEGIN
  FOR i IN 0..15 LOOP
    n := n * 256 + get_byte(b, i);
  END LOOP;
  WHILE n > 0 LOOP
    out := substr(alphabet, (mod(n, 62))::int + 1, 1) || out;
    n := div(n, 62);
  END LOOP;
  RETURN prefix || '_' || lpad(out, 22, '0');
END;
$$;
