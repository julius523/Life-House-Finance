import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import {
  API_SOURCE_DEFAULT,
  AUTOMATION_USER_EMAIL,
  extractBearerToken,
  getConfiguredApiKey,
  isValidApiKey,
  readApiSource,
} from "../apiKey";

function makeReq(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request;
}

test("extractBearerToken returns null when header missing", () => {
  assert.equal(extractBearerToken(makeReq({})), null);
});

test("extractBearerToken returns null on malformed header", () => {
  assert.equal(extractBearerToken(makeReq({ authorization: "" })), null);
  assert.equal(
    extractBearerToken(makeReq({ authorization: "Bearer" })),
    null,
  );
  assert.equal(
    extractBearerToken(makeReq({ authorization: "Token abc123" })),
    null,
  );
  // Empty token after the scheme should also fail closed.
  assert.equal(
    extractBearerToken(makeReq({ authorization: "Bearer    " })),
    null,
  );
});

test("extractBearerToken accepts case-insensitive scheme", () => {
  assert.equal(
    extractBearerToken(makeReq({ authorization: "Bearer abc123" })),
    "abc123",
  );
  assert.equal(
    extractBearerToken(makeReq({ authorization: "bearer abc123" })),
    "abc123",
  );
  assert.equal(
    extractBearerToken(makeReq({ authorization: "BEARER abc123" })),
    "abc123",
  );
  // Trailing whitespace inside the token region must be trimmed,
  // otherwise a single accidental space breaks the timing-safe compare.
  assert.equal(
    extractBearerToken(makeReq({ authorization: "Bearer abc123  " })),
    "abc123",
  );
});

test("getConfiguredApiKey returns null when env var missing or too short", () => {
  const original = process.env["INTEGRATION_API_KEY"];
  try {
    delete process.env["INTEGRATION_API_KEY"];
    assert.equal(getConfiguredApiKey(), null);
    process.env["INTEGRATION_API_KEY"] = "tooshort";
    assert.equal(
      getConfiguredApiKey(),
      null,
      "keys shorter than 32 chars must be rejected",
    );
    process.env["INTEGRATION_API_KEY"] = "  " + "x".repeat(40) + "  ";
    assert.equal(getConfiguredApiKey(), "x".repeat(40), "must trim whitespace");
  } finally {
    if (original === undefined) delete process.env["INTEGRATION_API_KEY"];
    else process.env["INTEGRATION_API_KEY"] = original;
  }
});

test("isValidApiKey rejects when env var unset", () => {
  const original = process.env["INTEGRATION_API_KEY"];
  try {
    delete process.env["INTEGRATION_API_KEY"];
    assert.equal(isValidApiKey("anything"), false);
  } finally {
    if (original === undefined) delete process.env["INTEGRATION_API_KEY"];
    else process.env["INTEGRATION_API_KEY"] = original;
  }
});

test("isValidApiKey accepts exact match, rejects everything else", () => {
  const original = process.env["INTEGRATION_API_KEY"];
  try {
    const key = "k".repeat(40);
    process.env["INTEGRATION_API_KEY"] = key;
    assert.equal(isValidApiKey(key), true);
    assert.equal(isValidApiKey(key + "x"), false, "longer rejected");
    assert.equal(isValidApiKey(key.slice(0, -1)), false, "shorter rejected");
    assert.equal(isValidApiKey("k".repeat(39) + "x"), false, "near-miss rejected");
    assert.equal(isValidApiKey(""), false, "empty rejected");
  } finally {
    if (original === undefined) delete process.env["INTEGRATION_API_KEY"];
    else process.env["INTEGRATION_API_KEY"] = original;
  }
});

test("readApiSource returns default when header missing or empty", () => {
  assert.equal(readApiSource(makeReq({})), API_SOURCE_DEFAULT);
  assert.equal(
    readApiSource(makeReq({ "x-api-source": "" })),
    API_SOURCE_DEFAULT,
  );
  assert.equal(
    readApiSource(makeReq({ "x-api-source": "   " })),
    API_SOURCE_DEFAULT,
  );
});

test("readApiSource returns trimmed header value when present", () => {
  assert.equal(
    readApiSource(makeReq({ "x-api-source": "payroll-script" })),
    "payroll-script",
  );
  assert.equal(
    readApiSource(makeReq({ "x-api-source": "  weekly-import  " })),
    "weekly-import",
  );
});

test("readApiSource caps overlong header at 64 chars", () => {
  const huge = "a".repeat(500);
  const out = readApiSource(makeReq({ "x-api-source": huge }));
  assert.equal(out.length, 64);
});

test("AUTOMATION_USER_EMAIL is the documented address", () => {
  // Sanity-check the constant the seed and frontend hide-list both
  // reference. Keep these in sync if the address ever changes.
  assert.equal(AUTOMATION_USER_EMAIL, "automation@lifehousereentry.com");
});
