import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  formatLocalTime,
  formatLocalTimeWithSec,
  reformatSupervisorLogLine,
} from "../src/format";

/** 临时改 process.env.TZ；用 save/restore 避免影响别的 test（store.test.ts 等） */
let prevTz: string | undefined;

beforeEach(() => {
  prevTz = process.env.TZ;
});

afterEach(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

describe("formatLocalTime", () => {
  test("formats ISO UTC string in local timezone (TZ=Asia/Shanghai, UTC+8)", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(formatLocalTime("2026-06-26T16:30:00.000Z")).toBe("2026-06-27 00:30");
  });

  test("accepts Date object", () => {
    process.env.TZ = "Asia/Shanghai";
    const d = new Date("2026-06-26T16:30:00.000Z");
    expect(formatLocalTime(d)).toBe("2026-06-27 00:30");
  });

  test("accepts epoch number (ms)", () => {
    process.env.TZ = "Asia/Shanghai";
    const d = new Date("2026-06-26T16:30:00.000Z");
    expect(formatLocalTime(d.getTime())).toBe("2026-06-27 00:30");
  });

  test("withSec variant includes seconds", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(formatLocalTimeWithSec("2026-06-26T16:30:15.500Z")).toBe(
      "2026-06-27 00:30:15"
    );
  });

  test("UTC timezone shows UTC time (sanity check for TZ handling)", () => {
    process.env.TZ = "UTC";
    expect(formatLocalTime("2026-06-26T16:30:00.000Z")).toBe("2026-06-26 16:30");
    expect(formatLocalTimeWithSec("2026-06-26T16:30:45.123Z")).toBe(
      "2026-06-26 16:30:45"
    );
  });

  test("negative offset (TZ=America/Los_Angeles, UTC-7/8)", () => {
    process.env.TZ = "America/Los_Angeles";
    // 2026-06-26 PDT (UTC-7): 16:30 UTC → 09:30 local same day
    expect(formatLocalTime("2026-06-26T16:30:00.000Z")).toBe("2026-06-26 09:30");
  });

  test("handles midnight wrap to 00:00", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(formatLocalTime("2026-06-26T16:00:00.000Z")).toBe("2026-06-27 00:00");
  });
});

describe("reformatSupervisorLogLine", () => {
  test("converts ISO prefix to local time", () => {
    process.env.TZ = "Asia/Shanghai";
    const line = `[2026-06-26T16:30:45.123Z] [INFO] spawned "foo" (pid=1234)`;
    expect(reformatSupervisorLogLine(line)).toBe(
      `[2026-06-27 00:30:45] [INFO] spawned "foo" (pid=1234)`
    );
  });

  test("returns line unchanged when no ISO prefix", () => {
    process.env.TZ = "Asia/Shanghai";
    const line = "not a log line";
    expect(reformatSupervisorLogLine(line)).toBe("not a log line");
  });

  test("returns line unchanged when prefix is not a valid timestamp", () => {
    process.env.TZ = "Asia/Shanghai";
    // regex 要求 T + 数字/+/-/Z，garbage 不匹配
    const line = "[garbage] [INFO] something";
    expect(reformatSupervisorLogLine(line)).toBe("[garbage] [INFO] something");
  });

  test("preserves the rest of the line verbatim (level, message)", () => {
    process.env.TZ = "UTC";
    const line = `[2026-06-26T16:30:45.123Z] [WARN] entry "bar" not found`;
    expect(reformatSupervisorLogLine(line)).toBe(
      `[2026-06-26 16:30:45] [WARN] entry "bar" not found`
    );
  });

  test("handles empty string", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(reformatSupervisorLogLine("")).toBe("");
  });
});
