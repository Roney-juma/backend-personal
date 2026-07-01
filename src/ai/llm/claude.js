/**
 * Single entry point for all Claude / Anthropic calls.
 *
 * Everything that talks to the model goes through here so model selection,
 * prompt caching, max_tokens ceilings and cost logging stay in one place.
 */
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../middlewheres/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Reasoning / orchestration model. Kept in env so it can be tuned without a deploy.
const AGENT_MODEL = process.env.ANTHROPIC_MODEL_AGENT || 'claude-opus-4-8';

/**
 * Run one model turn.
 *
 * @param {Object}   opts
 * @param {string}   opts.system     Stable system prompt (cached as a prefix).
 * @param {Array}    opts.messages   Anthropic-format message array.
 * @param {Array}    [opts.tools]    Tool definitions.
 * @param {Object}   [opts.toolChoice] Anthropic tool_choice (e.g. force a tool).
 * @param {string}   [opts.model]    Override the model id.
 * @param {number}   [opts.maxTokens]
 * @returns the raw Anthropic message response.
 */
const complete = async ({ system, messages, tools, toolChoice, model, maxTokens = 1024 }) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  // Wrap the system prompt in a cacheable block so the (large, stable) prefix
  // is billed at ~0.1x on repeat turns within a conversation.
  const systemBlocks = system
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : undefined;

  const response = await client.messages.create({
    model: model || AGENT_MODEL,
    max_tokens: maxTokens,
    ...(systemBlocks ? { system: systemBlocks } : {}),
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  });

  if (response.usage) {
    const u = response.usage;
    logger.info(
      `[ai] ${response.model} in=${u.input_tokens} out=${u.output_tokens} ` +
      `cacheRead=${u.cache_read_input_tokens || 0} cacheWrite=${u.cache_creation_input_tokens || 0}`
    );
  }

  return response;
};

module.exports = { client, complete, AGENT_MODEL };
