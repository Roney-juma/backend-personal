/**
 * Conversational claim-intake agent.
 *
 * Drives a manual Claude tool-use loop: the model collects claim details from
 * the claimant, then files the claim through the existing fileClaimService.
 * Stateless — the caller passes the full message history each turn and gets
 * the updated history back to persist client-side.
 */
const { complete } = require('../llm/claude');
const { CostTracker } = require('../llm/cost');
const { TOOLS, executeTool } = require('./claimIntake.tools');
const logger = require('../../middlewheres/logger');

const MAX_TOOL_ROUNDS = 6; // bound the loop per turn

function buildSystem(customer) {
  const name = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'the claimant';
  return [
    `You are AVE Insurance's claim-intake assistant. You help a known policyholder file a motor-insurance claim through a friendly, step-by-step chat.`,
    ``,
    `CLAIMANT (already verified via their secure link — do NOT ask for these):`,
    `- Name: ${name}`,
    `- Phone: ${customer.phone || 'on file'}`,
    `- Email: ${customer.email || 'on file'}`,
    `- Policy number: ${customer.policyNumber || 'on file'}`,
    ``,
    `YOUR JOB`,
    `- Greet ${name} by name on the first turn and explain you'll help report the incident.`,
    `- Collect the required details conversationally, a few at a time. Record everything via the set_claim_details tool as you learn it.`,
    `- REQUIRED before filing: incident date, time, location and description; for each vehicle make, model, year and licence plate; for each driver name, phone, email and licence number.`,
    `- Optional (ask briefly, don't insist): other-vehicle/property damage, injuries, witnesses, police report, photos.`,
    `- If the claimant uploaded photos, their URLs will appear in the chat; record them in supportingDocuments.photos.`,
    ``,
    `RULES`,
    `- Never invent or assume details. If unsure, ask.`,
    `- Do not ask for the claimant's name, phone, email, or address — you already have them.`,
    `- Only ask for what is still missing (the set_claim_details tool tells you what's outstanding).`,
    `- When nothing required is missing, show a clear plain-language SUMMARY of the claim and ask the claimant to confirm before filing.`,
    `- Only call submit_claim AFTER the claimant explicitly confirms, with confirmed=true. Never file without confirmation.`,
    `- Keep replies concise and warm. Respond with your message to the claimant only — no internal notes.`,
  ].join('\n');
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * Run one user turn through the agent.
 *
 * @param {Object} params
 * @param {Object} params.customer    Customer doc (identity).
 * @param {string} params.token       Claim token (credential for filing).
 * @param {Array}  params.messages    Prior Anthropic-format history (may be []).
 * @param {string} params.userMessage New user text for this turn.
 * @param {Object} params.req         Express req (for fileClaimService audit log).
 * @returns {Object} { messages, reply, status, claimId }
 */
async function runClaimIntake({ customer, token, messages = [], userMessage, req }) {
  const system = buildSystem(customer);
  const working = [...messages, { role: 'user', content: userMessage }];
  const cost = new CostTracker('claim-intake');

  let status = 'collecting';
  let claimId = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await complete({ system, messages: working, tools: TOOLS, maxTokens: 1024 });
    cost.record(response);

    // Persist the assistant turn (text + any tool_use blocks) into history.
    working.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      cost.flush();
      return { messages: working, reply: textOf(response.content), status, claimId };
    }

    // Execute every tool_use block and feed results back.
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const block of toolUses) {
      const result = await executeTool(block, { messages: working, token, req });
      if (result.submitted) {
        status = 'submitted';
        claimId = result.claim._id;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
    }
    working.push({ role: 'user', content: toolResults });

    if (cost.exceeded()) {
      cost.flush();
      logger.warn(`[ai] claim-intake hit token ceiling for token ${token}`);
      working.push({
        role: 'assistant',
        content: [{ type: 'text', text: "Let's pause here — please continue in a moment." }],
      });
      return { messages: working, reply: "Let's pause here — please continue in a moment.", status, claimId };
    }
  }

  // Safety net: ran out of tool rounds without a final text turn.
  cost.flush();
  return {
    messages: working,
    reply: 'Sorry, something went wrong on my side. Could you repeat that?',
    status,
    claimId,
  };
}

module.exports = { runClaimIntake, buildSystem };
