/**
 * Contextual-AI provider adapter contract.
 *
 * Milestone 1 ships NO working provider: BrandProof runs in rules mode and says so.
 * This module defines what a provider must look like so a real one (a local model, or a
 * hosted API if keys ever exist) can be added later without touching the review pipeline.
 * Nothing here simulates AI output.
 */

export const AI_PROVIDER_CONTRACT = Object.freeze({
  version: 1,
  provider: {
    id: 'string, short stable id',
    status: "'unconfigured' | 'ready' | 'error'",
    describe: '() => { id, status, label, message }',
    review: '(request) => Promise<{ findings: Finding[] }>; must reject when status !== "ready"',
  },
  request: {
    text: 'campaign copy (string)',
    alt: 'image alt text (string)',
    guidelines: 'the guideline version object being reviewed against',
    ruleFindings: 'deterministic findings already produced, so the provider does not duplicate them',
  },
  finding: {
    requirements: [
      'provenance must be "ai" so the UI can label it separately from rule findings',
      'status is "violation" | "unverified"; an AI provider may never mark a claim "contradicted" or "supported" without citing an approved fact id',
      'any evidence must cite real guideline ids; invented citations are rejected by the validator',
      'suggestions are advisory: a person applies or dismisses each one',
    ],
  },
});

export class AiUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'AI_UNAVAILABLE';
  }
}

export function createUnconfiguredProvider() {
  return Object.freeze({
    id: 'none',
    status: 'unconfigured',
    describe() {
      return {
        id: 'none',
        status: 'unconfigured',
        label: 'Contextual AI unavailable',
        message: 'No AI provider is configured. Findings come from deterministic rules only.',
      };
    },
    async review() {
      throw new AiUnavailableError('No AI provider is configured.');
    },
  });
}

export function validateProvider(p) {
  const problems = [];
  if (!p || typeof p !== 'object') return ['provider must be an object'];
  if (typeof p.id !== 'string' || !p.id) problems.push('id must be a non-empty string');
  if (!['unconfigured', 'ready', 'error'].includes(p.status)) problems.push('status must be unconfigured, ready or error');
  if (typeof p.describe !== 'function') problems.push('describe() is required');
  if (typeof p.review !== 'function') problems.push('review() is required');
  return problems;
}

export function describeEngine(provider = createUnconfiguredProvider()) {
  const problems = validateProvider(provider);
  const info = problems.length
    ? { id: 'invalid', status: 'error', label: 'AI provider invalid', message: problems.join('; ') }
    : provider.describe();
  // The review pipeline does not call providers in milestone 1, so contextual AI is never
  // reported as available, whatever a provider claims.
  return {
    mode: 'rules',
    label: 'Rules mode',
    contextualAi: {
      available: false,
      status: info.status,
      message: 'Contextual AI review is unavailable. Findings come from deterministic rules only.',
    },
  };
}
