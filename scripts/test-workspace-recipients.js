/**
 * recipientsOf — who a workspace notification reaches, and on which channel.
 *
 * Email is the easy half. WhatsApp only fires when sendEmailNotification can
 * find a phone: it resolves email → phone across the actor collections, which
 * covers staff and customers and covers nobody else. A client contact and an
 * external guest are in none of them, so if their number is not carried here
 * they get email and silence — which looks identical to WhatsApp being broken.
 */
const path = require('node:path');
const Module = require('node:module');

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.endsWith('workspaceNotify.service.js')) {
    if (request.includes('email.service')) return { sendEmailNotification: async () => {} };
    if (request.includes('logger')) return { info() {}, warn() {}, error() {} };
  }
  return origLoad.apply(this, arguments);
};

const { recipientsOf } = require(path.join(__dirname, '..', 'src/service/workspaceNotify.service'));

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
};

const find = (list, email) => list.find((r) => r.email === email);

// A staff attendee: phone comes off the populated ProviderUser.
const staffOnly = recipientsOf({
  attendees: [{ name: 'Asha', user: { _id: 'u1', email: 'asha@ave.com', phone: '+254700000001' } }],
});
check('a staff attendee carries the phone from their user record',
  find(staffOnly, 'asha@ave.com')?.phone === '+254700000001',
  JSON.stringify(staffOnly));

// An external guest: in no collection, so the number must come off the meeting.
const guest = recipientsOf({
  attendees: [{ name: 'Ben', email: 'ben@acme.co', phone: '+254700000002', isExternal: true }],
});
check('an external guest carries the phone stored on the attendee',
  find(guest, 'ben@acme.co')?.phone === '+254700000002');

// The client contact: their number is on the meeting and was previously dropped.
const client = recipientsOf({
  client: { contactName: 'Cara', contactEmail: 'cara@insurer.co.ke', contactPhone: '+254700000003' },
});
check('the client contact carries contactPhone',
  find(client, 'cara@insurer.co.ke')?.phone === '+254700000003');

// The organiser gets their own copy, with their own number.
const organiser = recipientsOf({
  organiser: { email: 'org@ave.com', phone: '+254700000004' },
  organiserName: 'Dee',
});
check('the organiser carries their phone',
  find(organiser, 'org@ave.com')?.phone === '+254700000004');

// No phone anywhere is null, never undefined-as-a-string — fanOut branches on it.
const noPhone = recipientsOf({ attendees: [{ name: 'Eve', email: 'eve@acme.co' }] });
check('a recipient with no number has phone null',
  find(noPhone, 'eve@acme.co')?.phone === null,
  JSON.stringify(noPhone));

// Deduplication must not lose the number: the first entry wins, and if the
// organiser is also an attendee the attendee entry is the one kept.
const dup = recipientsOf({
  attendees: [{ name: 'Asha', email: 'asha@ave.com', phone: '+254700000001' }],
  organiser: { email: 'asha@ave.com', phone: '+254700000009' },
  organiserName: 'Asha',
});
check('a person listed twice appears once, keeping the first number',
  dup.length === 1 && dup[0].phone === '+254700000001',
  JSON.stringify(dup));

// An attendee with a name but no address reaches nobody on either channel.
const nameOnly = recipientsOf({ attendees: [{ name: 'Walk-in guest', phone: '+254700000005' }] });
check('a guest with a phone but no email is not a recipient',
  nameOnly.length === 0,
  JSON.stringify(nameOnly));

const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? '\nAll recipient-routing cases pass.' : `\n${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
