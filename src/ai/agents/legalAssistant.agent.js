/**
 * The AI legal assistant.
 *
 * A read-only, stateless Claude tool-use agent that answers a legal officer's
 * questions from live data. Same shape as the front-office staff assistant: the
 * caller passes the full message history each turn and gets the updated history
 * back to persist.
 *
 * Spec §19 draws the line and this implementation holds it in three places
 * rather than one:
 *
 *   - the TOOLS are read-only, so there is nothing to write with;
 *   - the SYSTEM PROMPT forbids advice and approval in plain terms;
 *   - the RESPONSE is labelled as a draft attributed to the officer who
 *     accepted it, so nothing the model produces can be mistaken for a decision.
 *
 * The model is genuinely useful here — summarising, arranging chronologies,
 * spotting a missing document — and genuinely unsuited to deciding what a claim
 * is worth or whether to settle. The prompt says so directly, because a model
 * asked to be helpful will otherwise oblige.
 */
const { complete } = require('../llm/claude');
const { TOOLS, executeTool } = require('./legalAssistant.tools');
const logger = require('../../middlewheres/logger');
const { FEATURES } = require('../features');

const MAX_TOOL_ROUNDS = 6;

const KNOWLEDGE = `
HOW THIS MODULE IS ORGANISED

- A CLAIM is the accident. It carries the insured's own damage.
- A THIRD-PARTY CLAIM (reference TPC-…) is ONE person claiming against the
  insured — injury, death or property damage. One accident routinely produces
  several, each with its own fault share, valuation, reserve and statutory
  clock. This is the register the legal team works from day to day.
- A LEGAL CASE (reference LEG-…) is one court file. It exists only once a suit
  is filed; most third-party claims settle without one. A single suit can cover
  several third-party claimants.
- A SETTLEMENT runs draft → pending approval → approved → accepted → executed →
  paid. "Approved" means the insurer may OFFER it; "accepted" means the claimant
  took it. They are not the same thing.
- A RECOVERY is the mirror image: the insurer claiming against whoever was
  actually at fault.

HOW EXPOSURE IS CALCULATED
  gross quantum → apportioned by the insured's share of fault → capped at the
  policy limit for that head (bodily injury and property damage are limited
  separately). Anything above the limit falls on the insured personally.

LIMITATION
  Every third-party claim carries a statutory clock from the accident date. Once
  it expires the claim can no longer be brought. Periods are configured per
  insurer, so never state one from memory — read it off the claim.
`.trim();

function buildSystem(user) {
  const who = user?.fullName || user?.email || 'a legal officer';
  return [
    `You are AVICS's legal assistant, helping ${who} work through third-party liability matters for one insurer.`,
    ``,
    `WHAT YOU ARE FOR`,
    `- Summarising a matter, a demand or a set of pleadings.`,
    `- Arranging what is already recorded into a chronology.`,
    `- Pointing out what is missing from a file, or what is due soon.`,
    `- Comparing a demand against our assessed exposure and reserve.`,
    `- Surfacing comparable settled claims so the officer can judge value themselves.`,
    ``,
    `WHAT YOU ARE NOT FOR`,
    `- You do not give legal advice. You have no view on whether to defend, settle or appeal.`,
    `- You do not approve settlements, authorise payments or set reserves. You cannot: you have no tool that writes.`,
    `- You do not decide what a claim is worth. You may report what similar claims settled at, always with the number of comparables, and leave the valuation to the officer.`,
    `- You do not state limitation periods, authority limits or reserving figures from general knowledge. They are configured per insurer — read them from the data or say you would need to check.`,
    ``,
    `HOW TO ANSWER`,
    `- For anything about a specific matter, claimant, date or figure, CALL A TOOL and answer only from what it returns.`,
    `- Never invent a reference number, a date, an amount or a party. If a tool returns nothing, say so plainly.`,
    `- Quote the reference (TPC-…, LEG-…) so the officer can open the record and check you.`,
    `- Where a tool returns a caveat about sample size, repeat it. A median from three matters is not a valuation.`,
    `- Money comes back formatted (KSh …). Use it as given; do not recompute or convert it.`,
    `- Be concise and precise. This is a professional working with you, not an audience.`,
    `- If asked to do something you are not for, say so in one sentence and point to who does it — the Legal Officer, the authority matrix, or counsel.`,
    ``,
    `=== HOW THIS MODULE IS ORGANISED ===`,
    KNOWLEDGE,
  ].join('\n');
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * Run one turn of the assistant.
 *
 * @param {Object} params
 * @param {Object} params.user         req.user — the legal officer
 * @param {*}      params.company      tenant id; every tool is scoped to it
 * @param {Array}  params.messages     prior Anthropic-format history (may be [])
 * @param {string} params.userMessage  this turn's question
 * @returns {Promise<{ messages: Array, reply: string, toolsUsed: string[] }>}
 */
async function ask({ user, company, messages = [], userMessage }) {
  if (!company) {
    throw new Error('The legal assistant needs an insurer context');
  }

  const system = buildSystem(user);
  const history = [...messages, { role: 'user', content: userMessage }];
  const toolsUsed = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await complete({
      system,
      messages: history,
      tools: TOOLS,
      maxTokens: 2048,
      meta: {
        feature: FEATURES.LEGAL_ASSISTANT,
        userId: user?._id || user?.id,
        company,
      },
    });

    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return { messages: history, reply: textOf(response.content), toolsUsed };
    }

    const calls = response.content.filter((b) => b.type === 'tool_use');

    // Every result goes back in ONE user message. Splitting them across several
    // teaches the model to stop making parallel calls.
    const results = await Promise.all(
      calls.map(async (call) => {
        toolsUsed.push(call.name);
        try {
          // The tenant is passed from the session, never from the model's input
          // — otherwise a prompt injection could read another insurer's book.
          const result = await executeTool(call.name, call.input, { company });
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          logger.error(`[legal-assistant] tool ${call.name} failed: ${err.message}`);
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          };
        }
      })
    );

    history.push({ role: 'user', content: results });
  }

  // Ran out of rounds. Say so rather than returning a half-formed answer as if
  // it were complete.
  logger.warn(`[legal-assistant] hit the ${MAX_TOOL_ROUNDS}-round tool limit`);
  return {
    messages: history,
    reply:
      'I could not finish working that out within my limit for looking things up. ' +
      'Try narrowing the question — a single matter or a single reference usually resolves it.',
    toolsUsed,
  };
}

module.exports = { ask, TOOLS, buildSystem };
