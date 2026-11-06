---
as_of: 2026-11-03
---

## Key messages

- **The gaps are in individual repositories, not in the central setup.** No requirement is "Not met", and the organisation-wide security policy covers every repository.
- **Compliance fell from 83.9% to 80.0%, mostly because of one repository.** `ng-aquila` is skipped by the scanners while its license is under legal review, so it counts as failing 15 checks.
- **Release integrity is the weakest area.** Only 2 of 5 releasing repositories sign their releases (BR.03), and 2 of 5 publish no release notes (BR.04). A shared release workflow would fix both.
- **Contribution guides are improving.** GV.01 rose from 55% to 70% since 6 Oct, after the CONTRIBUTING template was added to new repositories.

## Needs attention

- **Decision: ng-aquila license review** (Legal, by 30 Nov 2026). Until the review is done, `ng-aquila` fails 14 requirements.
- **Proposal: signed releases through a shared workflow** (OSPO platform team, Q1 2027). Add artifact attestation to the [release workflow template](https://github.com/allianz/ospo/issues/142).
- **Policy decision: single-maintainer projects** (OSPO lead). `insurance-rule-dsl` fails QA.06 because nobody else can review its changes.
