import {
  readdirSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  statSync,
  createReadStream,
} from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve("output/cicd/runtime");
const members = [];
function walk(dir, prefix = "") {
  for (const item of readdirSync(dir)) {
    const name = prefix + item,
      path = `${dir}/${item}`,
      stat = lstatSync(path);
    if (/[\r\n\\]/.test(name) || item.startsWith("-") || /^\.env(?:\.|$)|^\.npmrc$/.test(item)) {
      throw Error("Unsafe archive member");
    }
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path),
        target = relative(root, realpathSync(path));
      if (
        !name.startsWith("node_modules/") ||
        isAbsolute(link) ||
        target.startsWith("..") ||
        isAbsolute(target)
      ) {
        throw Error("Unsafe symlink");
      }
      members.push(name);
    } else if (stat.isDirectory()) {
      walk(path, name + "/");
    } else if (stat.isFile()) {
      members.push(name);
    } else {
      throw Error("Unsupported archive member");
    }
  }
}
walk(root);
members.sort();
writeFileSync("output/cicd/runtime.members", members.join("\n") + "\n");
execFileSync("tar", [
  "--format=gnu",
  "--mtime=@0",
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "--mode=u+rwX,go+rX,go-w",
  "--no-recursion",
  "-czf",
  resolve("output/cicd/runtime.tgz"),
  "-C",
  root,
  "-T",
  resolve("output/cicd/runtime.members"),
]);
// The service runs as purpleshoes, not as the CI runner or root. Private build umasks must not survive packaging.
execFileSync("python3", [
  "-c",
  `
import tarfile
with tarfile.open('output/cicd/runtime.tgz') as archive:
 for member in archive:
  if member.isfile():
   assert member.mode & 0o444 == 0o444, 'Runtime file is unreadable to the service account'
   assert member.mode & 0o022 == 0, 'Runtime file is writable by a non-owner'
`,
]);
const hash = createHash("sha256");
for await (const chunk of createReadStream("output/cicd/runtime.tgz")) {
  hash.update(chunk);
}
const manifest = JSON.parse(readFileSync(`${root}/FLEET-RELEASE-MANIFEST.json`));
writeFileSync(
  "output/cicd/runtime.json",
  JSON.stringify(
    {
      sha256: hash.digest("hex"),
      bytes: statSync("output/cicd/runtime.tgz").size,
      members: members.length,
      sourceManifestSha256: manifest.sourceManifestSha256,
      commit: manifest.commit,
    },
    null,
    2,
  ) + "\n",
);
