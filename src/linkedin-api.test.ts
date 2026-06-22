import { describe, it, expect } from "vitest";
import { toLittleText } from "./linkedin-api.js";

describe("toLittleText", () => {
  it("leaves plain text untouched", () => {
    expect(toLittleText("Hello world")).toBe("Hello world");
  });

  it("escapes reserved characters that would truncate the post", () => {
    expect(toLittleText("see (https://x.io) now")).toBe("see \\(https://x.io\\) now");
  });

  it("escapes the full reserved set", () => {
    expect(toLittleText("| { } @ [ ] ( ) < > * _ ~")).toBe(
      "\\| \\{ \\} \\@ \\[ \\] \\( \\) \\< \\> \\* \\_ \\~",
    );
  });

  it("escapes backslashes", () => {
    expect(toLittleText("a\\b")).toBe("a\\\\b");
  });

  it("keeps #hashtags as clickable elements (no escaping, no templates)", () => {
    expect(toLittleText("hello #World #Two")).toBe("hello #World #Two");
  });

  it("keeps a hashtag at the start of a line", () => {
    expect(toLittleText("x\n#Tag")).toBe("x\n#Tag");
  });

  it("escapes a mid-word # (not a hashtag)", () => {
    expect(toLittleText("C# rocks")).toBe("C\\# rocks");
  });
});
