CREATE TABLE "drive_changes" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drive_changes_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"txid" bigint NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"prev_space_id" uuid,
	"node_id" uuid,
	"node_type" text,
	"user_id" uuid,
	"kind" text NOT NULL,
	"path" text,
	"prev_path" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "drive_changes_org_position_idx" ON "drive_changes" USING btree ("org_id","txid","seq");--> statement-breakpoint
CREATE INDEX "drive_changes_at_idx" ON "drive_changes" USING btree ("at");
--> statement-breakpoint
CREATE FUNCTION drive_changes_add(p_org uuid, p_space uuid, p_prev_space uuid, p_node uuid, p_type text, p_user uuid, p_kind text, p_path text, p_prev text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO drive_changes (txid, org_id, space_id, prev_space_id, node_id, node_type, user_id, kind, path, prev_path)
  VALUES (pg_current_xact_id()::text::bigint, p_org, p_space, p_prev_space, p_node, p_type, p_user, p_kind, p_path, p_prev);
$$;
--> statement-breakpoint
-- Does the path say the same parent as parent_id? Moves take two updates, in either order (path
-- then parent, or parent then path); between them this is false.
CREATE FUNCTION drive_changes_path_ok(p_path ltree, p_parent uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_parent IS NULL THEN nlevel(p_path) = 1
    ELSE nlevel(p_path) >= 2 AND ltree2text(subpath(p_path, nlevel(p_path) - 2, 1)) = replace(p_parent::text, '-', '') END;
$$;
--> statement-breakpoint
CREATE FUNCTION drive_changes_node_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM drive_changes_add(NEW.org_id, NEW.space_id, NULL, NEW.id, NEW.type::text, NULL, 'created', NEW.path::text, NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION drive_changes_node_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
    RETURN NULL;
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM drive_changes_add(NEW.org_id, NEW.space_id, NULL, NEW.id, NEW.type::text, NULL, 'trashed', NEW.path::text, NULL);
    RETURN NULL;
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    PERFORM drive_changes_add(NEW.org_id, NEW.space_id, NULL, NEW.id, NEW.type::text, NULL, 'created', NEW.path::text, NULL);
    RETURN NULL;
  END IF;
  -- The second update of a two-step move: the first one logged it with the old place.
  IF NOT drive_changes_path_ok(OLD.path, OLD.parent_id) AND drive_changes_path_ok(NEW.path, NEW.parent_id) THEN
    RETURN NULL;
  END IF;
  IF NEW.space_id <> OLD.space_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR (drive_changes_path_ok(OLD.path, OLD.parent_id) AND NOT drive_changes_path_ok(NEW.path, NEW.parent_id)) THEN
    PERFORM drive_changes_add(NEW.org_id, NEW.space_id, OLD.space_id, NEW.id, NEW.type::text, NULL, 'moved', NEW.path::text, OLD.path::text);
  ELSIF NEW.name <> OLD.name OR NEW.type <> OLD.type OR NEW.mime IS DISTINCT FROM OLD.mime
     OR NEW.size_bytes <> OLD.size_bytes OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    PERFORM drive_changes_add(NEW.org_id, NEW.space_id, NULL, NEW.id, NEW.type::text, NULL, 'updated', NEW.path::text, NULL);
  END IF;
  -- Only the path changed: a descendant of a moved folder, whose place in its parent is the same.
  RETURN NULL;
END $$;
--> statement-breakpoint
-- BEFORE: the path is still there, and so are the shares a purge is about to take with it.
CREATE FUNCTION drive_changes_node_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM drive_changes_add(OLD.org_id, OLD.space_id, NULL, OLD.id, OLD.type::text, NULL, 'purged', OLD.path::text, NULL);
  PERFORM drive_changes_add(OLD.org_id, OLD.space_id, NULL, OLD.id, OLD.type::text, s.grantee_user_id, 'access_lost', OLD.path::text, NULL)
    FROM shares s WHERE s.node_id = OLD.id AND s.kind = 'user' AND s.grantee_user_id IS NOT NULL;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE FUNCTION drive_changes_share() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r shares;
  n nodes;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF r.kind <> 'user' OR r.grantee_user_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO n FROM nodes WHERE id = r.node_id;
  -- A purge: the node's own trigger logged the loss.
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM drive_changes_add(r.org_id, n.space_id, NULL, n.id, n.type::text, r.grantee_user_id,
    CASE TG_OP WHEN 'INSERT' THEN 'access_granted' WHEN 'DELETE' THEN 'access_lost' ELSE 'access_changed' END,
    n.path::text, NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION drive_changes_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r space_members;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM drive_changes_add(r.org_id, r.space_id, NULL, NULL, NULL, r.user_id,
    CASE TG_OP WHEN 'INSERT' THEN 'access_granted' WHEN 'DELETE' THEN 'access_lost' ELSE 'access_changed' END,
    NULL, NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION drive_changes_space() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM drive_changes_add(NEW.org_id, NEW.id, NULL, NULL, NULL, NULL,
    CASE WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'space_removed'
         WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'space_restored'
         ELSE 'space_updated' END,
    NULL, NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER drive_changes_node_insert AFTER INSERT ON nodes FOR EACH ROW WHEN (NEW.deleted_at IS NULL) EXECUTE FUNCTION drive_changes_node_insert();
--> statement-breakpoint
-- The paths compare as text: pg_dump prints this condition under an empty search_path, where the
-- = of ltree (an extension in public) cannot be found and pg_restore would stop here.
CREATE TRIGGER drive_changes_node_update AFTER UPDATE ON nodes FOR EACH ROW
  WHEN (OLD.path::text IS DISTINCT FROM NEW.path::text OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.space_id IS DISTINCT FROM NEW.space_id
    OR OLD.name IS DISTINCT FROM NEW.name OR OLD.type IS DISTINCT FROM NEW.type OR OLD.mime IS DISTINCT FROM NEW.mime
    OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes OR OLD.current_version_id IS DISTINCT FROM NEW.current_version_id
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION drive_changes_node_update();
--> statement-breakpoint
CREATE TRIGGER drive_changes_node_delete BEFORE DELETE ON nodes FOR EACH ROW EXECUTE FUNCTION drive_changes_node_delete();
--> statement-breakpoint
CREATE TRIGGER drive_changes_share AFTER INSERT OR DELETE ON shares FOR EACH ROW EXECUTE FUNCTION drive_changes_share();
--> statement-breakpoint
CREATE TRIGGER drive_changes_share_update AFTER UPDATE ON shares FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.expires_at IS DISTINCT FROM NEW.expires_at)
  EXECUTE FUNCTION drive_changes_share();
--> statement-breakpoint
CREATE TRIGGER drive_changes_member AFTER INSERT OR DELETE ON space_members FOR EACH ROW EXECUTE FUNCTION drive_changes_member();
--> statement-breakpoint
CREATE TRIGGER drive_changes_member_update AFTER UPDATE ON space_members FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION drive_changes_member();
--> statement-breakpoint
CREATE TRIGGER drive_changes_space AFTER UPDATE ON spaces FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.slug IS DISTINCT FROM NEW.slug OR OLD.color IS DISTINCT FROM NEW.color
    OR OLD.archived_at IS DISTINCT FROM NEW.archived_at OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION drive_changes_space();
