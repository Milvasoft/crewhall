// Stops `dist:store` before anything is built when the Partner Center values are missing:
// electron-builder would otherwise fall back to the package name and a test publisher, and the
// Store rejects that package only at upload. The values are in Partner Center > the app >
// Product management > Product identity (docs/contracts/masaustu-yayin.md).
const REQUIRED = {
  MS_STORE_IDENTITY_NAME: 'Package/Identity/Name, e.g. 12345Company.Crewhall',
  MS_STORE_PUBLISHER: 'Package/Identity/Publisher, e.g. CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
  MS_STORE_PUBLISHER_NAME: 'Package/Properties/PublisherDisplayName',
};

/** A pipeline variable that is not defined reaches the script as its own name, "$(NAME)". */
const unset = (value) => !value || !value.trim() || value.startsWith('$(');

const problems = [];
for (const [name, what] of Object.entries(REQUIRED)) {
  if (unset(process.env[name])) problems.push(`${name} is not set (${what})`);
}
const publisher = process.env.MS_STORE_PUBLISHER;
if (!unset(publisher) && !publisher.startsWith('CN=')) {
  problems.push('MS_STORE_PUBLISHER must start with "CN=", as Partner Center shows it');
}
const identity = process.env.MS_STORE_IDENTITY_NAME;
if (!unset(identity) && !/^[A-Za-z0-9.-]{3,50}$/.test(identity)) {
  problems.push('MS_STORE_IDENTITY_NAME may only hold letters, digits, "." and "-" (3 to 50)');
}

if (problems.length > 0) {
  console.error('dist:store needs the Microsoft Store identity:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`store identity: ${identity} (${process.env.MS_STORE_PUBLISHER_NAME})`);
