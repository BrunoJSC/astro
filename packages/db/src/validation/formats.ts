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
