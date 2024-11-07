import fs from 'fs';
import os from 'os';
import path from 'path';

import toml from 'toml';
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';

import { ORG_LIST, PROTECTED_LABEL_PATTERNS, COMMITTER_TEAM } from './metadata.js';
import {
  runShellCommand, shuffleArray, parsePinnedRequirementsTree, mergeParsedRequirementsTree,
  compareSemVer,
} from './utils.js';

const reqsFiles = ['requirements/base.txt', 'requirements/development.txt'];

class Github {
  #userInTeamCache;

  #packageTree;

  constructor({ context, issueNumber = null, token = null }) {
    this.context = context;
    this.issueNumber = issueNumber;
    const githubToken = token || process.env.GITHUB_TOKEN;
    if (!githubToken) {
      const msg = 'GITHUB_TOKEN is not set';
      this.context.logError(msg);
      this.context.exit(1);
    }
    const throttledOctokit = Octokit.plugin(throttling);
    // eslint-disable-next-line new-cap
    this.octokit = new throttledOctokit({
      auth: githubToken,
      throttle: {
        id: 'supersetbot',
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
          const howManyRetries = 10;
          octokit.log.warn(`Retry ${retryCount} out of ${howManyRetries} - retrying in ${retryAfter} seconds!`);
          if (retryCount < howManyRetries) {
            return true;
          }
          return false;
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
          octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
        },
      },
    });
    this.syncLabels = this.syncLabels.bind(this);
    this.#userInTeamCache = new Map();
  }

  unPackRepo() {
    const [owner, repo] = this.context.repo.split('/');
    return { repo, owner };
  }

  async getAllTags() {
    const options = this.octokit.rest.repos.listTags.endpoint.merge({
      ...this.unPackRepo(),
      per_page: 100,
    });

    const tags = await this.octokit.paginate(options);

    return tags;
  }

  async getLatestReleaseTag() {
    const tags = await this.getAllTags();
    const tagNames = tags.map((tag) => tag.name);

    // Simple SemVer regex
    const simpleSemverRegex = /^\d+\.\d+\.\d+$/;
    // Date-like pattern regex to exclude (e.g., 2020.01.01)
    const dateLikeRegex = /^\d{4}\.\d+\.\d+$/;

    const validTags = tagNames.filter(
      (tag) => simpleSemverRegex.test(tag) && !dateLikeRegex.test(tag),
    );

    // Sort tags in descending order (latest first)
    validTags.sort(compareSemVer).reverse();

    // Return the latest valid semver tag
    return validTags[0];
  }

  async label(issueNumber, label, actor = null, verbose = false, dryRun = false) {
    let hasPerm = true;
    if (actor && Github.isLabelProtected(label)) {
      hasPerm = await this.checkIfUserInTeam(actor, COMMITTER_TEAM, verbose);
    }
    if (hasPerm) {
      const addLabelWrapped = this.context.commandWrapper({
        func: this.octokit.rest.issues.addLabels,
        successMsg: `label "${label}" added to issue ${issueNumber}`,
        verbose,
        dryRun,
      });
      await addLabelWrapped({
        ...this.unPackRepo(),
        issue_number: issueNumber,
        labels: [label],
      });
    }
  }

  async createComment(body) {
    if (this.issueNumber) {
      await this.octokit.rest.issues.createComment({
        ...this.unPackRepo(),
        body,
        issue_number: this.issueNumber,
      });
    }
  }

  async unlabel(issueNumber, label, actor = null, verbose = false, dryRun = false) {
    let hasPerm = true;
    if (actor && Github.isLabelProtected(label)) {
      hasPerm = await this.checkIfUserInTeam(actor, COMMITTER_TEAM, verbose);
    }
    if (hasPerm) {
      const removeLabelWrapped = this.context.commandWrapper({
        func: this.octokit.rest.issues.removeLabel,
        successMsg: `label "${label}" removed from issue ${issueNumber}`,
        verbose,
        dryRun,
      });
      await removeLabelWrapped({
        ...this.unPackRepo(),
        issue_number: issueNumber,
        name: label,
      });
    }
  }

  async assignOrgLabel(issueNumber, verbose = false, dryRun = false) {
    const issue = await this.octokit.rest.issues.get({
      ...this.unPackRepo(),
      issue_number: issueNumber,
    });
    const username = issue.data.user.login;
    const orgs = await this.octokit.orgs.listForUser({ username });
    const orgNames = orgs.data.map((v) => v.login);

    // get list of matching github orgs
    const matchingOrgs = orgNames.filter((org) => ORG_LIST.includes(org));
    if (matchingOrgs.length) {
      const wrapped = this.context.commandWrapper({
        func: this.octokit.rest.issues.addLabels,
        successMsg: `added label(s) ${matchingOrgs} to issue ${issueNumber}`,
        errorMsg: "couldn't add labels to issue",
        verbose,
        dryRun,
      });
      wrapped({
        ...this.unPackRepo(),
        issue_number: issueNumber,
        labels: matchingOrgs,
      });
    }
  }

  async searchMergedPRs({
    query = '',
    onlyUnlabeled = true,
    verbose = false,
    startPage = 0,
    pages = 5,
  }) {
    // look for PRs
    let q = `repo:${this.context.repo} is:merged ${query}`;
    if (onlyUnlabeled) {
      q = `${q} -label:"🏷️ bot"`;
    }
    if (verbose) {
      this.context.log(`Query: ${q}`);
    }
    let prs = [];
    for (let i = 0; i < pages; i += 1) {
      if (verbose) {
        this.context.log(`Fetching PRs to process page ${i + 1} out of ${pages}`);
      }
      // eslint-disable-next-line no-await-in-loop
      const data = await this.octokit.search.issuesAndPullRequests({
        q,
        per_page: 100,
        page: startPage + i,
      });
      prs = [...prs, ...data.data.items];
    }
    if (verbose) {
      this.context.log(`Fetched ${prs.length}`);
    }
    return prs;
  }

  async syncLabels({
    labels,
    prId,
    actor = null,
    verbose = false,
    dryRun = false,
    existingLabels = null,
  }) {
    if (verbose) {
      this.context.log(`[PR: ${prId}] - sync labels ${labels}`);
    }
    let hasPerm = true;
    if (actor) {
      hasPerm = await this.checkIfUserInTeam(actor, COMMITTER_TEAM, verbose);
    }
    if (!hasPerm) {
      return;
    }
    let targetLabels = existingLabels;
    if (targetLabels === null) {
      // No labels have been passed as an array, so checking against GitHub
      const resp = await this.octokit.issues.listLabelsOnIssue({
        ...this.unPackRepo(),
        issue_number: prId,
      });
      targetLabels = resp.data.map((l) => l.name);
    }

    if (verbose) {
      this.context.log(`[PR: ${prId}] - target release labels: ${labels}`);
      this.context.log(`[PR: ${prId}] - existing labels on issue: ${existingLabels}`);
    }

    // Extract existing labels with the given prefixes
    const prefixes = ['🚢', '🍒', '🎯', '🏷️'];
    const existingPrefixLabels = targetLabels
      .filter((label) => prefixes.some((s) => typeof (label) === 'string' && label.startsWith(s)));

    // Labels to add
    const labelsToAdd = labels.filter((label) => !existingPrefixLabels.includes(label));
    if (verbose) {
      this.context.log(`[PR: ${prId}] - labels to add: ${labelsToAdd}`);
    }
    // Labels to remove
    const labelsToRemove = existingPrefixLabels.filter((label) => !labels.includes(label));
    if (verbose) {
      this.context.log(`[PR: ${prId}] - labels to remove: ${labelsToRemove}`);
    }

    // Add labels
    if (labelsToAdd.length > 0 && !dryRun) {
      await this.octokit.issues.addLabels({
        ...this.unPackRepo(),
        issue_number: prId,
        labels: labelsToAdd,
      });
    }

    // Remove labels
    if (labelsToRemove.length > 0 && !dryRun) {
      await Promise.all(labelsToRemove.map((label) => this.octokit.issues.removeLabel({
        ...this.unPackRepo(),
        issue_number: prId,
        name: label,
      })));
    }
    this.context.logSuccess(`synched labels for PR ${prId} with labels ${labels}`);
  }

  async checkIfUserInTeam(username, team, verbose = false) {
    let isInTeam = this.#userInTeamCache.get([username, team]);
    if (isInTeam !== undefined) {
      return isInTeam;
    }

    const [org, teamSlug] = team.split('/');
    const wrapped = this.context.commandWrapper({
      func: this.octokit.teams.getMembershipForUserInOrg,
      errorMsg: `User "${username}" is not authorized to alter protected labels.`,
      verbose,
    });
    const resp = await wrapped({
      org,
      team_slug: teamSlug,
      username,
    });
    isInTeam = resp?.data?.state === 'active';
    this.#userInTeamCache.set([username, team], isInTeam);
    return isInTeam;
  }

  static isLabelProtected(label) {
    return PROTECTED_LABEL_PATTERNS.some((pattern) => new RegExp(pattern).test(label));
  }

  async getSubPackageTree({ onlyBase = false } = {}) {
    if (this.#packageTree) {
      return this.#packageTree;
    }
    let subPackages = {};
    const cwd = process.cwd();
    /* eslint-disable no-restricted-syntax, no-await-in-loop */
    for (const reqsFile of reqsFiles) {
      if (onlyBase && reqsFile !== 'requirements/base.txt') {
        // eslint-disable-next-line no-continue
        continue;
      }
      const reqsFilePath = path.join(cwd, reqsFile);
      const reqsData = await fs.promises.readFile(reqsFilePath, 'utf8');
      const pinnedReqs = parsePinnedRequirementsTree(reqsData);
      subPackages = mergeParsedRequirementsTree(subPackages, pinnedReqs);
    }
    this.#packageTree = subPackages;
    return subPackages;
  }

  async allDescendantPackages(parent) {
    const tree = await this.getSubPackageTree();
    let descendants = [];
    for (const child of tree[parent] || []) {
      descendants = [...new Set([...descendants, ...(await this.allDescendantPackages(child))])];
    }
    return [parent, ...descendants];
  }

  async createAllBumpPRs({
    verbose = false, dryRun = false, useCurrentRepo = false, limit = null, shuffle = true,
    group = null, includeSubpackages = false, onlyBase = false,
  }) {
    const cwd = process.cwd();
    const tomlFilePath = path.join(cwd, 'pyproject.toml');

    // Parse dependencies from pyproject.yml
    let data;
    try {
      data = await fs.promises.readFile(tomlFilePath, 'utf8');
    } catch (error) {
      console.error('Error reading ./pyproject.toml');
      this.context.exit(1);
    }
    const parsedData = toml.parse(data);

    let prsCreated = 0;
    let deps = parsedData.project.dependencies;
    if (group) {
      console.log(`Processing group: ${group}`);
      const optDeps = parsedData.project['optional-dependencies'];
      if (group === 'all') {
        deps = Object.keys(optDeps).flatMap((k) => optDeps[k]);
      } else {
        deps = optDeps[group];
      }
    } else {
      const tree = await this.getSubPackageTree({ onlyBase });
      deps = Object.keys(tree);
    }
    if (shuffle) {
      deps = shuffleArray(deps);
    }

    console.log(`Processing ${deps.length} libraries:`, deps);

    /* eslint-disable no-restricted-syntax, no-await-in-loop */
    for (const libRange of deps) {
      const pythonPackage = libRange.match(/^[^>=<;[\s]+/)[0];
      console.log(`Processing library: ${pythonPackage}`);
      try {
        const url = await this.createBumpLibPullRequest({
          pythonPackage, verbose, dryRun, useCurrentRepo, includeSubpackages,
        });
        if (url) {
          prsCreated += 1;
        }
      } catch (error) {
        console.error(`Error creating PR for "${pythonPackage}":`, error);
      }
      if (limit && prsCreated >= limit) {
        break;
      }
    }
  }

  async rebase({ verbose = false }) {
    const shellOptions = {
      verbose, raiseOnError: true, exitOnError: false,
    };
    await runShellCommand({ command: 'git config user.name "GitHub Action"', ...shellOptions });
    await runShellCommand({ command: 'git config user.email "action@github.com"', ...shellOptions });
    await runShellCommand({ command: 'git pull --rebase origin master', ...shellOptions });
    await runShellCommand({ command: 'git push', ...shellOptions });
  }

  async searchExistingPRs(branchName) {
    const owner = this.context.repo.split('/')[0];
    const resp = await this.octokit.rest.pulls.list({
      ...this.unPackRepo(),
      state: 'open',
      head: `${owner}:${branchName}`,
    });
    return resp.data;
  }

  processPythonReqsDiffOutput(rawOutput) {
    const lines = rawOutput.split('\n');
    const result = {};

    lines.forEach((line) => {
      // Filter out lines that do not contain a change in library version
      if (!line.includes('==')) {
        return;
      }

      const isDeletion = line.startsWith('-');
      const isAddition = line.startsWith('+');
      if (isDeletion || isAddition) {
        // Extract lib name and version
        const [pythonPackage, version] = line.slice(1).split('==');
        const lib = pythonPackage.toLowerCase();

        // Ensure the lib entry exists in the result object
        if (!result[lib]) {
          result[lib] = { before: null, after: null };
        }

        // Update the lib version based on the line type
        if (isDeletion) {
          result[lib].before = version;
        } else if (isAddition) {
          result[lib].after = version;
        }
      }
    });

    return result;
  }

  async fixReqsFile(filePath) {
    // Somehow pip-compile-multi generates replaces the '-e file:.' with a hard-coded local path
    // hoping they fix it in the future. In the meantime we can fix it here.
    try {
      // Read the file
      const content = await fs.promises.readFile(filePath, { encoding: 'utf-8' });

      let needsUpdate = false;
      // Process each line
      const updatedLines = content.split('\n').map((line) => {
        if (line.startsWith('-e file:') && !line.startsWith('-e file:.')) {
          needsUpdate = true;
          return '-e file:.';
        }
        return line;
      });

      // Join the lines back and write to the file
      if (needsUpdate) {
        await fs.promises.writeFile(filePath, updatedLines.join('\n'), { encoding: 'utf-8' });
      }
    } catch (error) {
      console.error('Error updating the file:', error);
    }
  }

  async createBumpLibPullRequest({
    pythonPackage, verbose = false, dryRun = false,
    useCurrentRepo = false, includeSubpackages = false,
  }) {
    const cwd = './';

    const shellOptions = {
      cwd, verbose, raiseOnError: true, exitOnError: false,
    };

    if (!useCurrentRepo) {
      shellOptions.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'update-'));
      if (verbose) {
        console.log('CWD:', shellOptions.cwd);
      }

      // Clone the repo
      await runShellCommand({ command: `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 git@github.com:${this.context.repo}.git ${shellOptions.cwd}`, ...shellOptions });
    } else {
      await runShellCommand({ command: 'git checkout master', ...shellOptions });
      await runShellCommand({ command: 'git reset --hard', ...shellOptions });
      await runShellCommand({ command: 'git clean -f', ...shellOptions });
    }

    // Run pip-compile-multi
    let pythonPackages = [pythonPackage];
    if (includeSubpackages) {
      pythonPackages = await this.allDescendantPackages(pythonPackage);
    }
    console.log('Packages to bump', pythonPackages);
    for (const lib of pythonPackages) {
      try {
        await runShellCommand({ command: `pip-compile-multi --use-cache -P ${lib}`, ...shellOptions });
      } catch (error) {
        console.error(`Error bumping "${lib}":`, error);
      }
    }
    for (const reqsFile of reqsFiles) {
      await this.fixReqsFile(path.join(shellOptions.cwd, reqsFile));
    }

    // Diffing
    let rawDiff = await runShellCommand({ command: 'git diff --color=never --unified=0', ...shellOptions });
    rawDiff = rawDiff.stdout;

    const libsBeforeAfter = this.processPythonReqsDiffOutput(rawDiff);
    if (verbose && rawDiff) {
      console.log('Diff:', rawDiff);
      console.log('Libs before/after:', libsBeforeAfter);
    }

    let hasChanges = false;
    for (const lib of pythonPackages) {
      const { before = null, after = null } = libsBeforeAfter[lib] || {};
      if (before !== after) {
        hasChanges = true;
        console.log(`Changes detected for "${lib}": ${before} -> ${after}`);
      }
    }

    if (!hasChanges) {
      console.log('No changes detected');
    } else {
      const lib = pythonPackage;
      const { before = null, after = null } = libsBeforeAfter[lib] || {};

      let commitMessage = `chore(🦾): bump python ${lib} ${before} -> ${after}`;
      if (before === null || before === after) {
        commitMessage = `chore(🦾): bump python ${lib} subpackage(s)`;
      }

      // Create branch
      const branchName = `supersetbot-bump-${lib}`;
      await runShellCommand({ command: `git checkout -b ${branchName}`, ...shellOptions });

      // Commit changes
      await runShellCommand({ command: 'git add .', ...shellOptions });
      await runShellCommand({ command: `git commit -m "${commitMessage}"`, ...shellOptions });

      // Make a tree representation of the dependencies
      const tree = await this.getSubPackageTree();
      let depTree = '';
      // eslint-disable-next-line no-inner-declarations
      function recurseVias(library, level = 0) {
        depTree += `${'  '.repeat(level) + library}\n`;
        tree[library].vias.forEach((child) => recurseVias(child, level + 1));
        return depTree;
      }
      depTree = recurseVias(lib);

      const tbt = '```';
      const body = `Updates the python "${lib}" library version from ${before} to ${after}. \n\nGenerated by @supersetbot 🦾\n\n🌳:\n${tbt}\n${depTree}${tbt}`;

      if (dryRun) {
        console.log(`Skipping PR creation for "${lib}" due to dry-run mode.`);
        console.log(`PR title would have been: ${commitMessage}`);
        console.log(`PR body would have been: ${body}`);
      } else {
        // Push changes
        await runShellCommand({ command: `git push -f origin ${branchName}`, ...shellOptions });
        const existingPRs = await this.searchExistingPRs(branchName);
        if (existingPRs.length === 0) {
          try {
            // Create a PR
            const resp = await this.octokit.pulls.create({
              ...this.unPackRepo(),
              title: commitMessage,
              head: branchName,
              base: 'master',
              body,
            });
            console.log(`Pull request created: ${resp.data.html_url}`);

            const prNumber = resp.data.number;
            // Labeling the PR
            await this.octokit.issues.addLabels({
              ...this.unPackRepo(),
              issue_number: prNumber,
              labels: ['supersetbot'],
            });

            // This is stupid, but it's one of the only way to trigger the CI checks
            console.log('Close/reopen the PR to trigger the CI checks.');
            await this.octokit.pulls.update({
              ...this.unPackRepo(),
              pull_number: prNumber,
              state: 'closed',
            });
            await this.octokit.pulls.update({
              ...this.unPackRepo(),
              pull_number: prNumber,
              state: 'open',
            });
            return resp.data.html_url;
          } catch (error) {
            console.error(error);
            throw error; // Rethrow the error if you want the caller to handle it
          }
        } else {
          console.log('PR already exists:', existingPRs[0].html_url);
        }
      }
    }
    // Cleaning up
    if (!useCurrentRepo) {
      fs.rmSync(shellOptions.cwd, { recursive: true, force: true });
    }
    return null;
  }
}

export default Github;
