#!/usr/bin/env node

import { Octokit } from '@octokit/rest';
import yaml from 'js-yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.join(__dirname, '..');
const defaultConfigPath = path.join(repoRoot, 'config', 'create_repos.yaml');

// ── Config ────────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const raw = await readFile(configPath, 'utf8');
  const config = yaml.load(raw);

  if (!config || !Array.isArray(config.repositories)) {
    throw new Error(`Config missing required field: repositories (in ${configPath})`);
  }

  const repoNameRe = /^[a-z0-9.-]+$/;
  const teamNameRe = /^[a-zA-Z0-9\s._-]+$/;

  for (const repo of config.repositories) {
    if (!repo.name) {
      throw new Error(`Repository entry missing required field: name`);
    }
    if (!repoNameRe.test(repo.name) || repo.name.length > 64) {
      throw new Error(
        `Invalid repository name: '${repo.name}'. Must match ^[a-z0-9.-]+$ (max 64 chars)`
      );
    }

    repo.security = repo.security ?? 'managed';
    if (!['managed', 'custom'].includes(repo.security)) {
      throw new Error(
        `Invalid security value '${repo.security}' for repo '${repo.name}'. Must be 'managed' or 'custom'`
      );
    }

    repo['branch-protection'] = repo['branch-protection'] ?? 'managed';
    if (!['managed', 'custom'].includes(repo['branch-protection'])) {
      throw new Error(
        `Invalid branch-protection value '${repo['branch-protection']}' for repo '${repo.name}'. Must be 'managed' or 'custom'`
      );
    }

    repo.teams = repo.teams ?? [];

    for (const team of repo.teams) {
      if (!team.name) {
        throw new Error(`Team entry missing required field: name in repo '${repo.name}'`);
      }
      if (!teamNameRe.test(team.name) || team.name.length > 64) {
        throw new Error(
          `Invalid team name: '${team.name}'. Must match ^[a-zA-Z0-9\\s._-]+$ (max 64 chars)`
        );
      }
    }
  }

  return config;
}

// ── Repository management ─────────────────────────────────────────────────────

export async function createRepositories(octokit, org, config, opts = {}) {
  const { dryRun = false, debug = false } = opts;
  const actions = [];
  const planned = [];
  const skipped = [];

  const existingRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'public',
    per_page: 100,
  });

  const existingNames = new Set(existingRepos.map(r => r.name));
  const desiredNames = config.repositories.map(r => r.name);

  if (debug) {
    console.log('  Existing repos:', [...existingNames].sort().join(', ') || '(none)');
    console.log('  Desired repos:', desiredNames.join(', ') || '(none)');
  }

  const toCreate = desiredNames.filter(name => !existingNames.has(name));

  if (debug) {
    console.log('  To create:', toCreate.join(', ') || '(none)');
    console.log('');
  }

  for (const name of toCreate) {
    if (dryRun) {
      planned.push(`+ Create repository '${name}'`);
    } else {
      await octokit.rest.repos.createInOrg({
        org,
        name,
        visibility: 'public',
        auto_init: true,
      });
      actions.push(`Created repository '${name}' in ${org}`);
    }
  }

  for (const name of desiredNames.filter(name => existingNames.has(name))) {
    skipped.push(`Repository '${name}' already exists — skipped`);
  }

  return { actions, planned, skipped };
}

// ── Team management ───────────────────────────────────────────────────────────

async function validateEntraGroup(octokit, org, name) {
  const response = await octokit.request('GET /orgs/{org}/team-sync/groups', {
    org,
    q: name,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const groups = response.data.groups ?? [];
  const exact = groups.filter(g => g.group_name === name);
  if (exact.length === 0) {
    throw new Error(`No Entra ID group with name '${name}' found`);
  }
  if (exact.length > 1) {
    throw new Error(`More than one Entra ID group with name '${name}' found`);
  }
  return exact[0];
}

async function syncTeamWithEntra(octokit, org, teamSlug, group) {
  await octokit.request('PATCH /orgs/{org}/teams/{team_slug}/team-sync/group-mappings', {
    org,
    team_slug: teamSlug,
    groups: [
      {
        group_id: group.group_id,
        group_name: group.group_name,
        group_description: group.group_description ?? '',
      },
    ],
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
}

export async function processTeams(octokit, org, config, opts = {}) {
  const { dryRun = false, debug = false, skipTeamSync = false, skipCustomRole = false } = opts;
  const permission = skipCustomRole ? 'maintain' : 'Own';
  const actions = [];
  const planned = [];

  // Build desired team → repos mapping
  const desiredTeamRepos = new Map();
  for (const repo of config.repositories) {
    for (const team of repo.teams ?? []) {
      if (!desiredTeamRepos.has(team.name)) {
        desiredTeamRepos.set(team.name, new Set());
      }
      desiredTeamRepos.get(team.name).add(repo.name);
    }
  }

  const desiredTeamNames = new Set(desiredTeamRepos.keys());

  // Fetch existing teams
  const existingTeams = await octokit.paginate(octokit.rest.teams.list, {
    org,
    per_page: 100,
  });
  const existingTeamMap = new Map(existingTeams.map(t => [t.name, t]));
  const existingTeamNames = new Set(existingTeams.map(t => t.name));

  if (debug) {
    console.log('  Existing teams:', [...existingTeamNames].sort().join(', ') || '(none)');
    console.log('  Desired teams:', [...desiredTeamNames].join(', ') || '(none)');
    console.log('');
  }

  const teamsToAdd = [...desiredTeamNames].filter(n => !existingTeamNames.has(n));
  const teamsToUpdate = [...desiredTeamNames].filter(n => existingTeamNames.has(n));
  const teamsToDelete = [...existingTeamNames].filter(n => !desiredTeamNames.has(n));

  // Teams to add
  for (const teamName of teamsToAdd) {
    const reposForTeam = desiredTeamRepos.get(teamName) ?? new Set();

    if (dryRun) {
      planned.push(`+ Create team '${teamName}'`);
      if (!skipTeamSync) {
        planned.push(`+ Sync team '${teamName}' with Entra ID group '${teamName}'`);
      }
      for (const repo of reposForTeam) {
        planned.push(`+ Grant ${permission}: '${teamName}' → '${repo}'`);
      }
    } else {
      // Validate Entra ID group exists before creating team
      let entraGroup = null;
      if (!skipTeamSync) {
        entraGroup = await validateEntraGroup(octokit, org, teamName);
      }

      // Create team
      const createResult = await octokit.rest.teams.create({
        org,
        name: teamName,
        privacy: 'closed',
      });
      const newTeam = createResult.data;
      actions.push(`Created team '${teamName}' in ${org}`);
      existingTeamMap.set(teamName, newTeam);

      // Sync with Entra ID
      if (!skipTeamSync && entraGroup) {
        await syncTeamWithEntra(octokit, org, newTeam.slug, entraGroup);
        actions.push(`Team '${teamName}' synced with Entra ID group '${teamName}'`);
      }

      // Grant permissions on assigned repos
      for (const repo of reposForTeam) {
        await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
          org,
          team_slug: newTeam.slug,
          owner: org,
          repo,
          permission,
        });
        actions.push(`Team '${teamName}' granted ${permission} permission to '${repo}'`);
      }
    }
  }

  // Teams to update
  for (const teamName of teamsToUpdate) {
    const team = existingTeamMap.get(teamName);
    const desiredRepos = desiredTeamRepos.get(teamName) ?? new Set();

    const currentRepoList = await octokit.paginate(octokit.rest.teams.listReposInOrg, {
      org,
      team_slug: team.slug,
      per_page: 100,
    });
    const currentRepos = new Set(currentRepoList.map(r => r.name));

    const toGrant = [...desiredRepos].filter(r => !currentRepos.has(r));
    const toRevoke = [...currentRepos].filter(r => !desiredRepos.has(r));

    if (debug) {
      console.log(`  Team '${teamName}': grant [${toGrant.join(', ')}], revoke [${toRevoke.join(', ')}]`);
    }

    for (const repo of toGrant) {
      if (dryRun) {
        planned.push(`+ Grant ${permission}: '${teamName}' → '${repo}'`);
      } else {
        await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
          org,
          team_slug: team.slug,
          owner: org,
          repo,
          permission,
        });
        actions.push(`Team '${teamName}' granted ${permission} permission to '${repo}'`);
      }
    }

    for (const repo of toRevoke) {
      if (dryRun) {
        planned.push(`- Revoke ${permission}: '${teamName}' → '${repo}'`);
      } else {
        await octokit.rest.teams.removeRepoInOrg({
          org,
          team_slug: team.slug,
          owner: org,
          repo,
        });
        actions.push(`Team '${teamName}' removed ${permission} permission from '${repo}'`);
      }
    }
  }

  // Teams to delete
  for (const teamName of teamsToDelete) {
    const team = existingTeamMap.get(teamName);
    if (dryRun) {
      planned.push(`- Delete team '${teamName}'`);
    } else {
      await octokit.rest.teams.deleteInOrg({
        org,
        team_slug: team.slug,
      });
      actions.push(`Deleted team '${teamName}' from ${org}`);
    }
  }

  return { actions, planned };
}

// ── Security configuration ────────────────────────────────────────────────────

export async function enforceSecurityConfig(octokit, org, config, opts = {}) {
  const { dryRun = false, debug = false } = opts;
  const actions = [];
  const planned = [];

  // Look up org security configurations by name
  const cfgsResponse = await octokit.request(
    'GET /orgs/{org}/code-security/configurations',
    { org, headers: { 'X-GitHub-Api-Version': '2022-11-28' } }
  );
  const allCfgs = cfgsResponse.data;

  const ospoManaged = allCfgs.find(c => c.name === 'ospo-managed');
  const customCfg = allCfgs.find(c => c.name === 'custom');

  if (!ospoManaged) {
    throw new Error(`Security configuration 'ospo-managed' not found in org ${org}`);
  }
  if (!customCfg) {
    throw new Error(`Security configuration 'custom' not found in org ${org}`);
  }

  // Fetch current assignments for both configs
  const [ospoRepos, customRepos] = await Promise.all([
    octokit.paginate(
      'GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories',
      { org, configuration_id: ospoManaged.id, per_page: 100 }
    ),
    octokit.paginate(
      'GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories',
      { org, configuration_id: customCfg.id, per_page: 100 }
    ),
  ]);

  const ospoAssigned = new Set(ospoRepos.map(r => r.repository?.name ?? r.name));
  const customAssigned = new Set(customRepos.map(r => r.repository?.name ?? r.name));

  if (debug) {
    console.log('  ospo-managed:', [...ospoAssigned].sort().join(', ') || '(none)');
    console.log('  custom:', [...customAssigned].sort().join(', ') || '(none)');
    console.log('');
  }

  // Fetch org repos to get IDs
  const orgRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'public',
    per_page: 100,
  });
  const repoIdMap = new Map(orgRepos.map(r => [r.name, r.id]));

  const toAssignOspo = [];
  const toAssignCustom = [];

  for (const repo of config.repositories) {
    const repoId = repoIdMap.get(repo.name);
    if (repoId === undefined) continue; // repo not yet created

    if (repo.security === 'managed') {
      if (!ospoAssigned.has(repo.name)) {
        toAssignOspo.push({ name: repo.name, id: repoId });
      } else if (debug) {
        console.log(`  · '${repo.name}' already assigned to 'ospo-managed' — skipped`);
      }
    } else {
      if (!customAssigned.has(repo.name)) {
        toAssignCustom.push({ name: repo.name, id: repoId });
      } else if (debug) {
        console.log(`  · '${repo.name}' already assigned to 'custom' — skipped`);
      }
    }
  }

  for (const { name } of toAssignOspo) {
    planned.push(`+ Assign '${name}' to 'ospo-managed' security configuration`);
  }
  for (const { name } of toAssignCustom) {
    planned.push(`+ Assign '${name}' to 'custom' security configuration`);
  }

  if (!dryRun) {
    if (toAssignOspo.length > 0) {
      await octokit.request(
        'POST /orgs/{org}/code-security/configurations/{configuration_id}/attach',
        {
          org,
          configuration_id: ospoManaged.id,
          scope: 'selected',
          selected_repository_ids: toAssignOspo.map(r => r.id),
          headers: { 'X-GitHub-Api-Version': '2022-11-28' },
        }
      );
      for (const { name } of toAssignOspo) {
        actions.push(`Assigned '${name}' to 'ospo-managed' security configuration`);
      }
    }

    if (toAssignCustom.length > 0) {
      await octokit.request(
        'POST /orgs/{org}/code-security/configurations/{configuration_id}/attach',
        {
          org,
          configuration_id: customCfg.id,
          scope: 'selected',
          selected_repository_ids: toAssignCustom.map(r => r.id),
          headers: { 'X-GitHub-Api-Version': '2022-11-28' },
        }
      );
      for (const { name } of toAssignCustom) {
        actions.push(`Assigned '${name}' to 'custom' security configuration`);
      }
    }
  }

  return { actions, planned };
}

// ── Branch protection ─────────────────────────────────────────────────────────

export async function enforceBranchProtection(octokit, org, config, opts = {}) {
  const { dryRun = false, debug = false } = opts;
  const actions = [];
  const planned = [];

  // Build desired target names (repos where branch-protection is 'managed')
  const desiredTargetNames = config.repositories
    .filter(r => r['branch-protection'] === 'managed')
    .map(r => r.name);

  // Resolve repo names to IDs (skip repos not yet created)
  const orgRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'public',
    per_page: 100,
  });
  const repoIdMap = new Map(orgRepos.map(r => [r.name, r.id]));
  const idToName = new Map(orgRepos.map(r => [r.id, r.name]));

  const desiredIds = desiredTargetNames
    .filter(name => repoIdMap.has(name))
    .map(name => repoIdMap.get(name))
    .sort((a, b) => a - b);

  // Look up the 'ospo-managed' org ruleset
  const rulesetsResponse = await octokit.request('GET /orgs/{org}/rulesets', {
    org,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const rulesets = rulesetsResponse.data;
  const ruleset = rulesets.find(r => r.name === 'ospo-managed');

  if (!ruleset) {
    throw new Error(`Org ruleset 'ospo-managed' not found in org ${org}`);
  }

  // Fetch full ruleset to get current conditions
  const fullRulesetResponse = await octokit.request('GET /orgs/{org}/rulesets/{ruleset_id}', {
    org,
    ruleset_id: ruleset.id,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const fullRuleset = fullRulesetResponse.data;

  const currentIds = (fullRuleset.conditions?.repository_id?.repository_ids ?? [])
    .slice()
    .sort((a, b) => a - b);

  if (debug) {
    console.log('  Current targets:', currentIds.map(id => idToName.get(id) ?? id).join(', ') || '(none)');
    console.log('  Desired targets:', desiredTargetNames.join(', ') || '(none)');
    console.log('');
  }

  // Compare sorted ID lists to detect changes
  if (currentIds.join(',') === desiredIds.join(',')) {
    if (debug) console.log('  · Branch protection target list already up to date — skipped');
    return { actions, planned };
  }

  const currentIdSet = new Set(currentIds);
  const desiredIdSet = new Set(desiredIds);
  const added = desiredIds.filter(id => !currentIdSet.has(id));
  const removed = currentIds.filter(id => !desiredIdSet.has(id));

  if (dryRun) {
    for (const id of added) {
      planned.push(`+ Assign '${idToName.get(id) ?? id}' to org ruleset 'ospo-managed'`);
    }
    for (const id of removed) {
      planned.push(`- Remove '${idToName.get(id) ?? id}' from org ruleset 'ospo-managed'`);
    }
  } else {
    // Update only the target list — send only writable fields to avoid schema conflicts
    await octokit.request('PUT /orgs/{org}/rulesets/{ruleset_id}', {
      org,
      ruleset_id: ruleset.id,
      name: fullRuleset.name,
      target: fullRuleset.target,
      enforcement: fullRuleset.enforcement,
      bypass_actors: fullRuleset.bypass_actors,
      conditions: {
        ref_name: fullRuleset.conditions?.ref_name,
        repository_id: {
          repository_ids: desiredIds,
        },
      },
      rules: fullRuleset.rules,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    });

    for (const id of added) {
      actions.push(`Assigned '${idToName.get(id) ?? id}' to org ruleset 'ospo-managed'`);
    }
    for (const id of removed) {
      actions.push(`Removed '${idToName.get(id) ?? id}' from org ruleset 'ospo-managed'`);
    }
  }

  return { actions, planned };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let org = null;
  let configPath = defaultConfigPath;
  let dryRun = false;
  let debug = false;
  let skipTeamSync = false;
  let skipCustomRole = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        org = args[++i];
        break;
      case '--config':
        configPath = path.resolve(args[++i]);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--debug':
        debug = true;
        break;
      case '--skip-team-sync':
        skipTeamSync = true;
        break;
      case '--skip-custom-role':
        skipCustomRole = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!org) {
    console.error('Error: --org is required');
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is not set');
    process.exit(1);
  }

  const config = await loadConfig(configPath);
  const noop = () => {};
  const octokit = new Octokit({ auth: token, log: { debug: noop, info: noop, warn: noop, error: noop } });
  const opts = { dryRun, debug, skipTeamSync, skipCustomRole };
  const allPlanned = [];

  // REPOSITORIES
  console.log('REPOSITORIES');
  const repoResult = await createRepositories(octokit, org, config, opts);
  for (const action of repoResult.actions) console.log(`  ✓ ${action}`);
  for (const skip of repoResult.skipped) console.log(`  · ${skip}`);
  allPlanned.push(...repoResult.planned);

  // TEAMS
  console.log('');
  console.log('TEAMS');
  const teamResult = await processTeams(octokit, org, config, opts);
  for (const action of teamResult.actions) console.log(`  ✓ ${action}`);
  if (teamResult.actions.length === 0 && !dryRun) console.log('  · No team changes');
  allPlanned.push(...teamResult.planned);

  // SECURITY
  console.log('');
  console.log('SECURITY');
  const securityResult = await enforceSecurityConfig(octokit, org, config, opts);
  for (const action of securityResult.actions) console.log(`  ✓ ${action}`);
  if (securityResult.actions.length === 0 && !dryRun) console.log('  · No security configuration changes');
  allPlanned.push(...securityResult.planned);

  // BRANCH PROTECTION
  console.log('');
  console.log('BRANCH PROTECTION');
  const branchResult = await enforceBranchProtection(octokit, org, config, opts);
  for (const action of branchResult.actions) console.log(`  ✓ ${action}`);
  if (branchResult.actions.length === 0 && !dryRun) console.log('  · No branch protection changes');
  allPlanned.push(...branchResult.planned);

  // Dry-run summary
  if (dryRun && allPlanned.length > 0) {
    console.log('');
    console.log('──── Dry-run: planned changes ────');
    for (const line of allPlanned) console.log(`  ${line}`);
  } else if (dryRun) {
    console.log('');
    console.log('──── Dry-run: no changes planned ────');
  }
}

// Only run main() when this file is the entry point (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
