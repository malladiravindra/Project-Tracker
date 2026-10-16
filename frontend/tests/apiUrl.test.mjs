import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveApiBase, joinApiUrl } from "../lib/apiUrl.ts";

const PROD = "https://django-ten-ruby.vercel.app";

test("adds /api to the origin and drops trailing slashes", () => {
  assert.equal(resolveApiBase(PROD, true), `${PROD}/api`);
  assert.equal(resolveApiBase(`${PROD}/`, true), `${PROD}/api`);
  assert.equal(resolveApiBase(`  ${PROD}//  `, true), `${PROD}/api`);
});

test("does not double an existing /api suffix", () => {
  assert.equal(resolveApiBase(`${PROD}/api`, true), `${PROD}/api`);
  assert.equal(resolveApiBase(`${PROD}/api/`, true), `${PROD}/api`);
});

test("missing value: dev falls back to localhost, production throws", () => {
  assert.equal(resolveApiBase(undefined, false), "http://127.0.0.1:8000/api");
  assert.throws(() => resolveApiBase(undefined, true), /NEXT_PUBLIC_API_URL is not set/);
  assert.throws(() => resolveApiBase("  ", true), /not set/);
});

test("invalid values are rejected", () => {
  assert.throws(() => resolveApiBase("not a url", false), /valid absolute URL/);
  assert.throws(() => resolveApiBase("ftp://example.com", false), /https/);
  assert.throws(() => resolveApiBase("/api", true), /valid absolute URL/);
});

test("a comma list or embedded whitespace is rejected, not parsed into the path", () => {
  assert.throws(() => resolveApiBase(`${PROD}/,https://127.0.0.1:8000`, true), /single URL/);
  assert.throws(() => resolveApiBase(`${PROD},`, true), /single URL/);
  assert.throws(() => resolveApiBase(`${PROD} https://other.example`, false), /valid absolute URL/);
});

test("production rejects http and localhost", () => {
  assert.throws(() => resolveApiBase("http://example.com", true), /https/);
  assert.throws(() => resolveApiBase("https://localhost:8000", true), /not localhost/);
  assert.equal(resolveApiBase("http://127.0.0.1:8000", false), "http://127.0.0.1:8000/api");
});

test("joinApiUrl keeps Django trailing slashes and never doubles slashes", () => {
  const base = `${PROD}/api`;
  assert.equal(joinApiUrl(base, "/members/"), `${PROD}/api/members/`);
  assert.equal(joinApiUrl(`${base}/`, "/projects/1/history/"), `${PROD}/api/projects/1/history/`);
  assert.equal(joinApiUrl(base, "today/"), `${PROD}/api/today/`);
});
