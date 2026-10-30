import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import prettier from "prettier";
import { addControlBlocks } from "./format.mjs";

test("control blocks preserve dangling else, loops, continue, comments and return values", async () => {
  const source = `
    function calculate(flag) {
      let total = 0;
      for (let i = 0; i < 4; i++) if (i === 2) continue; else total += i;
      if (flag) if (total > 0) return total; else return -1;
      while (total < 7) total++;
      do total--; while (total > 5);
      if (total === 5) // Preserve the explanation next to its branch.
        return total + 1;
      return 0;
    }
    JSON.stringify([calculate(true), calculate(false)]);
  `;
  const changed = addControlBlocks(source, "example.js");
  assert.equal(runInNewContext(changed), runInNewContext(source));
  assert.equal(addControlBlocks(changed, "example.js"), changed);
  const formatted = await prettier.format(changed, { parser: "babel" });
  assert.equal(runInNewContext(formatted), runInNewContext(source));
});
