import { FormatRegistry } from "@sinclair/typebox";

/**
 * Registers the string formats these schemas annotate.
 *
 * TypeBox 0.34 does not treat an unregistered `format` as a harmless
 * annotation -- it fails validation with "Unknown format". So a schema
 * carrying `format: "email"` rejects every value, valid ones included,
 * anywhere the name has not been registered.
 *
 * Elysia registers the common formats itself, so routes would have worked. But
 * this package is consumed outside Elysia too -- by tests, scripts, and
 * anything reading a row -- and a shared package cannot assume its host.
 *
 * `Has()` guards each one so Elysia's registrations (or an app's own) are
 * never clobbered: first registration wins.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set("email", (value) => EMAIL_PATTERN.test(value));
}

if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
}

/*
 * Emitted by drizzle-typebox for every `uuid` column. Without it registered,
 * TypeBox rejects every id -- including valid ones -- with "Unknown format".
 * Accepts any RFC 4122 version, not just v7: rows predating the switch, and
 * ids minted by anything else, are still legitimate.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (value) => UUID_PATTERN.test(value));
}
