import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bundle,
  cleanupExport,
  type ExportResult,
  exportOnce,
  metadata,
  SENTINEL,
} from "./helpers";

/**
 * The bundle Metro produces, read.
 *
 * This is the artefact a device actually loads, and until now nothing in the
 * repository had produced one. Every claim in `metro.config.js` about
 * workspace resolution, and every claim in `.env.example` about what Metro
 * inlines, is settled here or nowhere.
 */

let result: ExportResult;
let js: string;

/*
 * One export for the file, and one cleanup after ALL of it. Tearing the
 * directory down inside the first `describe` takes it away from the second,
 * which then fails on a missing bundle rather than on anything it asserts.
 */
beforeAll(async () => {
  result = await exportOnce();
  js = bundle(result);
}, 600_000);

afterAll(() => {
  cleanupExport();
});

describe("the exported iOS bundle", () => {
  it("exports successfully", () => {
    expect(result.exitCode).toBe(0);
  });

  it("emits one bundle, and declares it in the manifest", () => {
    /*
     * `metadata.json` is what an OTA update server reads to decide which file
     * to hand a client. A bundle on disk that the manifest does not name is
     * one that never ships.
     */
    const manifest = metadata(result);

    expect(manifest.bundler).toBe("metro");
    expect(manifest.fileMetadata.ios?.bundle).toMatch(
      /^_expo\/static\/js\/ios\/entry-[0-9a-f]+\.js$/,
    );
    expect(js.length).toBeGreaterThan(1_000_000);
  });

  it("inlines EXPO_PUBLIC_API_URL as a literal", () => {
    /*
     * Metro replaces `process.env.EXPO_PUBLIC_*` by static analysis at build
     * time -- there is no environment to read on a phone. Two things follow,
     * and both are in `.env.example` as prose and nowhere as a check: the
     * value is compiled into the binary, and it is therefore public.
     *
     * It also proves `runtimeEnv` in `@repo/env/native` lists its keys
     * literally. A spread of `process.env` there survives type-checking and
     * comes back empty in a release build.
     */
    expect(js).toContain(SENTINEL.apiUrl);
  });

  it("carries no server-side value at all", () => {
    /*
     * `apps/native` depends on `@repo/auth`, so `@repo/env/server` is one
     * import away, and a bundle is not a place a secret can be taken back
     * from -- it ships inside the binary on every device.
     *
     * Both sentinels were in the environment during the export, so their
     * absence is evidence rather than a vacuous pass.
     */
    expect(js).not.toContain(SENTINEL.secret);
    expect(js).not.toContain(SENTINEL.databaseUrl);
  });

  it("pulls in none of the server's Node-only dependencies", () => {
    // The other half of the same boundary: reaching `@repo/auth/server`
    // instead of `@repo/auth/client` drags argon2's native addon and the
    // Postgres driver into a React Native bundle, where neither can load.
    for (const marker of ["argon2", "drizzle-orm", "pg-connection-string"]) {
      expect(js, `${marker} must not be bundled`).not.toContain(marker);
    }
  });
});

describe("what the bundle proves about the app", () => {
  it("resolves the workspace packages through their exports field", () => {
    /*
     * `unstable_enablePackageExports` in `metro.config.js`, and it is
     * load-bearing: setting it to false fails the export outright with
     * "Unable to resolve module @repo/env/native" -- measured. Metro ignores
     * `exports` by default and falls back to `main`, which these packages do
     * not have.
     *
     * The inlined URL is the evidence: it can only be there if
     * `@repo/env/native` resolved and ran.
     */
    expect(js).toContain(SENTINEL.apiUrl);
    expect(js).toContain("EXPO_PUBLIC_API_URL");
  });

  it("keeps the session in SecureStore and nowhere softer", () => {
    /*
     * The decision in `lib/auth-client.ts`. SecureStore is the Keychain on iOS
     * and EncryptedSharedPreferences on Android; AsyncStorage is a plaintext
     * file readable by anything with the device's filesystem. A session token
     * in the second one is a session anybody with the phone can take.
     */
    expect(js).toContain("SecureStore");
    expect(js).not.toContain("async-storage");
  });

  it("registers the username plugin the server expects", () => {
    // The server registers Better Auth's `username()`; a client without the
    // matching plugin has no `isUsernameAvailable` and the endpoints 404.
    expect(js).toContain("isUsernameAvailable");
  });

  it("bundles both routes of the router, not only the entry point", () => {
    // expo-router builds the navigator from the file tree, so a screen that
    // failed to bundle is a route that silently does not exist.
    expect(js).toContain("Not signed in");
    expect(js).toContain("This screen does not exist");
  });
});
