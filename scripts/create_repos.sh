#!/bin/bash
#
# GitHub Management Script
#
# Usage: ./create_repos.sh --org <organization_name> [--dry-run] [--debug] [--skip-team-sync] [--skip-custom-role]
#
# Parameters:
#   --org: The name of the organization on GitHub.
#   --dry-run: Optional flag to simulate script execution without making changes.
#   --debug: Optional flag to enable debug messages.
#   --skip-team-sync: Optional flag to skip the setup of team synchronization with Azure AD. Only available in Github Enterprise.
#   --skip-custom-role: Optional flag to skip the usage of custom roles. Only available in Github Enterprise.
#
#
# Description:
#   This Bash script automates GitHub repository and team management based on a YAML configuration file.
#   It uses GitHub CLI (gh) and yq for interaction and configuration parsing, respectively.
#   The script can create and synchronize repositories and teams, and it supports dry-run mode.

cd "$(dirname "$0")"
IFS=$'\n' # keep whitespace when iterating with for loops

# Install yq and gh (if not already installed)
if ! command -v yq &> /dev/null || ! command -v gh &> /dev/null; then
    echo "yq and gh are required. Please install them before running the script."
    exit 1
fi

# Helper function to print debug messages
print_debug() {
    local message="$1"
    if [ "$DEBUG" = true ]; then
        echo "$message"
    fi
}


# Parse command line parameters
ORG_NAME=""
CONFIG_FILE_PATH="../config/create_repos.yaml"
DRY_RUN=false
DEBUG=false
SKIP_TEAM_SYNC=false
PERMISSION="Own"
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
        --skip-team-sync)
            SKIP_TEAM_SYNC=true
            ;;
        --skip-custom-role)
            PERMISSION="maintain"
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
    shift
done


# Function to validate the structure of the YAML configuration
validate_yaml() {
    for repo_name in $(yq eval '.repositories[].name' "$CONFIG_FILE_PATH"); do
        if [[ ! "$repo_name" =~ ^[a-z0-9.-]+$ ]] || [[ ${#repo_name} -gt 64 ]]; then
            echo "Invalid repository name: '$repo_name'. The name must match the pattern ^[a-z0-9.-]+$ (max 64 chars).">&2; exit 1
        fi
    done
    while IFS= read -r team_name; do
        if [[ ! "$team_name" =~ ^[a-zA-Z0-9[:blank:]._-]+$ ]] || [[ ${#team_name} -gt 64 ]]; then
            echo "Invalid team name: '$team_name'. The name must only contain alphanumeric characters, spaces, dots, underscores, and hyphens (max 64 chars).">&2; exit 1
        fi
    done < <(yq eval '.repositories[].teams[].name' "$CONFIG_FILE_PATH")
}


# Function to create a new GitHub repository
create_repo() {
    local name=$1
    local org=$2

    if [ "$DRY_RUN" = true ]; then
        DRY_RUN_MESSAGES+="+ Would create repository: $name in $org.\n"
    else
        gh repo create $org/$name --public

        if [ $? -eq 0 ] && [ "$(echo $response | jq -r '.id')" != "null" ]; then
            echo "✓ Repository '$name' successfully created in organization $org."
        else
            echo "Error creating repo '$name' at line $LINENO. $response.">&2; exit 1;
        fi
    fi
}

# Function to create a new GitHub team
create_team() {
    local name=$1
    local org=$2

    if [ "$DRY_RUN" = false ]; then
        load_ad_group "$name" "$org" > /dev/null || exit 1
    fi

    # Create the team
    if [ "$DRY_RUN" = true ]; then
        DRY_RUN_MESSAGES+="+ Would create team: '$name' in $org.\n"
    else
        local response=$(gh api \
           --method POST \
           -H "Accept: application/vnd.github+json" \
           -H "X-GitHub-Api-Version: 2022-11-28" \
            /orgs/$org/teams \
           -f name="$name" \
           -f privacy='closed' ) 
        
        if [ $? -eq 0 ] && [ "$(echo $response | jq -r '.id')" != "null" ]; then
            echo "✓ Team '$name' created successfully in organization '$org'."
        else
            echo "Error creating team '$name' at line $LINENO. $response." >&2; exit 1;
        fi
    fi
    load_teams $org # Update cache to include new team slug
}


# Function to set up team synchronization with Azure AD
set_team_sync() {
    local name=$1
    local org=$2

    if [ "$DRY_RUN" = true ]; then
        local ad_group="$name"
    else
        local ad_group=$(load_ad_group "$name" "$org") || exit 1
    fi

    # Activate Azure AD team sync by assigning the AD group to the team
    if [ "$DRY_RUN" = true ]; then
        DRY_RUN_MESSAGES+="+ Would setup team sync: team '$name' with AD Group '$ad_group'.\n"
    else
        local slug_name=$(get_team_slug $name) || exit 1
        local response=$(echo $ad_group | gh api \
            --method PATCH \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            /orgs/$org/teams/$slug_name/team-sync/group-mappings \
            --input -)

        if [ $? -eq 0 ] && [ $(echo "$response" | jq '.groups | length') -ge 1 ]; then
            echo "✓ Team '$name' successfully syncing with AD Group '$name'."
        else
            echo "Error when enabling team sync of '$slug_name' with AD '$name' at line $LINENO. $response." >&2; exit 1;
        fi
    fi
}


# Function to delete a GitHub team
delete_team() {
    local name=$1
    local org=$2

    if [ "$DRY_RUN" = true ]; then
        DRY_RUN_MESSAGES+="- Would delete team: $name in $org.\n"
    else
        local slug_name=$(get_team_slug $name) || exit 1
        local response=$(gh api \
            --method DELETE \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            /orgs/$org/teams/$slug_name) 
        
        if [ $? -eq 0 ] && [ -z "$response" ]; then
            echo "✓ Team '$name' deleted successfully in organization '$org'."
        else
            echo "Error deleting team '$slug_name' at line $LINENO. $response.">&2; exit 1;
        fi
    fi
}


# Function to grant permissions to a team on specified repositories
grant_permissions() {
    local name=$1
    local org=$2
    local repos_to_assign=$3

    for repo in $repos_to_assign; do
        if [ "$DRY_RUN" = true ]; then
            DRY_RUN_MESSAGES+="+ Would grant $PERMISSION permission: team '$name' in $org/$repo.\n"
        else
            local slug_name=$(get_team_slug $name) || exit 1
            local response=$(gh api \
                --method PUT \
                -H "Accept: application/vnd.github+json" \
                -H "X-GitHub-Api-Version: 2022-11-28" \
                /orgs/$org/teams/$slug_name/repos/$org/$repo \
                -f permission="$PERMISSION")

            if [ $? -eq 0 ] && [ -z "$response" ]; then
                echo "✓ Team '$name' granted $PERMISSION permission to repository '$repo'."
            else
                echo "Error granting $PERMISSION permission to team '$name' for repo '$repo' at line $LINENO. $response." >&2; exit 1;
            fi
        fi
    done

    
}


# Function to revoke permissions from a team on specified repositories
revoke_permissions() {
    local name=$1
    local org=$2
    local repos_to_remove=$3

    for repo in $repos_to_remove; do
        if [ "$DRY_RUN" = true ]; then
            DRY_RUN_MESSAGES+="- Would remove owner $PERMISSION: team '$name' in $org/$repo.\n"
        else
            local slug_name=$(get_team_slug $name)
            local response=$(gh api \
                --method DELETE \
                -H "Accept: application/vnd.github+json" \
                -H "X-GitHub-Api-Version: 2022-11-28" \
                /orgs/$org/teams/$slug_name/repos/$org/$repo)

            if [ $? -eq 0 ] && [ -z "$response" ]; then
                echo "✓ Team '$name' removed $PERMISSION permissions in repository '$repo'."
            else
                echo "Error removing permissions of team '$slug_name' from repo '$repo' at line $LINENO. $repsonse">&2; exit 1;
            fi
        fi
    done
}


# Function to load existing repositories from GitHub
load_repositories() {
    local org=$1

    local repos=$(gh repo list $org --json name --limit 1000 )|| {
        echo "Error fetching repos for $org at line $LINENO. $repos." >&2; exit 1; }

    if [ "$repos" = "[]" ]; then
        echo "No repositories found for $org (line $LINENO)." >&2; exit 1
    else
        echo "$repos" | jq -r '.[].name' | sort -u
    fi
}


# Function to load existing teams from GitHub and cache the result
load_teams() {
    local org="$1"
    CACHED_TEAMS=$(gh api -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" /orgs/$org/teams) || {
        echo "Error fetching teams for $org at line $LINENO. $CACHED_TEAMS."; exit 1; }
}


# Function to load permissions of a team on repositories
load_team_permissions(){
    local org_name="$1"
    local team_name="$2"
    local team_slug=$(get_team_slug $team_name) || exit 1   

    repos_for_team=$(gh api -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "/orgs/$org_name/teams/$team_slug/repos?per_page=100") || {
        echo "Error fetching repositories for team '$team_slug' for '$org_name' at line $LINENO. $existing_repos_for_team.">&2; exit 1; }

    echo $repos_for_team | jq -r '.[].name'
}


# Function to load and validate an Azure AD group by name (exact match)
load_ad_group() {
    local name="$1"
    local org="$2"

    local ad_groups=$(gh api -XGET \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        -F q="$name" /orgs/$org/team-sync/groups)

    if [ $? -ne 0 ] || [ "$(echo "$ad_groups" | jq -e '.groups')" == "null" ]; then
        echo "Error reading AD groups for name '$name' in org $org at line $LINENO. $ad_groups." >&2; exit 1
    fi

    local ad_group=$(echo "$ad_groups" | jq --arg exact_match "$name" '.groups |= map(select(.group_name == $exact_match))')
    if [ "$(echo "$ad_group" | jq -r '.groups | length')" -eq 0 ]; then
        echo "Error: No AD group with name '$name' found." >&2; exit 1
    fi
    if [ "$(echo "$ad_group" | jq -r '.groups | length')" -ne 1 ]; then
        echo "Error: More than one AD group with name '$name' found." >&2; exit 1
    fi

    echo "$ad_group"
}


# Function to get the list of teams for a given organization
get_teams(){
    local org="$1"
    echo "$CACHED_TEAMS"
}


# Function to get the slug of a team by its name
get_team_slug(){
    local name="$1"

    # Search for the team in both organizations
    local slug=$(jq -r --arg name "$name" '.[] | select(.name == $name) | .slug' <<< "$CACHED_TEAMS") || exit 1
 
    # Return the first non-empty slug found
    if [ -n "$slug" ]; then
        echo "$slug"
    else
        echo "Error: team slug not found for $name" >&2; exit 1
    fi
}


# Function to process repositories based on the YAML configuration
#
# This function reads the YAML configuration file to determine the desired state of GitHub repositories
# for the given organization. It then compares this desired state with
# the existing repositories on GitHub and performs the necessary actions to align them.
# Actions include creating new repositories, transferring repositories between organizations, and printing
# warnings for inconsistent repository configurations.
#
process_repos() {
    local org="$1"
    echo "READING REPOSITORIES..."

    # Status
    local existing_repos=$(load_repositories $org) || exit 1
    local desired_repos=$(yq eval '.repositories[].name' "$CONFIG_FILE_PATH" | sort -u) || exit 1
    
    ## calculate changes
    local repos_to_add=$(comm -23 <(echo "$desired_repos") <(echo "$existing_repos")) || exit 1
    
    # Debug
    print_debug
    print_debug "Existing Repositories in $org:"
    print_debug "$existing_repos" | sed 's/^/  /'
    print_debug
    print_debug "Desired Repositories in $org:"
    print_debug "$desired_repos" | sed 's/^/  /'
    print_debug
    print_debug "Repositories to Add in $org:"
    print_debug "$repos_to_add" | sed 's/^/  /'
    print_debug

    # Iterate over changes
    for repo in $repos_to_add; do
        create_repo $repo $org
    done
}

# Function to process teams based on the YAML configuration and existing teams
# 
# This function manages GitHub teams for the given organizations,
# aligning them with the desired state specified in the YAML configuration file.
# It reads the configuration to determine the desired teams, their associated repositories,
# and the necessary actions to synchronize them with the existing teams on GitHub.
#
# The function identifies teams to be added, updated, or deleted based on the configuration.
# For teams to be added, it creates the team and grants appropriate permissions on the associated repositories.
# For existing teams, it updates team memberships and permissions according to the YAML configuration.
# Teams marked for deletion are removed from GitHub.
#
process_teams() {
    local org_name="$1"
    echo -e "READING $org_name TEAMS..."
    
    # Status
    local existing_teams=$(get_teams $org_name | jq -r '.[].name' | sort) || exit 1
    local desired_teams=$(yq eval '.repositories[].teams[].name' "$CONFIG_FILE_PATH" | sort -u) || exit 1

    # Calculate changes
    local teams_to_add=$(comm -23 <(echo "$desired_teams") <(echo "$existing_teams")) || exit 1
    local teams_to_update=$(comm -12 <(echo "$desired_teams") <(echo "$existing_teams")) || exit 1
    local teams_to_remove=$(comm -13 <(echo "$desired_teams") <(echo "$existing_teams" )) || exit 1

    # Debug
    print_debug
    print_debug "Existing Teams in $org_name:"
    print_debug "$existing_teams" | sed 's/^/  /'
    print_debug
    print_debug "Desired Teams for $org_name:"
    print_debug "$desired_teams" | sed 's/^/  /'
    print_debug   

    # Iterate over teams to add
    print_debug "Teams to Add for $org_name:"
    for team in $teams_to_add; do
    
        # Status
        local desired_repos_for_team=$(yq eval '.repositories[] | select(.teams[].name == "'"$team"'") | .name' "$CONFIG_FILE_PATH" | sort -u) || exit 1

        # Debug
        print_debug "  $team"
        print_debug "    repos:"
        print_debug "$desired_repos_for_team" | sed 's/^/      /'

        # Apply
        create_team "$team" $org_name
        if [ "$SKIP_TEAM_SYNC" = false ]; then
            set_team_sync "$team" "$org_name"
        fi
        grant_permissions "$team" $org_name $desired_repos_for_team
    done
    print_debug

    # Iterate over teams to update
    print_debug "Teams to Update for $org_name:"
    for team in $teams_to_update; do

        # Status repo assignments
        local existing_repos_for_team=$(load_team_permissions "$org_name" "$team" | sort) || exit 1
        local desired_repos_for_team=$(yq eval '.repositories[] | select(.teams[].name == "'"$team"'") | .name' "$CONFIG_FILE_PATH" | sort -u) || exit 1
        
        # Debug
        print_debug "  $team"
        print_debug "    status:"
        print_debug "      existing repo assignments:"
        print_debug "$existing_repos_for_team" | sed 's/^/        /'
        print_debug "      desired repo assignments:"
        print_debug "$desired_repos_for_team" | sed 's/^/        /'

        # Calculate changes in repo assignments
        local repos_to_add=$(comm -23 <(echo "$desired_repos_for_team") <(echo "$existing_repos_for_team")) || exit 1
        local repos_to_remove=$(comm -13 <(echo "$desired_repos_for_team") <(echo "$existing_repos_for_team")) || exit 1
        
        # Debug
        print_debug "    changes:"
        print_debug "      assignments to add:"
        print_debug "$repos_to_add" | sed 's/^/        /'
        print_debug "      assignments to remove:"
        print_debug "$repos_to_remove" | sed 's/^/        /'

        grant_permissions "$team" "$org_name" $repos_to_add
        revoke_permissions "$team" "$org_name" $repos_to_remove
    done

    # Iterate over teams to delete
    print_debug "Teams to Delete for $org_name:"
    for team in $teams_to_remove; do
        print_debug "  $team"
        delete_team "$team" "$org_name"
    done
}

# Run
validate_yaml
process_repos $ORG_NAME
load_teams $ORG_NAME
process_teams $ORG_NAME

# Print warnings
if [ -n "$warning_messages" ]; then
    echo -e "\nWarning Messages:"
    echo -e "$warning_messages" | sed 's/^/  /'
fi

# Print dry run results
if [ "$DRY_RUN" = true ]; then
    echo -e "\nPlanned changes:\n$DRY_RUN_MESSAGES" 
fi

