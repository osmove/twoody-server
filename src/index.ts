import { buildApp } from "./app.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = await buildApp();

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`\nTwoody local-server ready on http://${HOST}:${PORT}\n`);
  if (process.env.TWOODY_PAIRING_CODE) {
    console.log(`  Pairing code: ${process.env.TWOODY_PAIRING_CODE}`);
    console.log(`  (pass this to \`twoody setup\` or the mobile app)\n`);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
