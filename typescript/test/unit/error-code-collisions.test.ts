/**
 * An SDK-side error code must never be spelled like a contract error.
 *
 * `ArcNowError.code` is the one field a consumer switches on, and it carries two
 * kinds of name: the SDK's own refusals, raised before any call, and the name of
 * whatever custom error a contract reverted with. If the two sets share a name,
 * "the address I gave the SDK is not a curve" and "a migrator reverted
 * NotACurve(caller)" arrive as the same `case` — and renaming after release is a
 * breaking change. So this reads every custom error in the pinned ABI set
 * (and the external router's) straight from the vendored JSON and requires the
 * intersection to be exactly the deliberate list.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

import {
  mapError,
  SDK_CODES_THAT_ARE_CONTRACT_ERRORS,
  SDK_ERROR_CODES,
  selectorOf,
} from "../../src/errors/index.js";

const REPO = resolve(import.meta.dirname, "../../..");
const ABI_DIRS = ["abi", "abi/external"] as const;

/** Error name -> the vendored files declaring it, across every pinned ABI. */
function contractErrorNames(): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const dir of ABI_DIRS) {
    for (const file of readdirSync(resolve(REPO, dir))) {
      if (!file.endsWith(".json") || file === "index.json") continue;
      const abi = JSON.parse(readFileSync(resolve(REPO, dir, file), "utf8")) as {
        type: string;
        name?: string;
      }[];
      for (const item of abi) {
        if (item.type !== "error" || item.name === undefined) continue;
        names.set(item.name, [...(names.get(item.name) ?? []), `${dir}/${file}`]);
      }
    }
  }
  return names;
}

describe("SDK error codes against contract error names", () => {
  const names = contractErrorNames();

  it("reads arcnow.io's ABIs and the router's, not just one set", () => {
    expect(names.get("InsufficientTokenReserve")?.some((f) => f.startsWith("abi/"))).toBe(true);
    expect(names.get("DeadlinePassed")?.some((f) => f.startsWith("abi/external/"))).toBe(true);
    expect(names.has("InvalidK")).toBe(false);
    expect(names.size).toBeGreaterThan(80);
  });

  it("no SDK-side code shares a name with any contract error, except by decision", () => {
    const collisions = SDK_ERROR_CODES
      .filter((code) => names.has(code))
      .filter((code) => !SDK_CODES_THAT_ARE_CONTRACT_ERRORS.includes(code))
      .map((code) => `${code} (also a contract error in ${(names.get(code) ?? []).join(", ")})`);
    expect(collisions).toEqual([]);
  });

  it("every deliberate exception really is a contract error, so the list cannot rot", () => {
    for (const code of SDK_CODES_THAT_ARE_CONTRACT_ERRORS) expect(names.has(code), code).toBe(true);
  });

  it("a migrator's own NotACurve(address) revert still decodes as that contract error", () => {
    const caller = "0x00000000000000000000000000000000000a11ce";
    const data = (selectorOf("NotACurve(address)")
      + encodeAbiParameters([{ type: "address" }], [caller]).slice(2)) as `0x${string}`;
    const mapped = mapError({ data });
    expect(mapped.code).toBe("NotACurve");
    expect(mapped.isRevert).toBe(true);
    expect(String(mapped.args.caller).toLowerCase()).toBe(caller);
    expect(mapped.message).toContain("migrator");
    expect(mapped.details.declaredIn).toEqual(expect.arrayContaining(["uniswapV4MigratorAbi"]));
  });
});
