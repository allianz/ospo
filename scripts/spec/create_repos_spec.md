# Spec: create_repos implementation

## Motivation

Open source projects at Allianz follow a self-service provisioning model. After business approval, a project team opens a pull request against `config/create_repos.yaml` to register their repository. On merge the CI pipeline creates the repository with the organization's default settings, assigns team permissions, and connects Entra ID groups for identity-driven access — all without requiring manual admin intervention.

The goals of this automation are:

1. **Zero-touch provisioning** — repository creation, team setup, and permission assignment happen automatically on merge. No GitHub admin action required.
2. **Identity-driven access** — every GitHub team is synced with an Entra ID group. On- and offboarding is controlled outside of GitHub through the enterprise identity provider.
3. **Auditable change history** — all configuration changes go through pull requests, giving a clear audit trail of who requested what and when.
4. **Secure defaults** — repositories are created with GitHub Advanced Security enabled and branch protection enforced. Projects can opt out if they need custom settings.


## Scope

The script manages:

- **Repository creation** — new public repositories in the configured organization
- **Team lifecycle** — create, update (permission changes), and delete teams
- **Team permissions** — grant and revoke repository access for teams
- **Entra ID synchronization** — bind GitHub teams to Entra ID groups
- **GitHub Advanced Security** — enforce GHAS defaults or delegate to the project
- **Branch protection** — enforce branch protection rules or delegate to the project

Out of scope:

- Repository deletion or archival (handled by `archive_repos`)
- Repository compliance linting (handled by `lint_repos`)
- Organization-level settings (managed by GitHub org admins)
- Entra ID group creation (managed by the identity team)

---

## Project Structure

```
scripts/
  package.json          # shared for all JS scripts in this repo
  package-lock.json
  node_modules/
  create_repos.js
  spec/
    create_repos_spec.md
```

---

## CLI Interface

```
node scripts/create_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--skip-team-sync] [--skip-custom-role]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization to manage |
| `--config` | `config/create_repos.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Simulate execution without making changes |
| `--debug` | false | Print verbose output |
| `--skip-team-sync` | false | Skip Entra ID team synchronization (Enterprise-only feature) |
| `--skip-custom-role` | false | Use `maintain` permission instead of custom `Own` role (non-Enterprise fallback) |

Exit codes: `0` on success, `1` on any error.

Requires `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment. The default config path is resolved relative to the repo root, not the working directory.

---

## Configuration File

Configuration lives at `config/create_repos.yaml`.

```yaml
# Configuration File for GitHub Repositories
#
# This file manages settings for GitHub repositories within the organization.
# Each entry represents a repository that should exist in the org with the
# specified team assignments and policy settings.
#
# Adding a new repository:
#   1. Add an entry under `repositories` with the repo name
#   2. Optionally assign teams (team name must match the Entra ID group name)
#   3. Optionally configure security and branch-protection policies
#   4. Open a pull request — the pipeline creates the repo on merge

repositories:

  # Minimal: repo with organization defaults (managed security + branch protection)
  - name: "my-repo"

  # Repo with a single owner team (default role)
  - name: "my-other-repo"
    access:
      - team: "My Team"
        role: own

  # Repo with mixed roles and custom settings
  - name: "special-repo"
    security: custom
    branch-protection: custom
    access:
      - team: "Special Team"
        role: own
      - team: "External Contributors"
        role: triage
```

### Field reference

| Field | Level | Type | Default | Description |
|---|---|---|---|---|
| `repositories` | Root | Array | required | List of repositories to manage |
| `name` | Repository | String | required | Repository name. Must match `^[a-z0-9.-]+$`, max 64 characters. |
| `security` | Repository | String | `managed` | `managed`: OSPO enforces GHAS defaults. `custom`: repo team controls GHAS settings. |
| `branch-protection` | Repository | String | `managed` | `managed`: OSPO enforces branch protection rules. `custom`: repo team defines its own rules. |
| `access` | Repository | Array | `[]` | Access entries for this repository. Unknown fields are rejected. |
| `team` | Access entry | String | required | Team display name. Must match the corresponding Entra ID group name exactly. Alphanumeric, spaces, dots, underscores, hyphens; max 64 characters. |
| `role` | Access entry | String | `own` | Permission level: `own`, `write`, or `triage`. Unknown values are rejected. |

---

## Team & Permission Model

### Permission levels

| Config value | GitHub role | Notes |
|---|---|---|
| `own` | Custom organization role (Enterprise) | Default. Falls back to `maintain` when `--skip-custom-role` is set. |
| `write` | Built-in write role | Push access. |
| `triage` | Built-in triage role | Read + triage issues and PRs, no push access. |

### Team lifecycle

| Event | Action |
|---|---|
| Team in config, not in GitHub | Create team (closed privacy) → sync with Entra ID → grant repo permissions |
| Team in both config and GitHub | Compare repo assignments → grant/revoke as needed |
| Team in GitHub, not in config | Delete team |

### Entra ID synchronization

- Each team name **must** match an Entra ID group name exactly (case-sensitive).
- On team creation, the script verifies the Entra ID group exists before proceeding.
- Team membership is then controlled entirely through the identity provider.
- Sync setup is skipped when `--skip-team-sync` is passed (for non-Enterprise environments or testing).

---

## Security (GitHub Advanced Security)

Org admins maintain two GitHub Advanced Security configurations, `ospo-managed` (enforced) and `custom` (not enforced). Both enable the same GHAS features. The `security` field selects which one a repo is assigned to:

| `security` value | Script action | Effect |
|---|---|---|
| `managed` (default) | Assign repo to `ospo-managed` | Repo teams cannot change GHAS settings |
| `custom` | Assign repo to `custom` | Repo teams can adjust individual settings, e.g. disable Dependabot |

The script only manages the repo assignments, never the configurations themselves, so admins can adjust the baseline without code changes. If a configuration is missing, the script fails.

---

## Branch Protection

Org admins maintain one org-level repository ruleset, `ospo-managed` (rules, enforcement, bypass actors). The `branch-protection` field selects whether a repo is targeted by it:

| `branch-protection` value | Script action | Effect |
|---|---|---|
| `managed` (default) | Add repo to the `ospo-managed` target list | Repo teams cannot change the branch rules |
| `custom` | Keep repo out of the target list (removed if present) | Repo teams define their own rules |

The script only manages the target list, never the ruleset's rules, so admins can adjust the baseline without code changes. If the ruleset is missing, the script fails.

Repos are targeted by ID rather than by name pattern, matching the GitHub UI's "select repositories" behaviour and avoiding accidental wildcard matches.

---

## Output / Reporting

Three output levels:

- **Normal** (no flags): shows only the changes being made — intent before each API call, `✓` after success. Sections with nothing to do print `· No changes`.
- **`--debug`**: before each section's changes, prints a block showing full existing state, desired state, and a blank line. The change lines then follow in normal format. This lets you trace exactly how each planned action was derived.
- **`--dry-run`**: shows the same `+/-` change lines per section but makes no API calls. A footer confirms nothing was executed.

### Normal mode — with changes

Each change is printed as `  + intent... ✓` (or `  - intent... ✓` for removals) using `process.stdout.write` so the intent line is visible if an error occurs mid-operation.

For teams, each operation is on its own line. For security and branch protection, all repos in the same assignment bucket are condensed onto one line (only repos that actually change are shown — not all repos):

```
REPOSITORIES
  + Create 'my-new-repo'... ✓

TEAMS
  + Create team 'My Team'... ✓
  + Sync 'My Team' with Entra ID group 'My Team'... ✓
  + Grant own: 'My Team' on 'my-new-repo'... ✓
  ~ Update own→triage: 'My Team' on 'existing-repo'... ✓
  - Revoke: 'My Team' on 'removed-repo'... ✓
  - Delete team 'Defunct Team'... ✓

SECURITY
  + Assign to 'ospo-managed': 'my-new-repo'... ✓
  + Assign to 'custom': 'special-repo'... ✓

BRANCH PROTECTION
  + Assign to 'ospo-managed': 'my-new-repo'... ✓
  + Assign to 'custom': 'old-repo'... ✓
```

### Normal mode — no changes

```
REPOSITORIES
  · No changes

TEAMS
  · No changes

SECURITY
  · No changes

BRANCH PROTECTION
  · No changes
```

### Error mid-run

The intent line (without `✓`) identifies what was being attempted when the error occurred:

```
TEAMS
  + Create team 'My Team'... ✓
  + Sync 'My Team' with Entra ID group 'My Team'...
Fatal error: Not Found
```

### Dry-run

Changes are shown inline per section (same `+/-` prefix, no `... ✓`). Sections with nothing planned show `· No changes`. A one-line footer confirms no API calls were made:

```
REPOSITORIES
  + Create 'my-new-repo'

TEAMS
  + Create team 'My Team'
  + Sync 'My Team' with Entra ID group 'My Team'
  + Grant own: 'My Team' on 'my-new-repo'

SECURITY
  · No changes

BRANCH PROTECTION
  + Assign to 'ospo-managed': 'my-new-repo'

──── Dry-run: no changes were made ────
```

### Debug mode

Each section emits a debug block before its change lines. The block always shows `Existing <noun>:` and `Desired <noun>:` so the reader can verify how the delta was calculated. No delta lines are printed in the debug block — the intent lines that follow already communicate the delta.

**REPOSITORIES:**
```
REPOSITORIES
  Existing repos: repo1, repo2
  Desired repos:  my-new-repo, repo1, repo2

  + Create 'my-new-repo'... ✓
```

**TEAMS** — shows existing/desired team lists; for teams being created, lists the repos they will be granted; for existing teams with changes, shows `current repos | desired | + grant | - revoke | ~ update`:
```
TEAMS
  Existing teams: Defunct Team
  Desired teams:  My Team
  Team 'My Team' — desired repos: my-new-repo

  + Create team 'My Team'... ✓
  + Grant own: 'My Team' on 'my-new-repo'... ✓
  - Delete team 'Defunct Team'... ✓
```

For an existing team whose repo assignments or roles changed:
```
  Team 'My Team' — current repos: old-repo | desired: new-repo | + grant: new-repo | - revoke: old-repo
  Team 'My Team' — current repos: my-repo | desired: my-repo | ~ update: my-repo
```

**SECURITY** — shows all four assignment lists (existing and desired for both configs):
```
SECURITY
  Existing ospo-managed: repo1, repo2
  Existing custom:       special-repo
  Desired ospo-managed:  my-new-repo, repo1, repo2
  Desired custom:        special-repo

  + Assign to 'ospo-managed': 'my-new-repo'... ✓
```

**BRANCH PROTECTION** — shows existing and desired target lists by repo name:
```
BRANCH PROTECTION
  Existing targets: repo1, repo2
  Desired targets:  my-new-repo, repo1

  + Assign to 'ospo-managed': 'my-new-repo'... ✓
  + Assign to 'custom': 'repo2'... ✓
```
