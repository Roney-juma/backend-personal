/**
 * The insured-vehicle block in the claim-intake system prompt.
 *
 * The claimant's cars are already on their policy record, so the assistant
 * should offer them rather than asking someone who has just crashed to type out
 * a chassis-number-accurate description of their own car. These cases pin down
 * the three shapes that changes the conversation: no vehicle on file, exactly
 * one, and several.
 */
const path = require('node:path');
const Module = require('node:module');

/**
 * buildSystem needs only moment, the timezone and the money formatter, but the
 * agent module imports the tools, which reach the whole service graph and
 * through it the RSA signing keys. Stubbing that keeps the prompt testable on
 * any machine, including one with no keypair provisioned.
 */
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.endsWith('claimIntake.agent.js')) {
    if (request.includes('claimIntake.tools')) {
      return { TOOLS: [], executeTool: async () => ({}), CLAIM_TZ: 'Africa/Nairobi' };
    }
    if (request.includes('claimType.service')) return { getActiveTypes: async () => [] };
    if (request.includes('llm/claude')) return { complete: async () => ({}) };
    if (request.includes('llm/cost')) return { CostTracker: class {} };
    if (request.includes('llm/usage')) return { attributeSessionToClaim: async () => {} };
    if (request.includes('/features')) return { FEATURES: {} };
    if (request.includes('logger')) return { info() {}, warn() {}, error() {} };
  }
  return origLoad.apply(this, arguments);
};

const { buildSystem } = require(path.join(__dirname, '..', 'src/ai/agents/claimIntake.agent'));

/** buildSystem already returns the joined prompt. */
const prompt = (customer) => buildSystem(customer);

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
};

const base = { firstName: 'Asha', lastName: 'Njeri', phone: '+254700000000' };

const policy = (over = {}) => ({
  policyNumber: over.policyNumber ?? 'POL-1',
  status: over.status ?? 'active',
  vehicle: {
    registration: over.registration ?? 'KDA 123A',
    make: over.make ?? 'Toyota',
    model: over.model ?? 'Land Cruiser Prado',
    year: over.year ?? 2019,
  },
});

// No vehicle on file — behave as before and ask.
const none = prompt({ ...base, policies: [] });
check('with no vehicle on file the assistant is told to ask',
  none.includes('no vehicle on file') && !none.includes('INSURED VEHICLES ON FILE'));

// Exactly one — confirm it rather than asking them to type it.
const one = prompt({ ...base, policies: [policy()] });
check('one vehicle is offered for confirmation, not typed out',
  one.includes('INSURED VEHICLE ON FILE (1)')
    && one.includes('2019 Toyota Land Cruiser Prado — KDA 123A (policy POL-1')
    && one.includes('Confirm this is the vehicle involved'),
  one.split('\n').filter((l) => l.includes('KDA')).join(' | '));

// Several — list them and ask which. This is the case that prompted the change.
const many = prompt({
  ...base,
  policies: [
    policy(),
    policy({ policyNumber: 'POL-2', registration: 'KCX 987B', make: 'Nissan', model: 'X-Trail', year: 2021 }),
    policy({ policyNumber: 'POL-3', registration: 'KBB 456C', make: 'Isuzu', model: 'D-Max', year: 2017 }),
  ],
});
check('several vehicles are listed and the claimant is asked which',
  many.includes('INSURED VEHICLES ON FILE (3)')
    && many.includes('KDA 123A') && many.includes('KCX 987B') && many.includes('KBB 456C')
    && many.includes('Ask WHICH ONE the claim is for'));

// A lapsed policy is flagged, and the assistant is told to take the claim anyway.
const lapsed = prompt({
  ...base,
  policies: [policy(), policy({ policyNumber: 'POL-2', registration: 'KCX 987B', status: 'lapsed' })],
});
check('a lapsed policy is marked and the claim is still taken',
  lapsed.includes('[POLICY LAPSED]')
    && lapsed.includes('never refuse to take the claim'),
  lapsed.split('\n').filter((l) => l.includes('LAPSED')).join(' | '));

// A policy with no vehicle details at all is skipped rather than listed blank.
const emptyVehicle = prompt({
  ...base,
  policies: [{ policyNumber: 'POL-9', status: 'active', vehicle: {} }],
});
check('a policy carrying no vehicle details is not listed as a blank row',
  emptyVehicle.includes('no vehicle on file'));

// The claimant is never told to retype details we already hold.
check('the required-fields line points at the list rather than at the claimant',
  one.includes("take the insured vehicle's from the list above rather than asking"));

// Each car carries its own policy: number, type, status, expiry and excess. The
// excess is the first thing a claimant asks about, so the assistant must hold it.
const withCover = prompt({
  ...base,
  policies: [
    {
      policyNumber: 'POL-77',
      policyType: 'Comprehensive',
      status: 'active',
      expiryDate: new Date('2027-03-31T00:00:00Z'),
      excessMinor: 2_000_000,
      vehicle: { registration: 'KDA 123A', make: 'Toyota', model: 'Prado', year: 2019, chassisNumber: 'JTEBH9FJ' },
    },
  ],
});
check('a car carries its policy number, type, status, expiry and excess',
  withCover.includes('policy POL-77')
    && withCover.includes('Comprehensive')
    && withCover.includes('status active')
    && withCover.includes('expires 31 Mar 2027')
    // formatMinor renders KES as the KSh symbol.
    && /excess (KES|KSh) 20,000.00/.test(withCover),
  withCover.split('\n').find((l) => l.includes('POL-77')));

check('the assistant answers cover questions from the policy, without reciting it',
  withCover.includes('If the claimant asks what their excess is')
    && withCover.includes('Do not read the chassis number or the whole policy back at them'));

check('a policy that expired before the incident is raised, not used to refuse',
  withCover.includes('EXPIRED BEFORE the incident date')
    && withCover.includes('Never turn a claimant away'));

const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? '\nAll intake vehicle cases pass.' : `\n${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
