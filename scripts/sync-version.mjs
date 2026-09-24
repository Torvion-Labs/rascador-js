// After `changeset version` bumps package.json, copy the version to the two
// places that can't read it at runtime: src/version.ts and jsr.json.
import { readFileSync, writeFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync("package.json", "utf8"))

writeFileSync(
  "src/version.ts",
  `// Written by scripts/sync-version.mjs from package.json. Do not edit by hand.\nexport const VERSION = "${version}"\n`
)

const jsr = JSON.parse(readFileSync("jsr.json", "utf8"))
jsr.version = version
writeFileSync("jsr.json", JSON.stringify(jsr, null, 2) + "\n")

console.log(`synced version ${version}`)
