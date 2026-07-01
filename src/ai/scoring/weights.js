// Signal weights and band thresholds — adjust per insurer requirements.
// Score = min(100, Σ weight(type) * severityMultiplier(severity))

module.exports = {
  weights: {
    // Image forensics
    duplicate_image:        40,
    gps_mismatch:           25,
    timestamp_mismatch:     15,
    photo_too_old:          30, // capture date > 7 days before filing
    photo_age_unverifiable: 10, // no capture date — age couldn't be checked
    exif_stripped:          10,

    // Data/DB forensics
    duplicate_police_report: 40,
    claim_frequency_high:    30,
    claim_frequency_extreme: 20,
    duplicate_vin:           20,
    repeated_witness:        20,
    repeated_driver:         20,
    same_incident_date:      15,
    near_incident_location:  15,
    rapid_resubmission:      10,

    // Narrative (Claude)
    narrative_contradiction:  20,
    templated_language:       10,
    implausible_sequence:     20,
    coached_phrasing:         10,
  },

  severityMultiplier: { low: 0.4, medium: 0.7, high: 1.0 },

  // Bands: score <= low -> 'low', score <= medium -> 'medium', else 'high'
  bands: { low: 30, medium: 70 },
};
