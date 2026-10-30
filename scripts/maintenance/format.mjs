// Format tracked project source without touching dependencies, runtime data, or theme output text.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import ts from "typescript";

export function addControlBlocks(source, filename) {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const insertions = [];

  function wrap(statement) {
    if (!statement || ts.isBlock(statement) || ts.isFunctionDeclaration(statement)) {
      return;
    }
    insertions.push([statement.getFullStart(), " {\n"], [statement.end, "\n}"]);
  }

  function visit(node) {
    if (ts.isIfStatement(node)) {
      wrap(node.thenStatement);
      if (node.elseStatement && !ts.isIfStatement(node.elseStatement)) {
        wrap(node.elseStatement);
      }
    } else if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      wrap(node.statement);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  let result = source;
  for (const [position, value] of insertions.sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, position) + value + result.slice(position);
  }
  return result;
}

async function main() {
  const check = process.argv.includes("--check");
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);
  let changed = 0;

  for (const file of new Set(files)) {
    if (!existsSync(file)) {
      continue;
    }
    const info = await prettier.getFileInfo(file, { ignorePath: ".prettierignore" });
    if (info.ignored || !info.inferredParser) {
      continue;
    }
    const original = readFileSync(file, "utf8");
    const withBlocks = /\.[cm]?[jt]sx?$/.test(file) ? addControlBlocks(original, file) : original;
    const formatted = await prettier.format(withBlocks, {
      ...(await prettier.resolveConfig(file)),
      filepath: file,
    });
    if (formatted !== original) {
      changed++;
      if (check) {
        console.error(`Formatting required: ${file}`);
      } else {
        writeFileSync(file, formatted);
      }
    }
  }
  console.log(
    `${check ? "Checked" : "Formatted"} project source; ${changed} files ${check ? "need changes" : "updated"}.`,
  );
  if (check && changed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
