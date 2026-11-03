/**
 * Canonical public identity shared by packaging, setup, MCP, and skill install.
 * Centralization prevents persistent client registrations from drifting from
 * the npm package or executable exposed in package.json.
 */
export const PRODUCT_IDENTITY = {
  displayName: "XTNA",
  packageName: PACKAGE_METADATA.name,
  packageSpecifier: `${PACKAGE_METADATA.name}@latest`,
  registrationPackageSpecifier: `${PACKAGE_METADATA.name}@${PACKAGE_METADATA.version}`,
  packageVersion: PACKAGE_METADATA.version,
  cliBinary: "xtna",
  mcpCommand: `npx -y ${PACKAGE_METADATA.name}@${PACKAGE_METADATA.version} mcp`,
  mcpServerKey: "xtna",
  skillName: "reverse-engineer-anything",
  skillVersion: PACKAGE_METADATA.skillVersion,
  configFileName: "xtna.json",
} as const;

/**
 * The registration key this product used before the identity rename. Installs
 * created by that release keep their registration under this name, so a read
 * that resolves a registration must fall back to it.
 */
export const LEGACY_MCP_SERVER_KEY = "rea";

/**
 * The executable name releases before the rename installed. A registration created by one of
 * those releases still launches `rea`, so ownership must recognise it: without this the product
 * calls its own inherited install `unknown` and refuses to remove it, which is how an uninstall
 * can leave a registration behind while reporting that it was retained.
 *
 * Alignment is decided separately by the launcher check, so recognising the name here cannot make
 * an inherited install look healthy.
 */
export const LEGACY_CLI_BINARY = "rea";

/**
 * The npm package name releases before the rename published. A registration created by one of
 * those releases pins `rea-agents@<version>`, so ownership must recognise the package the same way
 * it recognises the executable — otherwise the product calls its own inherited install foreign and
 * refuses to migrate or remove it.
 */
export const LEGACY_PACKAGE_NAME = "rea-agents";

/** Exact SDK package identities, distinct from negotiated protocol version. */
export const SDK_IDENTITY = {
  server: PACKAGE_METADATA.serverSdkVersion,
  client_test: PACKAGE_METADATA.clientSdkVersion,
  core: PACKAGE_METADATA.coreSdkVersion,
} as const;
import { PACKAGE_METADATA } from "./generatedPackageMetadata.js";
