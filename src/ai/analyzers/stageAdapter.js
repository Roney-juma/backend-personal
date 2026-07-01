/**
 * Read-time normalizer for a claim's per-stage evidence.
 *
 * Each lifecycle stage stores its photos / description / identity under different
 * field names. This maps them all to one consistent shape so the continuity
 * comparator doesn't care where the data lives — and NO schema changes anywhere.
 *
 *   { stage, label, photos: string[], description, plate, vin, make, model }
 */
const STAGES = ['claimant', 'assessment', 'garage', 'reassessment'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v.filter((u) => typeof u === 'string' && u) : []);

function normalizeStage(claim, stage) {
  const c = claim || {};
  switch (stage) {
    case 'claimant': {
      const v = (c.vehiclesInvolved && c.vehiclesInvolved[0]) || {};
      const dmg = c.damage || {};
      return {
        stage,
        label: 'claimant report',
        photos: arr(c.supportingDocuments && c.supportingDocuments.photos),
        description: [c.incidentDetails && c.incidentDetails.description, dmg.yourVehicle, c.damagedParts]
          .map(str).filter(Boolean).join(' | '),
        plate: str(v.licensePlate),
        vin: str(v.VIN),
        make: str(v.make),
        model: str(v.model),
      };
    }
    case 'assessment': {
      const r = c.assessmentReport || {};
      return {
        stage,
        label: 'assessment report',
        photos: arr(r.images), // NB: assessor app names this `images`, not `photos`
        description: [r.damageDescription, r.repairRecommendations, r.notes].map(str).filter(Boolean).join(' | '),
        plate: '',
        vin: str(r.vinNumber),
        make: '',
        model: '',
      };
    }
    case 'garage': {
      const r = c.garageRepairReport || {};
      return {
        stage,
        label: 'garage repair report',
        photos: arr(r.photos),
        description: [r.workDone, r.vehicleCondition].map(str).filter(Boolean).join(' | '),
        plate: '',
        vin: '',
        make: '',
        model: '',
      };
    }
    case 'reassessment': {
      const r = c.reAssessmentReport || {};
      return {
        stage,
        label: 're-assessment report',
        photos: arr(r.photos),
        description: str(r.notes),
        plate: '',
        vin: '',
        make: '',
        model: '',
      };
    }
    default:
      return { stage, label: stage, photos: [], description: '', plate: '', vin: '', make: '', model: '' };
  }
}

module.exports = { normalizeStage, STAGES };
