// Creates a staff account or resets a staff password.
// Usage: npm run create-admin -- <email> <password> [admin|superadmin]
import { col } from '../src/db.js';
import { hashPassword, destroyAllSessions } from '../src/security.js';
import { createUser, findUserByEmail } from '../src/routes/auth.js';

const [email, password, roleArg = 'superadmin'] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run create-admin -- <email> <password> [admin|superadmin]');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Staff passwords must be at least 12 characters.');
  process.exit(1);
}
const role = roleArg === 'admin' ? 'admin' : 'superadmin';
const passwordHash = await hashPassword(password);
const existing = await findUserByEmail(email);

if (existing) {
  if (existing.role === 'supporter') {
    console.error('That email belongs to a supporter account. Use a different email for staff.');
    process.exit(1);
  }
  await col.users.doc(existing.id).update({ passwordHash, role, disabled: false });
  await destroyAllSessions(existing.id);
  console.log(`Updated ${role} ${email} (password reset, sessions signed out).`);
} else {
  await createUser({ role, email, fullName: role === 'superadmin' ? 'Superadmin' : 'Admin', passwordHash });
  console.log(`Created ${role} ${email}.`);
}
process.exit(0);
