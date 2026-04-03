import { readFileSync, writeFileSync } from "node:fs";

const manifestPath = "manifest.json";
const versionsPath = "versions.json";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));

versions[manifest.version] = manifest.minAppVersion;

writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
console.log(`Updated versions.json for ${manifest.version}`);
