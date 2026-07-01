/**
 * Deterministic image & evidence forensics analyzer.
 * No LLM — works from claim #1. Gracefully degrades if optional packages
 * (exifr, image-hash) are not installed.
 *
 * Returns Signal[]
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('../../middlewheres/logger');
const ClaimPhotoHash = require('../../models/claimPhotoHash.model');

// Optional packages — installed separately: npm i exifr image-hash
let exifr = null;
let imageHash = null;
try { exifr = require('exifr'); } catch (_) {}
try { imageHash = require('image-hash'); } catch (_) {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fetchBuffer = (url) => new Promise((resolve, reject) => {
  try {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    lib.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  } catch (err) {
    reject(err);
  }
});

const parseExif = async (buf) => {
  if (!exifr || !buf) return null;
  try { return await exifr.parse(buf, { gps: true, tiff: true, exif: true }); }
  catch (_) { return null; }
};

const computePhash = (buf) => new Promise((resolve) => {
  if (!imageHash || !buf) return resolve(null);
  try {
    imageHash.imageHashData(buf, 16, true, (err, hash) => resolve(err ? null : hash));
  } catch (_) { resolve(null); }
});

const hammingDistance = (h1, h2) => {
  if (!h1 || !h2 || h1.length !== h2.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < h1.length; i += 2) {
    let xor = parseInt(h1.slice(i, i + 2), 16) ^ parseInt(h2.slice(i, i + 2), 16);
    while (xor) { dist += xor & 1; xor >>= 1; }
  }
  return dist;
};

// Haversine distance in km between two lat/lng pairs
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const GPS_MISMATCH_KM = 5;    // flag if photo GPS > 5 km from incident location
const TIMESTAMP_TOLERANCE_H = 24; // flag if photo timestamp differs > 24h from incident
const PHASH_HAMMING_THRESHOLD = 10; // flag if ≤10 bit difference (very similar image)

// ─── Main ─────────────────────────────────────────────────────────────────────

const run = async (claim) => {
  const signals = [];
  const checksRun = [];

  // Collect photos from all sources present on the claim at analysis time
  const claimantPhotos = (claim.supportingDocuments?.photos || []).map(url => ({ url, source: 'claimant' }));
  const assessmentPhotos = (() => {
    const report = claim.assessmentReport;
    if (!report) return [];
    const urls = report.photos || report.damagePhotos || report.images || [];
    return (Array.isArray(urls) ? urls : []).map(url => ({ url, source: 'assessor' }));
  })();
  const reAssessmentPhotos = (claim.reAssessmentReport?.photos || []).map(url => ({ url, source: 're_assessor' }));

  const allPhotos = [...claimantPhotos, ...assessmentPhotos, ...reAssessmentPhotos];
  if (!allPhotos.length) return { signals, checksRun };

  const incidentLat = claim.incidentDetails?.latitude;
  const incidentLon = claim.incidentDetails?.longitude;
  const incidentDate = claim.incidentDetails?.date ? new Date(claim.incidentDetails.date) : null;

  for (const { url, source: photoSource } of allPhotos) {
    let buf = null;
    try {
      buf = await fetchBuffer(url);
    } catch (err) {
      logger.warn(`[imageForensics] fetch failed for ${url}: ${err.message}`);
      continue;
    }

    const exif = await parseExif(buf);

    // ── EXIF integrity ───────────────────────────────────────────────────────
    checksRun.push('exif_integrity');
    if (!exif) {
      signals.push({
        type: 'exif_stripped',
        severity: 'low',
        evidence: url,
        explanation: `${photoSource} photo has no EXIF metadata — may indicate image editing or re-upload.`,
        source: 'image_forensics',
      });
    }

    // ── GPS vs incident location ─────────────────────────────────────────────
    if (exif && incidentLat != null && incidentLon != null) {
      checksRun.push('gps_check');
      const gpsLat = exif.latitude;
      const gpsLon = exif.longitude;
      if (gpsLat != null && gpsLon != null) {
        const distKm = haversineKm(incidentLat, incidentLon, gpsLat, gpsLon);
        if (distKm > GPS_MISMATCH_KM) {
          signals.push({
            type: 'gps_mismatch',
            severity: distKm > 50 ? 'high' : 'medium',
            value: Math.round(distKm),
            evidence: url,
            explanation: `${photoSource} photo GPS is ${Math.round(distKm)} km from the reported incident location.`,
            source: 'image_forensics',
          });
        }
      }
    }

    // ── Timestamp vs incident date ───────────────────────────────────────────
    if (exif && incidentDate) {
      checksRun.push('timestamp_check');
      const photoTs = exif.DateTimeOriginal || exif.CreateDate;
      if (photoTs) {
        const photoDate = new Date(photoTs);
        const diffH = Math.abs(photoDate - incidentDate) / 3600000;
        if (diffH > TIMESTAMP_TOLERANCE_H) {
          signals.push({
            type: 'timestamp_mismatch',
            severity: diffH > 168 ? 'high' : 'medium',
            value: Math.round(diffH),
            evidence: url,
            explanation: `${photoSource} photo was taken ${Math.round(diffH)} hours ${photoDate < incidentDate ? 'before' : 'after'} the reported incident date.`,
            source: 'image_forensics',
          });
        }
      }
    }

    // ── Perceptual hash / duplicate detection ────────────────────────────────
    const phash = await computePhash(buf);
    if (phash) {
      checksRun.push('duplicate_image');
      await ClaimPhotoHash.create({ claimId: claim._id, url, phash }).catch(() => {});

      const existing = await ClaimPhotoHash.find({
        claimId: { $ne: claim._id },
      }).select('phash claimId url').lean().limit(5000);

      const match = existing.find(e => hammingDistance(phash, e.phash) <= PHASH_HAMMING_THRESHOLD);
      if (match) {
        signals.push({
          type: 'duplicate_image',
          severity: 'high',
          evidence: url,
          explanation: `${photoSource} photo is visually identical or near-identical to one used in claim ${match.claimId}.`,
          source: 'image_forensics',
        });
      }
    }
  }

  return { signals, checksRun: [...new Set(checksRun)] };
};

module.exports = { run };
