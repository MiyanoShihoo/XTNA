import { describe, expect, it } from "vitest";

import { normalizeJavaScriptAst } from "./AstNormalization.js";

const normalize = (source: string) => normalizeJavaScriptAst(source).text;

describe("constant folding", () => {
  it("folds negation of numeric literals into booleans", () => {
    expect(normalize("const a = !0; const b = !1;")).toBe(
      "const a = true; const b = false;",
    );
  });

  it("folds string concatenation", () => {
    expect(normalize('const a = "ab" + "cd";')).toBe('const a = "abcd";');
  });

  it("folds numeric arithmetic", () => {
    expect(normalize("const t = 60 * 1000;")).toBe("const t = 60000;");
    expect(normalize("const t = 2 ** 10;")).toBe("const t = 1024;");
  });

  it("folds comparisons between literals", () => {
    expect(normalize("const a = 1 < 2;")).toBe("const a = true;");
  });

  it("keeps expressions that contain identifiers or calls", () => {
    expect(normalize('const a = foo() + "x";')).toBe('const a = foo() + "x";');
    expect(normalize("const a = x + 1;")).toBe("const a = x + 1;");
  });
});

describe("literal branches", () => {
  it("collapses an if with a false literal test", () => {
    expect(normalize("if (false) { a(); } else { b(); }")).toBe("{ b(); }");
  });

  it("removes an if whose literal test has no alternate", () => {
    expect(normalize("if (true) { a(); }")).toBe("{ a(); }");
    expect(normalize("if (false) { a(); }")).toBe("");
  });

  it("resolves a conditional expression with a literal test", () => {
    expect(normalize("const v = true ? 1 : 2;")).toBe("const v = 1;");
    expect(normalize("const v = false ? 1 : 2;")).toBe("const v = 2;");
  });

  it("applies short-circuit rules without evaluating the right operand", () => {
    expect(normalize("const v = false && sideEffect();")).toBe(
      "const v = false;",
    );
    expect(normalize("const v = true || sideEffect();")).toBe(
      "const v = true;",
    );
    expect(normalize("const v = 0 || next();")).toBe("const v = next();");
  });
});

describe("string decoding", () => {
  it("rewrites escaped literals to their decoded form", () => {
    expect(normalize('const a = "\\x41\\x42";')).toBe('const a = "AB";');
    expect(normalize('const a = "\\u4f60\\u597d";')).toBe('const a = "你好";');
  });

  it("leaves plain literals byte-identical", () => {
    expect(normalize('const a = "plain";')).toBe('const a = "plain";');
  });
});

describe("safety", () => {
  it("does not touch code it cannot prove literal", () => {
    const source = "function f(x) { return x ? g() : h(); }";
    expect(normalize(source)).toBe(source);
  });

  it("preserves formatting outside rewritten ranges", () => {
    const source = "const a  =  1 + 1;\n\nfunction f() {\n  return 0;\n}\n";
    expect(normalize(source)).toBe(
      "const a  =  2;\n\nfunction f() {\n  return 0;\n}\n",
    );
  });

  it("reports what it changed", () => {
    const result = normalizeJavaScriptAst(
      'if (false) { a(); } else { b(); }\nconst v = !0;\nconst s = "\\x41";',
    );
    expect(result.stats.removedBranches).toBeGreaterThan(0);
    expect(result.stats.foldedConstants).toBeGreaterThan(0);
    expect(result.stats.decodedStrings).toBeGreaterThan(0);
    expect(result.stats.passes).toBeGreaterThan(0);
  });
});
