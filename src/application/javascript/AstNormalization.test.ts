import { describe, expect, it } from "vitest";

import { normalizeJavaScriptAst } from "./AstNormalization.js";

const normalize = (source: string) => {
  const result = normalizeJavaScriptAst(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const transformed = (source: string) => normalize(source).transformed;

describe("AST normalization", () => {
  it("folds only literal expressions", () => {
    expect(
      transformed("const a = !0; const t = 60 * 1000; const s = 'a' + 'b';"),
    ).toBe('const a = true; const t = 60000; const s = "ab";');
    const dynamic = "const a = foo() + 'x'; const b = x * 2;";
    expect(transformed(dynamic)).toBe(dynamic);
  });

  it("removes unreachable branches without evaluating calls", () => {
    expect(transformed("if (false) { a(); } else { b(); }")).toBe("{ b(); }");
    expect(transformed("if (true) { a(); }")).toBe("{ a(); }");
    expect(transformed("const x = false && sideEffect();")).toBe(
      "const x = false;",
    );
    expect(transformed("const x = 0 || next();")).toBe("const x = next();");
    expect(transformed("const x = null ?? next();")).toBe("const x = next();");
  });

  it("decodes escaped strings and preserves untouched ranges", () => {
    expect(transformed('const s = "\\x41\\u4f60";\nconst t  =  "plain";')).toBe(
      'const s = "A你";\nconst t  =  "plain";',
    );
  });

  it("returns source-located observations and accurate statistics", () => {
    const result = normalize(
      'if (false) { a(); } else { b(); }\nconst x = !0;\nconst s = "\\x41";',
    );
    expect(result.stats).toEqual({
      foldedConstants: 1,
      removedBranches: 1,
      decodedStrings: 1,
      passes: 1,
    });
    expect(result.observations).toHaveLength(3);
    expect(result.observations.map((entry) => entry.kind)).toEqual([
      "dead-branch-removed",
      "constant-folded",
      "string-decoded",
    ]);
    expect(result.coverage).toBe("complete");
    expect(result.unknowns).toEqual([]);
  });

  it("propagates immutable top-level literals without crossing shadows or TDZ", () => {
    expect(transformed("const t = 60; const ms = t * 1000;")).toBe(
      "const t = 60; const ms = 60000;",
    );
    expect(
      transformed("const FLAG = false; if (FLAG) { a(); } else { b(); }"),
    ).toBe("const FLAG = false; { b(); }");
    const shadowed =
      "const t = 60; function f(t) { return t * 2; } const x = t * 2;";
    expect(transformed(shadowed)).toBe(shadowed);
    const tdz = "const x = t; const t = 1;";
    expect(transformed(tdz)).toBe(tdz);
  });

  it("retains valid exponentiation after folding negative numbers", () => {
    expect(normalizeJavaScriptAst("const x = -1 ** 2;").ok).toBe(false);
    expect(normalize("const x = 0 - 1;").transformed).toBe("const x = -1;");
    expect(normalize("const x = (-1) ** 2;").transformed).toBe(
      "const x = (-1) ** 2;",
    );
    expect(normalize("const x = 1 - 2 - 3;").transformed).toBe("const x = -4;");
  });

  it("reaches a stable fixed point without adding parentheses", () => {
    const first = normalize("const x = 0 - 1; const y = (-1) ** 2;");
    const second = normalize(first.transformed);
    expect(second.transformed).toBe(first.transformed);
  });

  it("returns a typed parse error rather than silently returning source", () => {
    const result = normalizeJavaScriptAst("const = ;");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("parse_failed");
  });

  it("bounds source size, node count, output size, and option values", () => {
    expect(
      normalizeJavaScriptAst("const x = 1;", { maxSourceBytes: 1 }).ok,
    ).toBe(false);
    expect(normalizeJavaScriptAst("const x = 1;", { maxNodes: 1 }).ok).toBe(
      false,
    );
    expect(
      normalizeJavaScriptAst(
        "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';",
        {
          maxSourceBytes: 67,
          maxOutputBytes: 67,
        },
      ).ok,
    ).toBe(false);
    expect(normalizeJavaScriptAst("const x = 1;", { maxPasses: 0 }).ok).toBe(
      false,
    );
  });

  it("marks an unfinished fixed point as partial", () => {
    const result = normalize("const x = 1 + 2 + 3;");
    expect(result.coverage).toBe("complete");
    const limited = normalizeJavaScriptAst("const x = 1 + 2 + 3;", {
      maxPasses: 1,
    });
    if (!limited.ok) throw new Error(limited.error.message);
    expect(limited.value.coverage).toBe("partial");
    expect(limited.value.unknowns[0]?.code).toBe("pass-limit-reached");
  });

  it("bounds retained observations without dropping transformations", () => {
    const result = normalizeJavaScriptAst("const a = !0; const b = !1;", {
      maxObservations: 1,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.observations).toHaveLength(1);
    expect(result.value.unknowns).toEqual([
      expect.objectContaining({ code: "observations-truncated", omitted: 1 }),
    ]);
    expect(result.value.transformed).toBe("const a = true; const b = false;");
  });
});
