import { describe, expect, test } from "bun:test";
import { slugify, validateSlug } from "../src/entries/name";

describe("slugify", () => {
  test("basic: bunx cctra → bunx-cctra", () => {
    expect(slugify("bunx", "cctra")).toBe("bunx-cctra");
  });

  test("multi-arg: bun run foo.js → bun-run-foo-js", () => {
    expect(slugify("bun", "run", "foo.js")).toBe("bun-run-foo-js");
  });

  test("dots: APIKEY.FUN → apikey-fun", () => {
    expect(slugify("APIKEY.FUN")).toBe("apikey-fun");
  });

  test("multiple spaces collapse to single dash", () => {
    expect(slugify("foo  bar")).toBe("foo-bar");
  });

  test("leading/trailing slashes trimmed", () => {
    expect(slugify("///foo///")).toBe("foo");
  });

  test("leading/trailing dashes trimmed", () => {
    expect(slugify("-foo-")).toBe("foo");
  });

  test("single char", () => {
    expect(slugify("a")).toBe("a");
  });

  test("empty input", () => {
    expect(slugify("")).toBe("");
  });

  test("chinese: 中文 命令 → empty (warn user to use --name)", () => {
    expect(slugify("中文 命令")).toBe("");
  });

  test("mixed: Agentplan → agentplan", () => {
    expect(slugify("Agentplan")).toBe("agentplan");
  });

  test("parens collapse: My Program (v2) → my-program-v2", () => {
    expect(slugify("My Program (v2)")).toBe("my-program-v2");
  });

  test("underscore treated as separator: foo_bar.baz → foo-bar-baz", () => {
    expect(slugify("foo_bar.baz")).toBe("foo-bar-baz");
  });

  test("consecutive non-alphanum collapse", () => {
    expect(slugify("a...b")).toBe("a-b");
  });
});

describe("validateSlug", () => {
  test("accepts simple", () => {
    expect(validateSlug("foo")).toBe(true);
  });
  test("accepts with dash", () => {
    expect(validateSlug("foo-bar")).toBe(true);
  });
  test("accepts alphanumeric with dash", () => {
    expect(validateSlug("foo-1")).toBe(true);
  });
  test("rejects uppercase", () => {
    expect(validateSlug("Foo")).toBe(false);
  });
  test("rejects leading dash", () => {
    expect(validateSlug("-foo")).toBe(false);
  });
  test("rejects trailing dash", () => {
    expect(validateSlug("foo-")).toBe(false);
  });
  test("rejects double dash", () => {
    expect(validateSlug("foo--bar")).toBe(false);
  });
  test("rejects empty", () => {
    expect(validateSlug("")).toBe(false);
  });
  test("rejects space", () => {
    expect(validateSlug("foo bar")).toBe(false);
  });
});
