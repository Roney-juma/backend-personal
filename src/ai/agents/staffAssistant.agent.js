/**
 * Front-office staff assistant.
 *
 * A read-only, stateless Claude (Haiku) tool-use agent that answers staff
 * questions from live data (tools) and a knowledge base. The caller passes the
 * full message history each turn and gets the updated history back to persist.
 */
const { complete } = require('../llm/claude');
const { CostTracker } = require('../llm/cost');
const { TOOLS, executeTool } = require('./staffAssistant.tools');
const { STAFF_KNOWLEDGE_BASE } = require('../kb/staffKnowledgeBase');
const logger = require('../../middlewheres/logger');
const { FEATURES } = require('../features');

const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5';
const MAX_TOOL_ROUNDS = 6;

function buildSystem(user) {
  const who = user?.fullName || user?.email || 'a staff member';
  return [
    `You are AVE / AVICS's front-office staff assistant, helping ${who} get quick answers about the claims platform.`,
    ``,
    `HOW TO ANSWER`,
    `- For "how/what/why" process questions (statuses, bidding, self-repair, glass, fraud), answer from the KNOWLEDGE BASE below — no tool call needed.`,
    `- For questions about specific data (a claim's status, counts, customers, assessors, garages, suppliers, investigations), CALL THE RIGHT TOOL and answer only from its result.`,
    `- Never invent data, IDs, numbers, or statuses. If a tool returns nothing or errors, say so plainly.`,
    `- Cite concrete values (claim IDs, counts, names) from tool results. Keep answers concise and professional.`,
    `- You are READ-ONLY: you cannot create, change, approve, or delete anything. If asked to, explain that and point the user to the relevant screen.`,
    `- Billing, subscriptions, company accounts and audit logs are out of scope — say you don't have access to those.`,
    ``,
    `=== KNOWLEDGE BASE ===`,
    STAFF_KNOWLEDGE_BASE,
  ].join('\n');
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * @param {Object} params
 * @param {Object} params.user        req.user (staff identity)
 * @param {Array}  params.messages    prior Anthropic-format history (may be [])
 * @param {string} params.userMessage new question this turn
 * @returns {Object} { messages, reply }
 */
async function runStaffAssistant({ user, messages = [], userMessage }) {
  const system = buildSystem(user);
  const working = [...messages, { role: 'user', content: userMessage }];
  const cost = new CostTracker(FEATURES.STAFF_ASSISTANT);
  const usageMeta = {
    feature: FEATURES.STAFF_ASSISTANT,
    userId: user && (user.id || user._id),
    sessionKey: user && (user.id || user._id) ? `staff:${user.id || user._id}` : undefined,
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await complete({ system, messages: working, tools: TOOLS, model: FAST_MODEL, maxTokens: 1024, meta: usageMeta });
    cost.record(response);
    working.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      cost.flush();
      return { messages: working, reply: textOf(response.content) };
    }

    const toolResults = [];
    for (const blk of response.content.filter((b) => b.type === 'tool_use')) {
      const result = await executeTool(blk);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: blk.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
    }
    working.push({ role: 'user', content: toolResults });

    if (cost.exceeded()) {
      cost.flush();
      logger.warn(`[ai] staff-assistant hit token ceiling for ${user?.email || 'staff'}`);
      const msg = 'That question is taking a lot of lookups — could you narrow it down?';
      working.push({ role: 'assistant', content: [{ type: 'text', text: msg }] });
      return { messages: working, reply: msg };
    }
  }

  cost.flush();
  const msg = "I couldn't complete that — please try rephrasing or asking something more specific.";
  return { messages: working, reply: msg };
}

module.exports = { runStaffAssistant, buildSystem };
