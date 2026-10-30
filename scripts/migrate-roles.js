// One-off: renames the old 'customer' role to 'supporter' on existing accounts. Safe to run more than once.
// Usage: npm run migrate-roles                 (live database; needs gcloud application-default credentials)
//        npm run migrate-roles -- --emulator   (local Firestore emulator)
import { col, firestore } from '../src/db.js';

const qs = await col.users.where('role', '==', 'customer').get();
for (let i = 0; i < qs.size; i += 400) {
  const batch = firestore.batch();
  for (const doc of qs.docs.slice(i, i + 400)) batch.update(doc.ref, { role: 'supporter' });
  await batch.commit();
}
console.log(`Updated ${qs.size} account${qs.size === 1 ? '' : 's'} from 'customer' to 'supporter'.`);
process.exit(0);
