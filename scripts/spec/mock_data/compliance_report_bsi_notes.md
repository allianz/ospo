## Key messages

- **The gaps are in individual repositories.** The findings can be fixed by the project teams, mostly with the existing templates and guides.
- **One repository under legal review weighs on the results.** `ng-aquila` is skipped by the scanners until its license review is done, so it counts as failing its checks.
- **Release integrity is the weakest area.** Several releasing repositories do not sign their releases (BR.03) or publish no release notes (BR.04). A shared release workflow would fix both.
- **Contribution guides are improving** since the CONTRIBUTING template was added to new repositories.

## Needs attention

- **Decision: ng-aquila license review** (Legal, by 30 Nov 2026). Until the review is done, `ng-aquila` fails most requirements.
- **Proposal: signed releases through a shared workflow** (OSPO platform team, Q1 2027). Add artifact attestation to the [release workflow template](https://github.com/allianz/ospo/issues/142).
- **Policy decision: single-maintainer projects** (OSPO lead). `insurance-rule-dsl` fails QA.06 because nobody else can review its changes.
