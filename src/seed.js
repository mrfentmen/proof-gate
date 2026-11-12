// Seed the demo cases into the store:  node src/seed.js
// (The UI's "Load demo cases" button calls POST /api/seed, same data.)

import { loadDotEnv } from "./env.js";
import { CaseStore } from "./cases.js";
import { SEED_CASES } from "./seed-data.js";

loadDotEnv();

const store = new CaseStore();
for (const input of SEED_CASES) {
  const record = store.add(input);
  console.log(`seeded ${record.id} — ${record.agentId}: ${record.purpose}`);
}
console.log(`Store: ${store.file}`);
