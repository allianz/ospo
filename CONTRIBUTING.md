
# Contribution Guidelines
Thank you for your interest in contributing to this project! ❤️

Reach out on our collaboration channels if you need assistance.

## Ways to Contribute
- **Code**: Help improve our automation scripts.
- **Documentation**: Enhance our guides with feedback and improvements.

<!--
**Spread the Word:** You can also contribute by spreading the word about open source at Allianz. Share it on social media, write blog posts, or simply tell your friends and colleagues about it. Your efforts in promoting our project are greatly appreciated.-->

## Setting Up Your Development Environment
The following tools are required by our scripts:

* [yq](https://github.com/mikefarah/yq)
* jq
* [gh](https://cli.github.com/)
* [repolinter](https://github.com/todogroup/repolinter)

## Getting Started

The main scripts and associated files are:

| Script           | Config        | Workflow          | Description                          |
|------------------|---------------|-------------------|--------------------------------------|
| create_repos.sh  | create_repos.yaml    | create_repos.yml  | Create repositories and assign teams |
| lint_repos.sh    | lint_create_repos.yaml    | repo_lint.yml     | Enforce minimum standards            |
| archive_repos.sh | archive_create_repos.yaml | archive_repos.yml | Archive stale projects               |


Example:

```bash
 ./lint_repos.sh --org allianz --dry-run
```

## Testing

Use sandbox environment to test the scripts

Example:
```bash
 ./create_repos.sh --org ospo-sandbox --config ./test/create_repos.yaml --debug --dry-run
```

If you want to run the script in your own test organization, you might need to deactivate some features only available in GitHub Enterprise.

Example:
```bash
 ./create_repos.sh --org my-test-org --config ./test/create_repos.yaml --skip-team-sync --skip-custom-role --debug --dry-run
```
