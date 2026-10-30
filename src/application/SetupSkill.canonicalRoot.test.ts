import { describe, expect, it } from "vitest";

import {
  canonicalSkillRootKind,
  selectCanonicalSkillRoot,
} from "./SetupSkill.js";

describe("canonical skill root", () => {
  it("prefers the authored source tree when it exists", () => {
    expect(selectCanonicalSkillRoot(true)).toBe("source");
    expect(selectCanonicalSkillRoot(false)).toBe("packaged");
  });

  it("resolves to the source tree in this checkout", () => {
    // The repository keeps the authored skill in .agents/skills and treats
    // skills/ as a generated output, so a checkout must read the source.
    expect(canonicalSkillRootKind()).toBe("source");
  });
});
