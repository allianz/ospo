#!/bin/bash
cd "$(dirname "$0")"

ISSUE_TITLE="Inactive Repository Reminder"
ISSUE_TEXT=$(cat <<'EOF'
Dear Maintainers,

This repository has been identified as stale due to inactivity for a long time. If no action is taken within the next 30 days, this repository will be archived.

**Action Required:**
We recommend creating an empty commit to demonstrate ongoing activity. This can be achieved by running the following command:

```bash
git commit --allow-empty -m "Keep repository active"
```

**Request for Unarchival:**
In case the repository is archived and there's a legitimate reason to revive it, please contact ospo@allianz.com with your request for unarchiving.

Thank you for your attention and cooperation.

Best regards,

OSPO Team

EOF
)

# Helper function to print debug messages
print_debug() {
    local message="$1"
    if [ "$DEBUG" = true ]; then
        echo -e "$message"
    fi
}

# Parse command line parameters
ORG_NAME=""
CONFIG_FILE_PATH="../config/archive_repos.yaml"
DRY_RUN=false
DEBUG=false
while [ $# -gt 0 ]; do
    case "$1" in
        --org)
            shift
            ORG_NAME=$1
            ;;
        --config)
            shift
            CONFIG_FILE_PATH=$1
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        --debug)
            DEBUG=true
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
    shift
done


# Read configuration from the config file
EXCLUDED_REPOSITORIES=$(yq -r '.excluded_repos | .[]' "$CONFIG_FILE_PATH" | sort)
STALE_PERIOD_CONFIG=$(yq -r '.stale_period' "$CONFIG_FILE_PATH")
GRACE_PERIOD_CONFIG=$(yq -r '.grace_period' "$CONFIG_FILE_PATH")

# Calculate the dates until archiving
STALE_PERIOD=$(date -d "$STALE_PERIOD_CONFIG" +%Y-%m-%dT%H:%M:%SZ)
GRACE_PERIOD=$(date -d "$GRACE_PERIOD_CONFIG" +%Y-%m-%dT%H:%M:%SZ)
print_debug "Stale period date: $STALE_PERIOD"
print_debug "Grace period date: $GRACE_PERIOD"

# Check if organization name is provided
if [ -z "$ORG_NAME" ]; then
    echo "Please provide the organization name using --org option."
    exit 1
fi


# Checks if an issue is open and returns the issue number.
issue_number() {
  local repo="$1"
  local issue_title="$2"

  gh issue list -R "$repo" --state open --json number,title |  jq -r ".[] | select(.title == \"$issue_title\") | .number"
}


# Creates a new GitHub issue or skips the creation if one already exists.
create_issue_if_not_exists() {
  local repo="$1"
  local issue_title="$2"
  local issue_body=$(echo -e "$3")

  existing_issue_number=$(issue_number "$repo" "$issue_title")
  if [ -z "$existing_issue_number" ]; then
      print_debug "No warning issue found."
      if [ "$DRY_RUN" = true ]; then
        DRY_RUN_MESSAGES+="Dry run: Would create an issue for repository '$repo'.\n"
      else
        gh issue create -R "$repo" --title "$issue_title" --body "$issue_body"
        echo
      fi
  else
    print_debug "A '$issue_title' issue already exists in the repository '$repo'. Skipping creation."
  fi
}


# Function to get issue creation date for a given title
get_issue_creation_date() {
    local repo="$1"
    local issue_title="$2"

    issue_number=$(gh issue list -R "$repo" --state open --json number,title,createdAt | jq -r ".[] | select(.title == \"$issue_title\") | .number")
    if [ -n "$issue_number" ]; then
        gh issue view -R "$repo" "$issue_number" --json createdAt --jq '.createdAt'
    else
        date -u +%Y-%m-%dT%H:%M:%SZ # issue was not created due to dry-run. Pretend issue creation
    fi
}


# Closes an open GitHub issue with a given title.
close_issue() {
  local repo="$1"
  local issue_title="$2"
  local issue_number=$(issue_number "$repo" "$issue_title")

  if [ -n "$issue_number" ]; then
    if [ "$DRY_RUN" = true ]; then
      DRY_RUN_MESSAGES+="Dry run: Would close the existing issue in the repository '$repo'."
    else
      gh issue close -R "$repo" "$issue_number"
      echo "Closed the existing issue in the repository '$repo'."
    fi
  fi
}


# Archive a repository
archive_repo() {
  local repo="$1"
  
  if [ "$DRY_RUN" = true ]; then
    DRY_RUN_MESSAGES+="Dry run: Would archive repository '$repo'.\n"
  else
    gh repo archive "$repo" -y
    echo "Archived the repository '$repo'."
  fi
}


# Calculate the list of repositories to be processed
repos=$(gh repo list $ORG_NAME --no-archived --json name --jq '.[].name' | sort)
repos_to_process=$(comm -23 <(echo "$repos") <(echo "$EXCLUDED_REPOSITORIES"))
print_debug "Repos found: \n$repos_to_process\n"

# Iterate over all repositories and create staleness warnings, if needed
echo "READING REPOSITORIES..."
for repo in ${repos_to_process[@]}; do
    # Get the last commit date for the repository
    last_commit_date=$(gh repo view $ORG_NAME/$repo --json pushedAt --jq '.pushedAt')

    # Check if the repository is stale (no commits in the last year)
    if [[ "$last_commit_date" < "$STALE_PERIOD" ]]; then
        echo "$ORG_NAME/$repo is stale."
        create_issue_if_not_exists "$ORG_NAME/$repo" "$ISSUE_TITLE" "$ISSUE_TEXT"

        # Check if grace period is passed for existing issue
        issue_creation_date=$(get_issue_creation_date "$ORG_NAME/$repo" "$ISSUE_TITLE")
        if [[ "$issue_creation_date" < "$GRACE_PERIOD" ]]; then
            archive_repo "$ORG_NAME/$repo"
        else
            echo "$ORG_NAME/$repo has remaining grace period."
        fi
    else
        close_issue "$ORG_NAME/$repo" "$ISSUE_TITLE"
    fi
    echo
done


# Print dry run results
if [ "$DRY_RUN" = true ]; then
    echo -e "\nPlanned changes:\n$DRY_RUN_MESSAGES" 
fi
