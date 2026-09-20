import { describe, expect, it } from "vitest";
import { splitQuoted } from "../src/apps/gmail/quote";

describe("splitQuoted", () => {
  it("folds Gmail-style 'On ... wrote:' history", () => {
    const t = "Sounds good, see you then.\n\nOn Mon, Jan 1, 2026 at 10:00 AM Ada <ada@x.com> wrote:\n> Are we meeting?\n> Tuesday?";
    expect(splitQuoted(t)).toEqual({ main: "Sounds good, see you then.", quoted: "On Mon, Jan 1, 2026 at 10:00 AM Ada <ada@x.com> wrote:\n> Are we meeting?\n> Tuesday?" });
  });
  it("handles a wrapped 'wrote:' line", () => {
    const t = "Yes!\n\nOn Mon, Jan 1, 2026 at 10:00 AM Ada Lovelace <ada@example.com>\nwrote:\n> hi";
    expect(splitQuoted(t).main).toBe("Yes!");
  });
  it("folds a trailing '>' block and Original Message separators", () => {
    expect(splitQuoted("ok\n> old\n> older").main).toBe("ok");
    expect(splitQuoted("ok\n\n-----Original Message-----\nFrom: x").main).toBe("ok");
  });
  it("leaves normal messages alone and never hides the whole message", () => {
    expect(splitQuoted("just text\nmore text")).toEqual({ main: "just text\nmore text", quoted: "" });
    const allQuoted = "> everything is quoted\n> really";
    expect(splitQuoted(allQuoted)).toEqual({ main: allQuoted, quoted: "" });
  });
  it("does not fold a '>' line in the middle of the text", () => {
    const t = "a\n> note in the middle\nb";
    expect(splitQuoted(t).quoted).toBe("");
  });
});
