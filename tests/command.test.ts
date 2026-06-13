import { describe, expect, test } from "bun:test";
import { looksLikeShellTokenizationMistake } from "../src/entries/command";

describe("looksLikeShellTokenizationMistake", () => {
  test("returns true when command has space but no path separator", () => {
    expect(looksLikeShellTokenizationMistake("cctra serve")).toBe(true);
    expect(looksLikeShellTokenizationMistake("bun run app")).toBe(true);
    expect(looksLikeShellTokenizationMistake("a b c d")).toBe(true);
  });

  test("returns false when command has no space", () => {
    expect(looksLikeShellTokenizationMistake("cctra")).toBe(false);
    expect(looksLikeShellTokenizationMistake("node")).toBe(false);
    expect(looksLikeShellTokenizationMistake("/usr/local/bin/foo")).toBe(false);
    expect(looksLikeShellTokenizationMistake("C:\\Tools\\foo.exe")).toBe(false);
  });

  test("returns false for Windows path with spaces", () => {
    expect(looksLikeShellTokenizationMistake("C:\\Program Files\\My App\\app.exe")).toBe(false);
    expect(looksLikeShellTokenizationMistake("C:\\Program Files (x86)\\app.exe")).toBe(false);
  });

  test("returns false for Unix path with spaces", () => {
    expect(looksLikeShellTokenizationMistake("/Applications/My App.app/Contents/MacOS/app")).toBe(
      false
    );
    expect(looksLikeShellTokenizationMistake("/usr/local/My Tools/run.sh")).toBe(false);
  });

  test("returns false for WSL / cross-platform path with spaces", () => {
    expect(looksLikeShellTokenizationMistake("/mnt/c/Program Files/foo.exe")).toBe(false);
  });
});
