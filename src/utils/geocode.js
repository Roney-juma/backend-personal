const logger = require('../middlewheres/logger');

/**
 * Turn a partner's postal address into coordinates.
 *
 * Assessor and garage matching is distance-based (see `getDistanceFromLatLonInKm`
 * in garage.service.js, and the "location coordinates are missing" guard in
 * assessor.service.js), so an address edited without its coordinates leaves the
 * partner being matched from wherever they used to be. This keeps the two in step.
 *
 * Provider: Google when GOOGLE_MAPS_API_KEY is set, otherwise OpenStreetMap's
 * Nominatim, which needs no key. Nominatim's usage policy requires a real
 * User-Agent and asks for at most one request per second — fine for profile
 * edits, which are rare and user-initiated, but do NOT call this in a loop.
 *
 * Never throws and never returns partial coordinates: callers get either a
 * complete { latitude, longitude } or null, so a geocoder outage degrades to
 * "coordinates unchanged" rather than failing the profile update.
 */

const TIMEOUT_MS = Number(process.env.GEOCODE_TIMEOUT_MS || 5000);
// Addresses here are Kenyan unless told otherwise; without it "Westlands" is
// ambiguous worldwide and Nominatim happily returns the wrong continent.
const DEFAULT_COUNTRY = process.env.GEOCODE_DEFAULT_COUNTRY || 'Kenya';
const USER_AGENT = process.env.GEOCODE_USER_AGENT || 'AVICS/1.0 (support@aveafrica.com)';

/** The address fields that actually identify a place, in narrowing order. */
const ADDRESS_FIELDS = ['name', 'estate', 'city', 'state', 'zip'];

/** "Kilimani, Nairobi, Kenya" from whichever parts are filled in. */
const buildQuery = (location = {}) => {
  const parts = ADDRESS_FIELDS
    .map((f) => location[f])
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
  if (parts.length === 0) return null;
  if (DEFAULT_COUNTRY && !parts.some((p) => p.toLowerCase() === DEFAULT_COUNTRY.toLowerCase())) {
    parts.push(DEFAULT_COUNTRY);
  }
  return parts.join(', ');
};

/** True when the two addresses would geocode to different places. */
const addressChanged = (before = {}, after = {}) =>
  ADDRESS_FIELDS.some((f) => (before?.[f] ?? '') !== (after?.[f] ?? ''));

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Coordinates supplied by the caller, if they are actually usable. */
const explicitCoords = (location = {}) => {
  const lat = Number(location.latitude);
  const lng = Number(location.longitude);
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { latitude: lat, longitude: lng };
};

const fetchJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`geocoder responded ${res.status}`);
  return res.json();
};

const geocodeGoogle = async (query, key) => {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${key}`;
  const body = await fetchJson(url);
  if (body.status !== 'OK' || !body.results?.length) {
    // ZERO_RESULTS is a legitimate answer, not a failure worth alarming about.
    if (body.status !== 'ZERO_RESULTS') {
      logger.warn(`[geocode] google returned ${body.status}${body.error_message ? `: ${body.error_message}` : ''}`);
    }
    return null;
  }
  const { lat, lng } = body.results[0].geometry.location;
  return isFiniteNumber(lat) && isFiniteNumber(lng) ? { latitude: lat, longitude: lng } : null;
};

const geocodeNominatim = async (query) => {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const body = await fetchJson(url, { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' });
  if (!Array.isArray(body) || body.length === 0) return null;
  const lat = Number(body[0].lat);
  const lng = Number(body[0].lon);
  return isFiniteNumber(lat) && isFiniteNumber(lng) ? { latitude: lat, longitude: lng } : null;
};

/** @returns {Promise<{latitude:number, longitude:number}|null>} */
const geocodeAddress = async (location) => {
  const query = buildQuery(location);
  if (!query) return null;
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    const coords = key ? await geocodeGoogle(query, key) : await geocodeNominatim(query);
    if (!coords) logger.info(`[geocode] no match for "${query}"`);
    return coords;
  } catch (err) {
    logger.warn(`[geocode] lookup failed for "${query}": ${err.message}`);
    return null;
  }
};

/**
 * Merge an incoming location edit with the stored one and keep coordinates true.
 *
 * Order of trust:
 *   1. coordinates the caller sent explicitly (a map pin beats a guess)
 *   2. a fresh geocode, when the address text actually changed
 *   3. the coordinates already on file
 *
 * @param {object|undefined} current  location currently stored
 * @param {object|undefined} incoming location from the update payload
 * @returns {Promise<object|null>} the location to persist, or null to leave alone
 */
const resolveLocation = async (current, incoming) => {
  if (!incoming || typeof incoming !== 'object') return null;

  // findOneAndUpdate replaces a nested object wholesale, so merge onto the
  // stored value — a payload with only `city` must not wipe the rest.
  const merged = { ...(current || {}), ...incoming };

  const pinned = explicitCoords(incoming);
  if (pinned) return { ...merged, ...pinned };

  if (!addressChanged(current, merged)) return merged;

  const coords = await geocodeAddress(merged);
  return coords ? { ...merged, ...coords } : merged;
};

module.exports = { geocodeAddress, resolveLocation, buildQuery, addressChanged, explicitCoords };
