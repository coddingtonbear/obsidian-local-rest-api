import {
  CurrentFileState,
  EntityTagCondition,
  formatEntityTag,
  hasPreconditions,
  parseEntityTagCondition,
  preconditionFailure,
} from "./conditionalRequests";

const FILE: CurrentFileState = { exists: true, version: "abc123" };
const MISSING: CurrentFileState = { exists: false, version: null };
const FOLDER: CurrentFileState = { exists: true, version: null };

function tags(...values: string[]): EntityTagCondition {
  return values.map((v) =>
    v.startsWith("W/") ? { opaque: v.slice(2), weak: true } : { opaque: v, weak: false },
  );
}

describe("formatEntityTag", () => {
  test("quotes the version as a strong entity tag", () => {
    expect(formatEntityTag("abc123")).toBe('"abc123"');
  });
});

describe("parseEntityTagCondition", () => {
  test.each([
    ["*", "*"],
    ["  *  ", "*"],
    ['"abc123"', tags("abc123")],
    ["abc123", tags("abc123")],
    ['W/"abc123"', tags("W/abc123")],
    ['"a", "b"', tags("a", "b")],
    ['"a",W/"b" , c', tags("a", "W/b", "c")],
    ['"a", , "b",', tags("a", "b")],
    ['"a,b"', tags("a,b")],
  ])("parses %j", (raw, expected) => {
    expect(parseEntityTagCondition(raw)).toEqual(expected);
  });

  test.each([
    [""],
    ["   "],
    [","],
    ["W/abc"],
    ['"abc'],
    ['"a" "b"'],
    ['"a"b'],
    ['a"b'],
    ["*, \"a\""],
  ])("rejects %j", (raw) => {
    expect(parseEntityTagCondition(raw)).toBeNull();
  });
});

test("parses a long hostile value in linear time", () => {
  const started = Date.now();
  expect(parseEntityTagCondition("!".repeat(200_000) + '"')).toBeNull();
  expect(parseEntityTagCondition('"a", '.repeat(50_000))).toHaveLength(50_000);
  expect(Date.now() - started).toBeLessThan(1000);
});

describe("hasPreconditions", () => {
  test("is false for undefined or an empty object", () => {
    expect(hasPreconditions(undefined)).toBe(false);
    expect(hasPreconditions({})).toBe(false);
  });

  test("is true when either header is present", () => {
    expect(hasPreconditions({ ifMatch: "*" })).toBe(true);
    expect(hasPreconditions({ ifNoneMatch: "*" })).toBe(true);
  });
});

describe("preconditionFailure", () => {
  test("no preconditions always proceeds", () => {
    expect(preconditionFailure(FILE, {})).toBeNull();
    expect(preconditionFailure(MISSING, {})).toBeNull();
  });

  describe("If-Match", () => {
    test("a matching tag proceeds", () => {
      expect(preconditionFailure(FILE, { ifMatch: tags("abc123") })).toBeNull();
    });

    test("any tag in a list may match", () => {
      expect(preconditionFailure(FILE, { ifMatch: tags("zzz", "abc123") })).toBeNull();
    });

    test("a different tag fails and names the current version", () => {
      const failure = preconditionFailure(FILE, { ifMatch: tags("zzz") });
      expect(failure).toContain('"zzz"');
      expect(failure).toContain('"abc123"');
    });

    test("a weak tag never matches, even with the right value, and says why", () => {
      const failure = preconditionFailure(FILE, { ifMatch: tags("W/abc123") });
      expect(failure).toMatch(/Weak entity tags never satisfy If-Match/);
    });

    test("a tag fails when the file does not exist", () => {
      expect(preconditionFailure(MISSING, { ifMatch: tags("abc123") })).toMatch(
        /does not exist/,
      );
    });

    test("a tag fails against a folder", () => {
      expect(preconditionFailure(FOLDER, { ifMatch: tags("abc123") })).toMatch(/not a file/);
    });

    test("* proceeds when the file exists and fails when it does not", () => {
      expect(preconditionFailure(FILE, { ifMatch: "*" })).toBeNull();
      expect(preconditionFailure(MISSING, { ifMatch: "*" })).toMatch(/does not/);
    });
  });

  describe("If-None-Match", () => {
    test("* proceeds when nothing exists and fails when something does", () => {
      expect(preconditionFailure(MISSING, { ifNoneMatch: "*" })).toBeNull();
      expect(preconditionFailure(FILE, { ifNoneMatch: "*" })).toMatch(/something does/);
      expect(preconditionFailure(FOLDER, { ifNoneMatch: "*" })).toMatch(/something does/);
    });

    test("a list fails when it names the current version, weak or not", () => {
      expect(preconditionFailure(FILE, { ifNoneMatch: tags("abc123") })).not.toBeNull();
      expect(preconditionFailure(FILE, { ifNoneMatch: tags("W/abc123") })).not.toBeNull();
    });

    test("a list proceeds when it names other versions or nothing exists", () => {
      expect(preconditionFailure(FILE, { ifNoneMatch: tags("zzz") })).toBeNull();
      expect(preconditionFailure(MISSING, { ifNoneMatch: tags("abc123") })).toBeNull();
    });
  });

  test("If-Match is evaluated before If-None-Match", () => {
    const failure = preconditionFailure(FILE, {
      ifMatch: tags("zzz"),
      ifNoneMatch: "*",
    });
    expect(failure).toMatch(/^If-Match/);
  });

  test("both must hold when both are present", () => {
    expect(
      preconditionFailure(FILE, { ifMatch: tags("abc123"), ifNoneMatch: "*" }),
    ).toMatch(/^If-None-Match/);
  });
});
