# BSI TR-03185 Compliance – Secure OSS Lifecycle (Outbound)

This document records how projects published by Allianz under [github.com/allianz](https://github.com/allianz) implement the requirements of **BSI TR-03185 v1.1.1, Chapter 2 "Secure Software Lifecycle for Open Source Software"** (formerly BSI TR-03185-2 v1.1.0).

| | |
|---|---|
| **Scope** | Outbound open source projects released by Allianz (upstream maintainer role) |
| **Reference** | [BSI TR-03185](https://www.bsi.bund.de/dok/TR-03185-en), v1.1.1 (2026-07-02), Chapter 2.3 |
| **Owner** | Allianz OSPO |
| **Last reviewed** | _TBD_ |

Requirement levels follow RFC 2119: **MUST** (absolute), **SHOULD** (deviation requires documented justification), **MAY** (optional).

## Governance (GV)

| ID | Requirement | Implementation | Evidence |
|---|---|---|---|
| GV.01 | Information on how to contribute to the project **MUST** be documented. Information about the expected quality of contributions **SHOULD** be given. | Every repository must contain a contribution guide (`CONTRIBUTING` file). An automated check runs twice a week and opens an issue in any repository that lacks one, until it is fixed.<br><br>**Gap (SHOULD):** the check only confirms that the file exists. It does not check whether the file describes the expected quality of contributions (e.g. coding standards, tests, review process). | [Lint report (GitHub Actions run summaries)](https://github.com/allianz/ospo/actions/workflows/lint_repos.yaml)<br><br>Open lint issues: [`org:allianz is:issue is:open "Mandatory Repository Configuration"`](https://github.com/search?q=org%3Aallianz+is%3Aissue+is%3Aopen+%22Mandatory+Repository+Configuration%22&type=issues) |
| GV.02 | The project's repository, websites and sensitive data **MUST** be protected against unauthorized actions. | Changes to a repository require a company account with single sign-on and multi-factor authentication. Permissions are given to teams, not to individuals. Team membership is managed centrally, so access ends when someone leaves the company or the team. Every permission change is requested by pull request and approved before it takes effect, which leaves an audit trail.<br><br>An organisation-wide ruleset protects the default branches.<br><br>Secret scanning and push protection are enabled by default, so credentials are blocked before they are pushed and detected if they are already in a repository. | [Access configuration](config/create_repos.yaml) ([change history](https://github.com/allianz/ospo/commits/main/config/create_repos.yaml))<br><br>Organisation settings (single sign-on, MFA, branch ruleset, secret scanning): internal evidence available from the OSPO on request |

## Legal (LE)

| ID | Requirement | Implementation | Evidence |
|---|---|---|---|
| LE.01 | A license **MUST** be stated for all content made available by the project, including the project's documentation. | Every repository must contain a license file with an approved open source license (Apache-2.0, MIT, CC-BY-4.0 or CC0-1.0). This license covers all content in the repository, including its documentation. An automated check runs twice a week and opens an issue in any repository whose license is missing or not approved, until it is fixed. | [Lint report (GitHub Actions run summaries)](https://github.com/allianz/ospo/actions/workflows/lint_repos.yaml)<br><br>Open lint issues: [`org:allianz is:issue is:open "Mandatory Repository Configuration"`](https://github.com/search?q=org%3Aallianz+is%3Aissue+is%3Aopen+%22Mandatory+Repository+Configuration%22&type=issues) |
| LE.02 | A copy of all licenses in use, or references hereto, **MUST** be provided. | | |

## Quality (QA)

| ID | Requirement | Implementation | Evidence |
|---|---|---|---|
| QA.01 | A list of third-party components used in the software **MUST** be available. | A list of third-party components is available for every repository as a downloadable SBOM (SPDX), generated from the dependency graph of the default branch. For each release, the dependency manifests and lock files in the release tag list the components used in that version.<br><br>**Gap:** there is no ready-made SBOM per release, and components that are not declared through a package manager (e.g. copied-in code) are not included. | [Dependency graph and SBOM export (example: this repository)](https://github.com/allianz/ospo/network/dependencies) |
| QA.02 | All of the project's source code **MUST** be publicly readable. | All repositories are created by the provisioning pipeline, which always creates them as public. Members cannot create repositories themselves. | [Repository configuration](config/create_repos.yaml)<br><br>Organisation settings (repository creation): internal evidence available from the OSPO on request |
| QA.03 | The project **MUST** inform how to report defects. | Repositories are created by the provisioning pipeline with GitHub Issues enabled, and project teams do not have permission to disable it. Defects can therefore always be reported publicly in the project's issue tracker. Security defects are reported privately as described in the security policy (see VM.01).<br><br>**Gap:** there is no default guidance on how to write a defect report, such as an issue template. | [Issue tracker (example: this repository)](https://github.com/allianz/ospo/issues)<br><br>Team role permissions: internal evidence available from the OSPO on request<br><br>[Default security policy](https://github.com/allianz/.github/blob/main/SECURITY.md) |
| QA.04 | Procedures for testing **MUST** be implemented and utilised. _Note: e.g. a CI/CD pipeline for automated testing or a local test harness._ | | |
| QA.05 | The project **SHOULD** take measures to reduce or avoid memory safety issues. _Note: e.g. memory safety instructions in the contribution guide._ | | |
| QA.06 | All changes to the source code **SHOULD** be peer-reviewed. | | |

## Build and Release (BR)

| ID | Requirement | Implementation | Evidence |
|---|---|---|---|
| BR.01 | Information on how to build all software assets **MUST** be publicly available. | | |
| BR.02 | All releases and released software assets intended for use **MUST** be assigned unique, monotonically increasing version identifiers. _Note: the identifier must convey the context of the release compared to past releases, e.g. within a branch._ | | |
| BR.03 | All assets **MUST** be distributed in a way that maintains integrity or at least allows its verification. Means to maintain and verify authenticity **MAY** be deployed. | | |
| BR.04 | All releases **MUST** provide a descriptive log of functional and security modifications. | | |
| BR.05 | Released source packages **MUST NOT** contain any content that is not present in the project's repository or cannot be deterministically generated from it. | | |
| BR.06 | Builds **SHOULD** be reproducible. | | |

## Vulnerability Management (VM)

| ID | Requirement | Implementation | Evidence |
|---|---|---|---|
| VM.01 | The project documentation **MUST** contain security contacts for reporting vulnerabilities. There **SHOULD** be a way to do so privately. | An organisation-wide security policy applies to every repository unless a project provides its own. It asks reporters to use GitHub's private vulnerability reporting instead of public issues, and to notify the OSPO as the security contact. Private vulnerability reporting is enabled for all repositories. | [Default security policy](https://github.com/allianz/.github/blob/main/SECURITY.md) |
| VM.02 | The project **MUST** publish information about discovered vulnerabilities within a reasonable period of time. | | |

## Decommissioning (DE)

| ID | Requirement | Implementation | Evidence |
|---|---|---|---|
| DE.01 | Discontinuation of the project, parts of it, or specific versions or version ranges **SHOULD** be communicated adequately. | Projects without activity for one year are discontinued by an automated process. It first opens a public issue in the repository announcing the planned archival. If there is still no activity after 60 days, the repository is archived. GitHub then marks it as archived and read-only, so users can see that it is no longer maintained. | [Archived repositories](https://github.com/orgs/allianz/repositories?q=archived%3Atrue)<br><br>Archival notices: [`org:allianz is:issue "Inactive Repository Reminder"`](https://github.com/search?q=org%3Aallianz+is%3Aissue+%22Inactive+Repository+Reminder%22&type=issues) |
| DE.02 | Migration paths **MAY** be outlined. | | |

## Deviations

Document every unmet SHOULD requirement here with justification (required by the TR's definition of SHOULD).

| ID | Justification | Approved by | Date |
|---|---|---|---|
| | | | |
