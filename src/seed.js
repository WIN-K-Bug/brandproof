/**
 * Seed data. Everything here is FICTIONAL: the brand "Fernlight", its product, its guideline
 * documents and its campaigns are invented for this demo and refer to no real company.
 */
import { emptyState } from './store.js';
import { guidelineHash, bindingFor, createSubmission, addRevision, requestReview, decide, addComment, currentVersion } from './service.js';
import { validateGuidelines, assignIds, validateContent } from './validate.js';

const src = (doc, section, quote) => ({ doc, section, quote });
const NAMING = 'Fernlight Naming Guide (fictional)';
const VOICE = 'Fernlight Voice & Tone Guide (fictional)';
const FACTS = 'Aurora Lamp Fact Sheet v3 (fictional)';

export const seedGuidelines = () => ({
  brand: {
    name: 'Fernlight',
    fictional: true,
    summary: 'Fictional demo brand: calm, honest lighting for readers. All documents and facts here are invented.',
  },
  terms: [
    {
      kind: 'naming',
      preferred: 'Aurora Lamp',
      enforceCase: true,
      avoid: [
        { text: 'Aurora light', replacement: 'Aurora Lamp' },
        { text: 'AuroraLamp', replacement: 'Aurora Lamp' },
      ],
      reason: 'The product name is always written “Aurora Lamp”: two words, both capitalised.',
      severity: 'warning',
      source: src(NAMING, '2.1 Product names', 'The product is always written “Aurora Lamp”, two words, both capitalised.'),
    },
    {
      kind: 'naming',
      preferred: 'Fernlight',
      enforceCase: true,
      avoid: [{ text: 'Fern Light', replacement: 'Fernlight' }],
      reason: 'The company name is one word with a single capital.',
      severity: 'warning',
      source: src(NAMING, '1.2 Company name', 'Fernlight is one word. Never “Fern Light” or “FernLight”.'),
    },
    {
      kind: 'tone',
      preferred: '',
      enforceCase: false,
      avoid: [
        { text: 'cheapest', replacement: 'most affordable' },
        { text: 'cheap', replacement: 'affordable' },
      ],
      reason: 'We describe price as affordable, never cheap.',
      severity: 'warning',
      source: src(VOICE, '3.2 Talking about price', 'We say “affordable”, never “cheap”.'),
    },
    {
      kind: 'tone',
      preferred: '',
      enforceCase: false,
      avoid: [
        { text: 'revolutionary', replacement: null },
        { text: 'game-changer', replacement: null },
        { text: 'game changer', replacement: null },
      ],
      reason: 'Hype words are off-brand; say what the product does instead.',
      severity: 'warning',
      source: src(VOICE, '3.4 Hype words', 'Avoid hype words such as “revolutionary” or “game-changer”; describe what the product does instead.'),
    },
  ],
  facts: [
    {
      type: 'numeric',
      label: 'Battery life',
      statement: 'A full charge lasts up to 12 hours at medium brightness.',
      topicTerms: ['battery', 'charge', 'charged', 'runs for', 'run for', 'runtime', 'lasts', 'last'],
      unit: 'hours',
      unitAliases: ['hours', 'hour', 'hrs', 'hr'],
      value: 12,
      claimRule: 'at-most',
      conditions: ['at medium brightness'],
      conditionTerms: ['brightness'],
      source: src(FACTS, '4.1 Battery', 'Battery life: up to 12 hours at medium brightness.'),
    },
    {
      type: 'statement',
      label: 'Indoor use only',
      statement: 'Indoor use only; not waterproof or water resistant.',
      contradictedBy: ['waterproof', 'water-proof', 'water resistant', 'water-resistant', 'splash-proof'],
      confirmedBy: ['indoor use', 'for indoors'],
      source: src(FACTS, '4.4 Environment', 'Rated IP20. Indoor use only; not waterproof or water resistant.'),
    },
    {
      type: 'numeric',
      label: 'Recycled content',
      statement: 'The lamp body is 100% recycled aluminium.',
      topicTerms: ['recycled'],
      unit: '%',
      unitAliases: ['%', 'percent'],
      value: 100,
      claimRule: 'exact',
      source: src(FACTS, '2.3 Materials', 'Body: 100% recycled aluminium (lamp head and base).'),
    },
    {
      type: 'numeric',
      label: 'Warranty length',
      statement: 'The Aurora Lamp has a 2-year warranty.',
      topicTerms: ['warranty', 'warranted'],
      unit: 'years',
      unitAliases: ['years', 'year', 'yrs', 'yr'],
      value: 2,
      claimRule: 'exact',
      source: src(FACTS, '6.1 Warranty', 'Every Aurora Lamp carries a 2-year limited warranty.'),
    },
  ],
  palette: {
    tolerance: 10,
    source: src('Fernlight Visual Identity (fictional)', '1.1 Brand colours', 'Campaign imagery uses Ink Navy, Fern Teal, Warm Paper and Lamp Amber.'),
    colors: [
      { name: 'Ink Navy', hex: '#0F2A43' },
      { name: 'Fern Teal', hex: '#1B9C8F' },
      { name: 'Warm Paper', hex: '#F7F3EC' },
      { name: 'Lamp Amber', hex: '#F2A93B' },
    ],
  },
  accessibility: {
    minNormal: 4.5,
    minLarge: 3,
    source: src('Fernlight Accessibility Standard (fictional)', '2.1 Text contrast', 'Text must meet WCAG 2.x AA contrast: 4.5:1 for normal text, 3:1 for large text.'),
  },
  altText: {
    minLength: 20,
    source: src('Fernlight Accessibility Standard (fictional)', '3.1 Image alt text', 'Every campaign image needs alt text that describes what it shows.'),
  },
  claims: {
    signals: ['best', '#1', 'number one', "world's first", 'most popular', 'guaranteed', 'clinically proven', 'proven to', 'better than', 'faster than', 'never fails'],
    flagPercentages: true,
    source: src('Fernlight Claims Policy (fictional)', '5.1 Substantiation', 'Performance, comparative and statistical claims must be backed by an approved fact before publication.'),
  },
  style: {
    exclamation: {
      max: 1,
      source: src(VOICE, '2.3 Punctuation', 'Use at most one exclamation mark per piece, and never repeat it.'),
    },
  },
});

const expectedFor = (d, id) => bindingFor(d.submissions.find((s) => s.id === id).revisions.at(-1), currentVersion(d));

const asset = (a) => ({ name: '', alt: '', fileSha256: null, fg: null, bg: null, textSize: 'normal', colors: [], ...a });

/**
 * Workspace for authenticated mode: the fictional guideline set only, no sample submissions.
 * Demo submissions carry made-up "Demo Creator" actors; mixing them into an accountable audit trail would be misleading.
 */
export function seedAuthState(now = new Date().toISOString()) {
  const d = emptyState();
  d.meta = { mode: 'authenticated' };
  addInitialGuidelines(d, now, 'Initial fictional Fernlight guidelines (authenticated workspace).');
  return d;
}

function addInitialGuidelines(d, now, note) {
  const checked = validateGuidelines(seedGuidelines());
  if (checked.errors.length) throw new Error('Seed guidelines invalid: ' + JSON.stringify(checked.errors));
  const guidelines = assignIds(checked.value);
  d.guidelineVersions.push({ version: 1, createdAt: now, createdBy: 'BrandProof seed', note, hash: guidelineHash(guidelines), guidelines });
}

export function seedState(now = new Date().toISOString()) {
  const d = emptyState();

  const checked = validateGuidelines(seedGuidelines());
  if (checked.errors.length) throw new Error('Seed guidelines invalid: ' + JSON.stringify(checked.errors));
  const guidelines = assignIds(checked.value);
  d.guidelineVersions.push({
    version: 1,
    createdAt: now,
    createdBy: 'BrandProof demo seed',
    note: 'Initial fictional Fernlight guidelines.',
    hash: guidelineHash(guidelines),
    guidelines,
  });

  const content = (text, a) => {
    const v = validateContent({ text, asset: a });
    if (v.errors.length) throw new Error('Seed content invalid: ' + JSON.stringify(v.errors));
    return v.value;
  };

  // SUB-1: a draft with many problems, for the "fix and resubmit" walkthrough.
  createSubmission(d, {
    title: 'Aurora Lamp: spring launch hero',
    role: 'creator',
    now,
    ...content(
      "Meet the aurora lamp!!! The cheapest, best reading light ever, guaranteed to fix your sleep.\nA full charge lasts 30 hours, and it's totally waterproof. Includes a 5-year warranty. Join 10,000 happy readers today!",
      asset({ name: 'aurora-hero.png', alt: 'image', fg: '#9BB7B5', bg: '#FFFFFF', textSize: 'normal', colors: ['#0F2A43', '#FF00AA'] }),
    ),
  });
  addComment(d, { id: 'SUB-1', revision: 1, text: 'Seed note: first draft from the creator. Try the Apply buttons, then save a new revision.', ruleId: null, role: 'manager', now });

  // SUB-2: two revisions, the second clean and approved. A guideline change makes this approval stale.
  createSubmission(d, {
    title: 'Aurora Lamp: newsletter blurb',
    role: 'creator',
    now,
    ...content(
      'Meet the Aurora Light, a cheap way to read after dark. A full charge runs for 20 hours.',
      asset({ name: 'newsletter-banner.png', alt: 'banner', fg: '#0F2A43', bg: '#F7F3EC', textSize: 'normal', colors: ['#0F2A43', '#2EC4B6'] }),
    ),
  });
  addRevision(d, {
    id: 'SUB-2',
    baseRevision: 1,
    role: 'creator',
    now,
    ...content(
      'Meet the Aurora Lamp, a reading lamp made to be easy on the eyes. Its body is 100% recycled aluminium, and a full charge runs up to 12 hours. Designed for indoor use.',
      asset({
        name: 'newsletter-banner.png',
        alt: 'The Fernlight Aurora Lamp glowing beside an open book on a wooden shelf',
        fg: '#0F2A43',
        bg: '#F7F3EC',
        textSize: 'normal',
        colors: ['#0F2A43', '#1B9C8F'],
      }),
    ),
  });
  requestReview(d, { id: 'SUB-2', revision: 2, expected: expectedFor(d, 'SUB-2'), role: 'creator', now });
  decide(d, { id: 'SUB-2', decision: 'approved', revision: 2, expected: expectedFor(d, 'SUB-2'), note: 'Seed data: checked against guideline version 1.', acknowledgeWarnings: false, role: 'reviewer', now });

  // SUB-3: in review with only a warning, to show approval with acknowledgement.
  createSubmission(d, {
    title: 'Aurora Lamp: social post',
    role: 'creator',
    now,
    ...content(
      'Say hello to the Aurora Lamp. Our reading lamp is the best way to wind down.',
      asset({ name: 'social-square.png', alt: 'The Aurora Lamp on a bedside table next to a cup of tea', fg: '#0F2A43', bg: '#FFFFFF', textSize: 'large', colors: ['#F2A93B'] }),
    ),
  });
  requestReview(d, { id: 'SUB-3', revision: 1, expected: expectedFor(d, 'SUB-3'), role: 'creator', now });

  return d;
}

export { currentVersion };
