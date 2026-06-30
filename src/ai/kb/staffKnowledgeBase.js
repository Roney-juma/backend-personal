/**
 * Front-office staff knowledge base.
 *
 * Distilled from the codebase (the source of truth) so the staff assistant can
 * answer "how / what / why" process questions WITHOUT a database call.
 * Injected into the system prompt and prompt-cached.
 *
 * Keep this factual and in sync with claim.model.js + the claim/assessor services.
 */
const STAFF_KNOWLEDGE_BASE = `
# AVE / AVICS Platform — Operations Knowledge Base

## Claim statuses (claim.status)
- Pending: just filed, awaiting admin review.
- Approved: passed review; open for assessor bids.
- Rejected: denied (carries a rejectionReason); customer may resubmit.
- Resubmitted: a rejected claim re-filed with corrections; admin reviews again.
- Assessment: an assessor has been awarded and is inspecting the vehicle.
- Assessed: assessment report submitted; ready for self-repair opt-in OR garage/supplier bidding.
- Garage: a supplier parts bid was accepted; awaiting/garage bidding for repair.
- Repair: a garage was awarded and is repairing the vehicle.
- Re-Assessment: assessor re-inspects repaired vehicle (or reviews a self-repair submission).
- ReAssessed: re-assessment passed.
- Completed: terminal — claim fully resolved (standard repair, self-repair settled, or glass done).
- SelfRepair: customer opted for cash-in-lieu (self-repair); tracked in the selfRepair sub-doc.
- UnderInvestigation: fraud suspected; an investigator is assigned.
- Investigated: investigation report submitted; admin reviews findings.
- GlassApproved: motor-glass claim approved; awaiting supplier assignment.
- GlassRepair: glass supplier is performing the replacement.

## Standard repair flow (end to end)
Pending → (admin approves) Approved → (≥3 assessor bids, top-rated auto-awarded) Assessment →
(assessor submits report) Assessed → (supplier parts bid accepted) Garage →
(garage bid awarded) Repair → (garage finishes) Re-Assessment → (passes) ReAssessed →
(admin completes) Completed.

## Bidding & auto-award rules
- Assessor bids: allowed once a claim is Approved. When a claim has 3 or more pending
  assessor bids, the highest-rated assessor is AUTO-AWARDED, others rejected, status → Assessment.
- Garage bids: allowed once a claim is Assessed/Garage. When 4 or more pending garage bids
  exist, the best is auto-selected by: (1) highest rating, then (2) lowest pending workload,
  then (3) lowest cost; others rejected, status → Repair.
- Supplier (parts) bids: a SupplyBid has status Pending/Accepted/Delivered/Rejected. Accepting
  one rejects the others and moves the claim toward garage repair.
- Bids may also be awarded/rejected manually by staff.

## Self-repair (cash-in-lieu) — two-stage payment
1. Opt-in (from Assessed): customer chooses self-repair with an estimate → status SelfRepair.
2. Submit: customer sends receipts + banking details (Mpesa or bank) → status Re-Assessment, selfRepair 'In-Review'.
3. Approve: admin sets a total awarded amount and a deposit percentage; system computes
   depositAmount and finalSettlementAmount → selfRepair 'Approved'.
4. Pay deposit: admin pays the upfront deposit → 'DepositPaid'.
5. Re-assess: assessor inspects completed repairs.
6. Pay final settlement: admin pays the remainder → claim Completed.

## Glass / motor-glass fast-track
Glass claims skip assessor and garage bidding. Flow: Pending → (approve) GlassApproved →
(assign a glass supplier, optional appointment) GlassRepair → (supplier completes) Completed.

## Fraud & investigation
- A claim can be flagged fraud-suspected (claim.fraud.suspected), moving it to UnderInvestigation.
- An investigator is appointed and submits a report via a secure token. Investigation status:
  Pending → Appointed → In Progress → Submitted → Reviewed.
- Report conclusion is one of: 'Fraud Confirmed', 'Fraud Not Found', 'Inconclusive'.
- After the report, the claim is Investigated and admin decides the outcome.

## Key entities
- Customer: policyholder who files claims (email, phone, policyNumber, policyType, insurer).
- Claim: central record — claimant, vehicles, incident, damage, bids, reports, selfRepair, glass, fraud.
- Assessor: inspects damage, bids/assesses, re-assesses; rated; geolocated (matched within ~50km).
- Garage: repairs vehicles; bids after assessment; tracks pending workload; rated; geolocated (~20km).
- Supplier: provides parts (SupplyBid) or is assigned directly to glass claims.
- Investigator: investigates suspected-fraud claims and submits findings.
- (Management entities — InsuranceCompany, Invoice, Subscription, SupportTicket — exist but are
  OUT OF SCOPE for front-office; if asked, say you don't have access to billing/admin data.)

## Geography & ratings
- Assessors/garages are matched to claims by proximity (assessors ~50km, garages ~20km).
- Assessors, garages, suppliers and investigators all carry an averageRating.
`;

module.exports = { STAFF_KNOWLEDGE_BASE };
