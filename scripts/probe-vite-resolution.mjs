import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) throw new Error("usage: node probe-vite-resolution.mjs <dist-dir>");

const { resolveArtifactPathByContext } = await import(
  pathToFileURL(
    join(process.cwd(), "dist/application/javascript/JavaScriptArtifactPathResolution.js"),
  ).href
);
const { JavaScriptJsonDocuments } = await import(
  pathToFileURL(
    join(process.cwd(), "dist/application/javascript/JavaScriptJsonDocuments.js"),
  ).href
);

const files = new Map();
const directories = new Set([""]);
// One container identity for the whole distribution, as a real inventory has.
const container = createHash("sha256").update(root).digest("hex");

const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const path = relative(root, absolute).split("\\").join("/");
    if (entry.isDirectory()) {
      directories.add(path);
      await walk(absolute);
      continue;
    }
    const bytes = await readFile(absolute);
    const extension = posix.extname(path).toLowerCase();
    const kind =
      path === "package.json"
        ? "package-json"
        : extension === ".json"
          ? "json"
          : extension === ".html"
            ? "html"
            : [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(extension)
              ? "javascript"
              : ".map" === extension
                ? "source-map"
                : "json";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    files.set(path, {
      path,
      container_sha256: container,
      sha256,
      bytes: (await stat(absolute)).size,
      inventory_artifact_id: `art_${sha256}`,
      kind,
      unpacked: false,
      text: { included: true, value: bytes.toString("utf8") },
    });
  }
};

await walk(root);

const jsonDocuments = new JavaScriptJsonDocuments();
const resolve = (declaredPath, sourcePath, context = "module-specifier") =>
  resolveArtifactPathByContext({
    jsonDocuments,
    declaredPath,
    sourcePath,
    context,
    files,
    directoryPaths: directories,
    moduleKind: "import",
  });

const entry = [...files.keys()].find((path) => /assets\/index-.*\.js$/u.test(path));
const chunk = [...files.keys()].find((path) => /assets\/lazy-.*\.js$/u.test(path));
if (!entry || !chunk) throw new Error("fixture is missing Vite chunks");
const chunkName = chunk.split("/").pop();

const cases = [
  ["relative sibling (Vite default)", `./${chunkName}`, entry],
  ["root-absolute (Vite base=/ or /assets/)", `/${chunk}`, entry],
  ["extensionless relative", `./${chunkName.replace(/\.js$/u, "")}`, entry],
  ["html reference to entry", `/${entry}`, "index.html", "html-reference"],
];

for (const [label, declaredPath, sourcePath, context] of cases) {
  const result = resolve(declaredPath, sourcePath, context);
  console.log(
    `${result.resolution_status === "resolved" ? "ok  " : "MISS"} ${label}\n     declared=${declaredPath} from=${sourcePath} -> ${result.resolution_status} ${result.resolved_path ?? ""} ${result.limitations.join(" | ")}`,
  );
}
