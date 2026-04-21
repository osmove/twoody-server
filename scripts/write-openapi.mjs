import { writeFileSync } from "fs";
import { resolve } from "path";
import { buildApp } from "../dist/app.js";

const app = await buildApp();
await app.ready();
const outputPath = resolve(process.cwd(), "openapi.json");

writeFileSync(outputPath, JSON.stringify(app.swagger(), null, 2) + "\n");
await app.close();

console.log(`Wrote ${outputPath}`);
