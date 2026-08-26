/**
 * Unit checks for src/utils/geocode.js — no network, no database.
 * Run: node scripts/test-geocode.js
 */
const assert = require('node:assert');

process.env.GEOCODE_DEFAULT_COUNTRY = 'Kenya';
delete process.env.GOOGLE_MAPS_API_KEY; // force the Nominatim path

const { buildQuery, addressChanged, explicitCoords, resolveLocation } = require('../src/utils/geocode');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    console.log('  FAIL ' + name + ' — ' + err.message);
    process.exitCode = 1;
  }
};

// Stub fetch so nothing leaves the machine.
let fetchCalls = 0;
let fetchImpl = async () => ({ ok: true, json: async () => [{ lat: '-1.2921', lon: '36.8219' }] });
global.fetch = async (...args) => { fetchCalls += 1; return fetchImpl(...args); };

console.log('buildQuery');
check('joins the filled parts and appends the country', () => {
  assert.strictEqual(buildQuery({ estate: 'Kilimani', city: 'Nairobi' }), 'Kilimani, Nairobi, Kenya');
});
check('skips blank and missing fields', () => {
  assert.strictEqual(buildQuery({ name: '  ', city: 'Mombasa' }), 'Mombasa, Kenya');
});
check('does not duplicate the country', () => {
  assert.strictEqual(buildQuery({ city: 'Nairobi', state: 'Kenya' }), 'Nairobi, Kenya, Kenya'.replace(', Kenya, Kenya', ', Kenya'));
});
check('returns null when there is no address at all', () => {
  assert.strictEqual(buildQuery({}), null);
  assert.strictEqual(buildQuery({ latitude: 1, longitude: 2 }), null);
});

console.log('addressChanged');
check('true when a field differs', () => {
  assert.strictEqual(addressChanged({ city: 'Nairobi' }, { city: 'Mombasa' }), true);
});
check('false when only coordinates differ', () => {
  assert.strictEqual(addressChanged({ city: 'Nairobi', latitude: 1 }, { city: 'Nairobi', latitude: 9 }), false);
});

console.log('explicitCoords');
check('accepts a valid pin', () => {
  assert.deepStrictEqual(explicitCoords({ latitude: -1.3, longitude: 36.8 }), { latitude: -1.3, longitude: 36.8 });
});
check('rejects out-of-range and partial coordinates', () => {
  assert.strictEqual(explicitCoords({ latitude: 91, longitude: 36 }), null);
  assert.strictEqual(explicitCoords({ latitude: -1.3 }), null);
  assert.strictEqual(explicitCoords({}), null);
});

(async () => {
  console.log('resolveLocation');

  await (async () => {
    fetchCalls = 0;
    const out = await resolveLocation(
      { city: 'Nairobi', latitude: -1.1, longitude: 36.1 },
      { city: 'Mombasa' },
    );
    check('geocodes when the address changed', () => {
      assert.strictEqual(out.city, 'Mombasa');
      assert.strictEqual(out.latitude, -1.2921);
      assert.strictEqual(out.longitude, 36.8219);
      assert.strictEqual(fetchCalls, 1);
    });
  })();

  await (async () => {
    fetchCalls = 0;
    const out = await resolveLocation(
      { city: 'Nairobi', estate: 'Kilimani', latitude: -1.1, longitude: 36.1 },
      { city: 'Nairobi' },
    );
    check('does NOT geocode when the address is unchanged', () => {
      assert.strictEqual(fetchCalls, 0);
      assert.strictEqual(out.latitude, -1.1);
      assert.strictEqual(out.estate, 'Kilimani', 'partial payload must not wipe stored fields');
    });
  })();

  await (async () => {
    fetchCalls = 0;
    const out = await resolveLocation(
      { city: 'Nairobi', latitude: -1.1, longitude: 36.1 },
      { city: 'Mombasa', latitude: -4.05, longitude: 39.66 },
    );
    check('an explicit pin wins over geocoding', () => {
      assert.strictEqual(fetchCalls, 0);
      assert.strictEqual(out.latitude, -4.05);
      assert.strictEqual(out.longitude, 39.66);
    });
  })();

  await (async () => {
    fetchImpl = async () => { throw new Error('network down'); };
    fetchCalls = 0;
    const out = await resolveLocation(
      { city: 'Nairobi', latitude: -1.1, longitude: 36.1 },
      { city: 'Mombasa' },
    );
    check('geocoder failure keeps the old coordinates and still saves the address', () => {
      assert.strictEqual(out.city, 'Mombasa');
      assert.strictEqual(out.latitude, -1.1, 'must not clear coordinates on failure');
      assert.strictEqual(out.longitude, 36.1);
    });
    fetchImpl = async () => ({ ok: true, json: async () => [{ lat: '-1.2921', lon: '36.8219' }] });
  })();

  await (async () => {
    fetchImpl = async () => ({ ok: true, json: async () => [] });
    const out = await resolveLocation({ city: 'Nairobi', latitude: -1.1, longitude: 36.1 }, { city: 'Nowhereville' });
    check('no geocoder match keeps the old coordinates', () => {
      assert.strictEqual(out.latitude, -1.1);
    });
  })();

  await (async () => {
    const out = await resolveLocation({ city: 'Nairobi' }, undefined);
    check('null when there is no incoming location (leave the record alone)', () => {
      assert.strictEqual(out, null);
    });
  })();

  console.log('');
  console.log(process.exitCode ? 'FAILURES above' : passed + ' checks passed');
})();
