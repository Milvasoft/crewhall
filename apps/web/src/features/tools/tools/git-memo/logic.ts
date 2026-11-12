// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/git-memo/logic.ts. See THIRD_PARTY.md.
/**
 * A searchable git command cheatsheet. Pure and local.
 */

export interface GitCommand {
  /** Stable key for the localized description (tools.items.git-memo.commands.<id>). */
  id: string;
  command: string;
  description: string;
}

export interface GitGroup {
  /** Stable key for the localized group name (tools.items.git-memo.groups.<id>). */
  id: string;
  name: string;
  commands: GitCommand[];
}

export const GIT_MEMO: GitGroup[] = [
  {
    id: 'setup',
    name: 'Setup & config',
    commands: [
      {
        id: 'configName',
        command: 'git config --global user.name "Name"',
        description: 'Set your name.',
      },
      {
        id: 'configEmail',
        command: 'git config --global user.email "you@example.com"',
        description: 'Set your email.',
      },
      { id: 'init', command: 'git init', description: 'Create a new repository.' },
      { id: 'clone', command: 'git clone <url>', description: 'Clone a remote repository.' },
    ],
  },
  {
    id: 'staging',
    name: 'Staging & committing',
    commands: [
      { id: 'status', command: 'git status', description: 'Show working-tree status.' },
      { id: 'add', command: 'git add <path>', description: 'Stage changes.' },
      { id: 'addPatch', command: 'git add -p', description: 'Stage changes hunk by hunk.' },
      { id: 'commit', command: 'git commit -m "message"', description: 'Commit staged changes.' },
      { id: 'amend', command: 'git commit --amend', description: 'Rewrite the last commit.' },
      { id: 'restore', command: 'git restore <path>', description: 'Discard working changes.' },
      { id: 'unstage', command: 'git restore --staged <path>', description: 'Unstage a file.' },
    ],
  },
  {
    id: 'branches',
    name: 'Branches',
    commands: [
      { id: 'branch', command: 'git branch', description: 'List branches.' },
      {
        id: 'switchCreate',
        command: 'git switch -c <name>',
        description: 'Create and switch to a branch.',
      },
      { id: 'switch', command: 'git switch <name>', description: 'Switch branches.' },
      {
        id: 'merge',
        command: 'git merge <name>',
        description: 'Merge a branch into the current one.',
      },
      {
        id: 'branchDelete',
        command: 'git branch -d <name>',
        description: 'Delete a merged branch.',
      },
      {
        id: 'rebase',
        command: 'git rebase <base>',
        description: 'Reapply commits onto another base.',
      },
    ],
  },
  {
    id: 'remotes',
    name: 'Remotes & syncing',
    commands: [
      { id: 'remotes', command: 'git remote -v', description: 'List remotes.' },
      { id: 'fetch', command: 'git fetch', description: 'Download objects without merging.' },
      { id: 'pull', command: 'git pull', description: 'Fetch and merge from the remote.' },
      { id: 'push', command: 'git push', description: 'Upload commits to the remote.' },
      {
        id: 'pushUpstream',
        command: 'git push -u origin <branch>',
        description: 'Push and set upstream.',
      },
    ],
  },
  {
    id: 'history',
    name: 'History & undo',
    commands: [
      { id: 'log', command: 'git log --oneline --graph', description: 'Compact, visual history.' },
      { id: 'diff', command: 'git diff', description: 'Show unstaged changes.' },
      { id: 'diffStaged', command: 'git diff --staged', description: 'Show staged changes.' },
      {
        id: 'resetSoft',
        command: 'git reset --soft HEAD~1',
        description: 'Undo the last commit, keep changes staged.',
      },
      {
        id: 'resetHard',
        command: 'git reset --hard <ref>',
        description: 'Reset everything to a ref (destructive).',
      },
      {
        id: 'revert',
        command: 'git revert <ref>',
        description: 'Create a commit that undoes another.',
      },
      { id: 'stash', command: 'git stash', description: 'Shelve changes for later.' },
      { id: 'stashPop', command: 'git stash pop', description: 'Restore shelved changes.' },
      {
        id: 'cherryPick',
        command: 'git cherry-pick <ref>',
        description: 'Apply a specific commit.',
      },
      {
        id: 'reflog',
        command: 'git reflog',
        description: 'See where HEAD has been (recover lost commits).',
      },
    ],
  },
];

/**
 * Filter the cheatsheet by a free-text query over command and description. `groups` lets the
 * UI filter its localized copy of the memo.
 */
export function filterGitMemo(query: string, groups: GitGroup[] = GIT_MEMO): GitGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      commands: group.commands.filter(
        (c) => c.command.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
      ),
    }))
    .filter((group) => group.commands.length > 0);
}
