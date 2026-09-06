const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

/*
 * Metro defaults to the project folder and would never see the workspace.
 * Watching the repo root is what makes edits in packages/* trigger a reload
 * instead of silently serving a stale bundle.
 */
config.watchFolders = [workspaceRoot];

/*
 * Bun's hoisted linker puts most dependencies at the repo root and only the
 * conflicting ones in the app. Both directories have to be searched, in this
 * order, or Metro resolves nothing outside apps/native.
 */
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

/*
 * Without this, Metro also walks every parent directory looking for
 * node_modules and can pick up a second copy of React from a different level.
 * Two Reacts in one bundle is the "Invalid hook call" crash -- the paths above
 * are exhaustive, so hierarchical lookup only adds ways to get it wrong.
 */
config.resolver.disableHierarchicalLookup = true;

/*
 * Workspace packages export raw TypeScript (`./src/*.ts`) through the
 * `exports` field. Metro ignores `exports` unless told otherwise, and would
 * fall back to `main` -- which these packages do not have.
 */
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
