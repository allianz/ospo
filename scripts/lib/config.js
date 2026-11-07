import yaml from 'js-yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the ospo repository (parent of scripts/). */
export const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Default production config path for a tool: <repo>/config/<name>.yaml */
export function defaultConfigPath(name) {
  return path.join(repoRoot, 'config', `${name}.yaml`);
}

/** Reads and parses a YAML file. An empty file yields null. */
export async function loadYaml(configPath) {
  const raw = await readFile(configPath, 'utf8');
  return yaml.load(raw) ?? null;
}

/** Throws if any of the fields is missing, empty, or an empty list. */
export function requireFields(config, fields, configPath) {
  for (const field of fields) {
    const value = config?.[field];
    if (!value || (Array.isArray(value) && value.length === 0)) {
      throw new Error(`Config missing required field: ${field} (in ${configPath})`);
    }
  }
}
