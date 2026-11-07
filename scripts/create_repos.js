#!/usr/bin/env node

import { parseCli, resolveToken, runIfMain } from './lib/cli.js';
import { defaultConfigPath, loadYaml } from './lib/config.js';
import { createGitHub, createOctokit } from './lib/github.js';
import { createLogger } from './lib/logger.js';
import { createPlan } from './lib/plan.js';

const MANAGED_SECURITY_CONFIG = 'ospo-managed';
const CUSTOM_SECURITY_CONFIG = 'custom';
const MANAGED_RULESET = 'ospo-managed';

// ── Config ────────────────────────────────────────────────────────────────────

const REPO_NAME_RE = /^[a-z0-9.-]+$/;
const TEAM_NAME_RE = /^[a-zA-Z0-9\s._-]+$/;
const VALID_REPO_KEYS = new Set(['name', 'security', 'branch-protection', 'access']);
const VALID_ACCESS_KEYS = new Set(['team', 'role']);
const VALID_ROLES = ['own', 'write', 'triage'];
const MANAGED_OR_CUSTOM = ['managed', 'custom'];

function rejectUnknownKeys(object, validKeys, where) {
  for (const key of Object.keys(object)) {
    if (!validKeys.has(key)) {
      throw new Error(`Unknown field '${key}' in ${where}. Valid fields: ${[...validKeys].join(', ')}`);
    }
  }
}

function validateAccessEntry(entry, repoName) {
  rejectUnknownKeys(entry, VALID_ACCESS_KEYS, `access entry in repo '${repoName}'`);
  if (!entry.team) {
    throw new Error(`Access entry missing required field: team in repo '${repoName}'`);
  }
  if (!TEAM_NAME_RE.test(entry.team) || entry.team.length > 64) {
    throw new Error(`Invalid team name: '${entry.team}'. Must match ^[a-zA-Z0-9\\s._-]+$ (max 64 chars)`);
  }
  entry.role = entry.role ?? 'own';
  if (!VALID_ROLES.includes(entry.role)) {
    throw new Error(
      `Invalid role '${entry.role}' for team '${entry.team}' in repo '${repoName}'. Must be one of: ${VALID_ROLES.join(', ')}`,
    );
  }
}

function validateRepo(repo) {
  if (!repo.name) {
    throw new Error('Repository entry missing required field: name');
  }
  if (!REPO_NAME_RE.test(repo.name) || repo.name.length > 64) {
    throw new Error(`Invalid repository name: '${repo.name}'. Must match ^[a-z0-9.-]+$ (max 64 chars)`);
  }
  rejectUnknownKeys(repo, VALID_REPO_KEYS, `repo '${repo.name}'`);

  for (const field of ['security', 'branch-protection']) {
    repo[field] = repo[field] ?? 'managed';
    if (!MANAGED_OR_CUSTOM.includes(repo[field])) {
      throw new Error(`Invalid ${field} value '${repo[field]}' for repo '${repo.name}'. Must be 'managed' or 'custom'`);
    }
  }

  repo.access = repo.access ?? [];
  for (const entry of repo.access) validateAccessEntry(entry, repo.name);
}

export async function loadConfig(configPath) {
  const config = await loadYaml(configPath);
  if (!config || !Array.isArray(config.repositories)) {
    throw new Error(`Config missing required field: repositories (in ${configPath})`);
  }
  for (const repo of config.repositories) validateRepo(repo);
  return config;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const listOrNone = items => [...items].join(', ') || '(none)';
const sortedOrNone = items => listOrNone([...items].sort());
const quoted = names => names.map(n => `'${n}'`).join(', ');

// Map config role names to the GitHub API permission string.
// 'own' is a custom org role whose API name is 'Own' (capital O).
// 'write' maps to GitHub's legacy 'push' permission name.
export function toApiRole(role) {
  if (role === 'own') return 'Own';
  if (role === 'write') return 'push';
  return role;
}

// Map GitHub API role_name values back to config role names.
// Without this, every 'write' repo would look changed on every run ('push' !== 'write').
export function fromApiRole(roleName) {
  const r = roleName?.toLowerCase() ?? '';
  if (r === 'push') return 'write';
  return r; // 'own', 'triage' already match config names after lowercasing
}

// ── Repository management ─────────────────────────────────────────────────────

/** Creates the configured repositories that don't exist yet. Returns the created repos (none in dry-run). */
export async function createRepositories({ gh, plan, logger, org, config, existingRepos }) {
  const existingNames = new Set(existingRepos.map(r => r.name));
  const desiredNames = config.repositories.map(r => r.name);

  logger.debug('  Existing repos:', sortedOrNone(existingNames));
  logger.debug('  Desired repos: ', listOrNone(desiredNames));
  logger.debug('');

  const created = [];
  for (const name of desiredNames.filter(n => !existingNames.has(n))) {
    const repo = await plan.step(`  + Create '${name}'`, () => gh.createRepo(org, name));
    if (repo) created.push(repo);
  }
  return created;
}

// ── Team management ───────────────────────────────────────────────────────────

/** Map<teamName, Map<repoName, role>> from the access entries. 'own' becomes 'maintain' with skipCustomRole. */
export function buildDesiredTeamRepos(config, { skipCustomRole = false } = {}) {
  const desired = new Map();
  for (const repo of config.repositories) {
    for (const entry of repo.access ?? []) {
      if (!desired.has(entry.team)) desired.set(entry.team, new Map());
      const role = entry.role === 'own' && skipCustomRole ? 'maintain' : entry.role;
      desired.get(entry.team).set(repo.name, role);
    }
  }
  return desired;
}

export function diffTeams(desiredNames, existingNames) {
  const desired = new Set(desiredNames);
  const existing = new Set(existingNames);
  return {
    toAdd: [...desired].filter(n => !existing.has(n)),
    toUpdate: [...desired].filter(n => existing.has(n)),
    toDelete: [...existing].filter(n => !desired.has(n)),
  };
}

/** Compares Map<repo, role> of desired vs. current access of one team. */
export function diffTeamRepos(desiredRepos, currentRepos) {
  return {
    toGrant: [...desiredRepos].filter(([repo]) => !currentRepos.has(repo)),
    toUpdate: [...desiredRepos]
      .filter(([repo, role]) => currentRepos.has(repo) && currentRepos.get(repo) !== role)
      .map(([repo, role]) => [repo, currentRepos.get(repo), role]),
    toRevoke: [...currentRepos.keys()].filter(repo => !desiredRepos.has(repo)),
  };
}

/** The one Entra ID group whose name is exactly `name`; throws if there is none or more than one. */
export async function findEntraGroup(gh, org, name) {
  const groups = await gh.searchTeamSyncGroups(org, name);
  const exact = groups.filter(g => g.group_name === name);
  if (exact.length === 0) {
    throw new Error(`No Entra ID group with name '${name}' found`);
  }
  if (exact.length > 1) {
    throw new Error(`More than one Entra ID group with name '${name}' found`);
  }
  return exact[0];
}

const grantLabel = (teamName, repo, role) => `  + Grant ${role}: '${teamName}' on '${repo}'`;

async function addTeam({ gh, plan, org, skipTeamSync }, teamName, repos) {
  // Validate the Entra ID group before creating the team, so a typo doesn't leave an unsynced team behind
  const group = skipTeamSync || plan.dryRun ? null : await findEntraGroup(gh, org, teamName);

  const team = await plan.step(`  + Create team '${teamName}'`, () => gh.createTeam(org, teamName));
  if (!skipTeamSync) {
    await plan.step(`  + Sync '${teamName}' with Entra ID group '${teamName}'`, () =>
      gh.setTeamSyncGroups(org, team.slug, [
        { group_id: group.group_id, group_name: group.group_name, group_description: group.group_description ?? '' },
      ]),
    );
  }
  for (const [repo, role] of repos) {
    await plan.step(grantLabel(teamName, repo, role), () => gh.setTeamRepoPermission(org, team.slug, repo, toApiRole(role)));
  }
}

async function updateTeam({ gh, plan, logger, org }, team, desiredRepos) {
  const currentList = await gh.listTeamRepos(org, team.slug);
  const currentRepos = new Map(currentList.map(r => [r.name, fromApiRole(r.role_name)]));
  const { toGrant, toUpdate, toRevoke } = diffTeamRepos(desiredRepos, currentRepos);

  if (toGrant.length > 0 || toRevoke.length > 0 || toUpdate.length > 0) {
    const parts = [`current repos: ${sortedOrNone(currentRepos.keys())}`, `desired: ${sortedOrNone(desiredRepos.keys())}`];
    if (toGrant.length > 0) parts.push(`+ grant: ${toGrant.map(([r]) => r).join(', ')}`);
    if (toRevoke.length > 0) parts.push(`- revoke: ${toRevoke.join(', ')}`);
    if (toUpdate.length > 0) parts.push(`~ update: ${toUpdate.map(([r]) => r).join(', ')}`);
    logger.debug(`  Team '${team.name}' — ${parts.join(' | ')}`);
  }

  for (const [repo, role] of toGrant) {
    await plan.step(grantLabel(team.name, repo, role), () => gh.setTeamRepoPermission(org, team.slug, repo, toApiRole(role)));
  }
  for (const [repo, currentRole, role] of toUpdate) {
    await plan.step(`  ~ Update ${currentRole}→${role}: '${team.name}' on '${repo}'`, () =>
      gh.setTeamRepoPermission(org, team.slug, repo, toApiRole(role)),
    );
  }
  for (const repo of toRevoke) {
    await plan.step(`  - Revoke: '${team.name}' on '${repo}'`, () => gh.removeTeamRepo(org, team.slug, repo));
  }
}

/** Creates, updates and deletes teams so they match the access entries of the config. */
export async function processTeams(ctx) {
  const { gh, plan, logger, org, config, skipCustomRole = false } = ctx;
  const desiredTeamRepos = buildDesiredTeamRepos(config, { skipCustomRole });
  const existingTeams = new Map((await gh.listTeams(org)).map(t => [t.name, t]));
  const { toAdd, toUpdate, toDelete } = diffTeams(desiredTeamRepos.keys(), existingTeams.keys());

  logger.debug('  Existing teams:', sortedOrNone(existingTeams.keys()));
  logger.debug('  Desired teams: ', listOrNone(desiredTeamRepos.keys()));
  for (const teamName of toAdd) {
    logger.debug(`  Team '${teamName}' — desired repos: ${listOrNone(desiredTeamRepos.get(teamName).keys())}`);
  }
  logger.debug('');

  for (const teamName of toAdd) await addTeam(ctx, teamName, desiredTeamRepos.get(teamName));
  for (const teamName of toUpdate) await updateTeam(ctx, existingTeams.get(teamName), desiredTeamRepos.get(teamName));
  for (const teamName of toDelete) {
    await plan.step(`  - Delete team '${teamName}'`, () => gh.deleteTeam(org, existingTeams.get(teamName).slug));
  }
}

// ── Security configuration ────────────────────────────────────────────────────

/**
 * Repositories that must be attached to the managed or the custom security configuration.
 * Repos missing from repoIds (not created yet) are skipped.
 */
export function diffSecurityAssignments(config, { managedAssigned, customAssigned, repoIds }) {
  const toManaged = [];
  const toCustom = [];
  for (const repo of config.repositories) {
    const id = repoIds.get(repo.name);
    if (id === undefined) continue;
    if (repo.security === 'managed') {
      if (!managedAssigned.has(repo.name)) toManaged.push({ name: repo.name, id });
    } else if (!customAssigned.has(repo.name)) {
      toCustom.push({ name: repo.name, id });
    }
  }
  return { toManaged, toCustom };
}

export async function enforceSecurityConfig({ gh, plan, logger, org, config, orgRepos }) {
  const configs = await gh.listSecurityConfigs(org);
  const managedCfg = configs.find(c => c.name === MANAGED_SECURITY_CONFIG);
  const customCfg = configs.find(c => c.name === CUSTOM_SECURITY_CONFIG);
  if (!managedCfg) throw new Error(`Security configuration '${MANAGED_SECURITY_CONFIG}' not found in org ${org}`);
  if (!customCfg) throw new Error(`Security configuration '${CUSTOM_SECURITY_CONFIG}' not found in org ${org}`);

  // Items nest the repo under `.repository`; fall back to a flat shape defensively
  const assignedNames = async cfg => new Set((await gh.listSecurityConfigRepos(org, cfg.id)).map(r => r.repository?.name ?? r.name));
  const [managedAssigned, customAssigned] = await Promise.all([assignedNames(managedCfg), assignedNames(customCfg)]);

  const repoIds = new Map(orgRepos.map(r => [r.name, r.id]));
  const { toManaged, toCustom } = diffSecurityAssignments(config, { managedAssigned, customAssigned, repoIds });

  logger.debug('  Existing ospo-managed:', sortedOrNone(managedAssigned));
  logger.debug('  Existing custom:      ', sortedOrNone(customAssigned));
  logger.debug('  Desired ospo-managed: ', listOrNone(config.repositories.filter(r => r.security === 'managed').map(r => r.name)));
  logger.debug('  Desired custom:       ', listOrNone(config.repositories.filter(r => r.security !== 'managed').map(r => r.name)));
  logger.debug('');

  for (const [cfg, repos] of [[managedCfg, toManaged], [customCfg, toCustom]]) {
    if (repos.length === 0) continue;
    await plan.step(`  + Assign to '${cfg.name}': ${quoted(repos.map(r => r.name))}`, () =>
      gh.attachSecurityConfig(org, cfg.id, repos.map(r => r.id)),
    );
  }
}

// ── Branch protection ─────────────────────────────────────────────────────────

/** Compares the ruleset's target repository IDs with the desired ones. */
export function diffRulesetTargets(desiredIds, currentIds) {
  const current = new Set(currentIds);
  const desired = new Set(desiredIds);
  const added = [...desired].filter(id => !current.has(id));
  const removed = [...current].filter(id => !desired.has(id));
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

export async function enforceBranchProtection({ gh, plan, logger, org, config, orgRepos }) {
  const desiredNames = config.repositories.filter(r => r['branch-protection'] === 'managed').map(r => r.name);
  const repoIds = new Map(orgRepos.map(r => [r.name, r.id]));
  const idToName = new Map(orgRepos.map(r => [r.id, r.name]));
  const nameOf = id => idToName.get(id) ?? id;

  // Repos not created yet are skipped
  const desiredIds = desiredNames.filter(n => repoIds.has(n)).map(n => repoIds.get(n)).sort((a, b) => a - b);

  const ruleset = (await gh.listOrgRulesets(org)).find(r => r.name === MANAGED_RULESET);
  if (!ruleset) throw new Error(`Org ruleset '${MANAGED_RULESET}' not found in org ${org}`);
  const full = await gh.getOrgRuleset(org, ruleset.id);
  const currentIds = (full.conditions?.repository_id?.repository_ids ?? []).slice().sort((a, b) => a - b);

  logger.debug('  Existing targets:', currentIds.map(nameOf).join(', ') || '(none)');
  logger.debug('  Desired targets: ', listOrNone(desiredNames));
  logger.debug('');

  const { added, removed, changed } = diffRulesetTargets(desiredIds, currentIds);
  if (!changed) return;

  const lines = [];
  if (added.length > 0) lines.push(`  + Assign to 'ospo-managed': ${quoted(added.map(nameOf))}`);
  if (removed.length > 0) lines.push(`  + Assign to 'custom': ${quoted(removed.map(nameOf))}`);

  // Update only the target list — send only writable fields to avoid schema conflicts
  await plan.step(lines.join('\n'), () =>
    gh.updateOrgRuleset(org, ruleset.id, {
      name: full.name,
      target: full.target,
      enforcement: full.enforcement,
      bypass_actors: full.bypass_actors,
      conditions: { ref_name: full.conditions?.ref_name, repository_id: { repository_ids: desiredIds } },
      rules: full.rules,
    }),
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function run({ argv = [], env = {}, logger, github } = {}) {
  const { org, configPath, dryRun, debug, skipTeamSync, skipCustomRole } = parseCli(argv, {
    defaultConfigPath: defaultConfigPath('create_repos'),
    flags: ['skip-team-sync', 'skip-custom-role'],
  });
  const gh = github ?? createGitHub(createOctokit(resolveToken(env)));
  const log = logger ?? createLogger({ debug });
  const config = await loadConfig(configPath);
  const plan = createPlan({ dryRun, logger: log });
  const ctx = { gh, plan, logger: log, org, config, skipTeamSync, skipCustomRole };

  const section = async (title, fn) => {
    log.info(title);
    const before = plan.changeCount;
    await fn();
    if (plan.changeCount === before) log.info('  · No changes');
  };

  let orgRepos = await gh.listOrgRepos(org, { type: 'public' });
  await section('REPOSITORIES', async () => {
    const created = await createRepositories({ ...ctx, existingRepos: orgRepos });
    orgRepos = [...orgRepos, ...created];
  });
  log.info('');
  await section('TEAMS', () => processTeams(ctx));
  log.info('');
  await section('SECURITY', () => enforceSecurityConfig({ ...ctx, orgRepos }));
  log.info('');
  await section('BRANCH PROTECTION', () => enforceBranchProtection({ ...ctx, orgRepos }));

  if (dryRun) {
    log.info('');
    log.info('──── Dry-run: no changes were made ────');
  }
  return 0;
}

runIfMain(import.meta.url, run);
