import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');
export const MODEL = JSON.parse(readFileSync(path.join(here, 'semantic-model.json'), 'utf8'));
export const MODELS_ROOT = process.env.BRANDPROOF_MODEL_DIR || path.join(ROOT, '.cache', 'models');
export const MODEL_DIR = path.join(MODELS_ROOT, ...MODEL.id.split('/'));
