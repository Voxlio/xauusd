import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

test("npm test runs every tests/*.test.ts file", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const files = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.ts"));
  const missing = files.filter((f) => !pkg.scripts.test.includes(`tests/${f}`));
  assert.deepEqual(missing, [], `add these to the "test" script in package.json: ${missing.join(", ")}`);
});

test(".env.local is git-ignored and .env.example lists every variable the server reads", () => {
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^\.env\*\.local$/m);
  const example = readFileSync(join(root, ".env.example"), "utf8");
  const env = readFileSync(join(root, "lib", "server", "env.ts"), "utf8");
  const read = new Set([...env.matchAll(/env, "([A-Z_]+)"/g)].map((m) => m[1]));
  read.add("ANTHROPIC_API_KEY");
  read.add("OPENAI_API_KEY");
  for (const name of read) assert.match(example, new RegExp(`^${name}=`, "m"), `${name} missing from .env.example`);
});
