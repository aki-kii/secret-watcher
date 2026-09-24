import { awscdk, Component, TomlFile } from 'projen';
import { GitHub } from 'projen/lib/github';
import type { JobStep } from 'projen/lib/github/workflows-model';
import { NodePackageManager, UpgradeDependenciesSchedule } from 'projen/lib/javascript';

// vite-plus requires Node.js >= 24.11.
const nodeVersion = '24';

const project = new awscdk.AwsCdkConstructLibrary({
  name: 'secret-watcher',
  description:
    'AWS CDK construct that updates a resource at deploy time only when an SSM parameter or Secrets Manager secret changed outside CDK',
  author: 'aki-kii',
  authorAddress: 'impeeeeedance@gmail.com',
  repositoryUrl: 'https://github.com/aki-kii/secret-watcher',
  license: 'Apache-2.0',
  keywords: [
    'aws',
    'cdk',
    'aws-cdk',
    'ssm',
    'parameter-store',
    'secrets-manager',
    'custom-resource',
  ],

  // First release with Runtime.NODEJS_24_X.
  cdkVersion: '2.224.0',
  defaultReleaseBranch: 'main',
  jsiiVersion: '~6.0.0',
  // jsii 6 cannot compile with TypeScript 7, projen's default.
  typescriptVersion: '~6.0.0',
  projenrcTs: true,
  packageManager: NodePackageManager.PNPM,
  pnpmVersion: '12.4.2',
  workflowNodeVersion: nodeVersion,
  buildWorkflowOptions: {
    mutableInstall: false,
  },
  pnpmOptions: {
    workspaceYamlOptions: {
      minimumReleaseAge: 1440,
      // Its postinstall only re-checks the platform binary pnpm already installed.
      allowBuilds: { esbuild: false },
    },
  },

  // Replaced by Vite+ (vite.config.ts).
  eslint: false,
  prettier: false,
  jest: false,
  devDeps: [
    'vite-plus@^0.3.3',
    'oxlint-plugin-awscdk',
    '@aws-cdk/integ-runner',
    // Must match cdkVersion.
    '@aws-cdk/integ-tests-alpha@2.224.0-alpha.0',
    'aws-cdk',
    'tsx',
    // Types only; the handler uses the SDK bundled with the Lambda Node.js runtime.
    '@aws-sdk/client-secrets-manager',
    '@aws-sdk/client-ssm',
    '@types/aws-lambda',
  ],

  depsUpgradeOptions: {
    workflowOptions: {
      schedule: UpgradeDependenciesSchedule.WEEKLY,
    },
    // Pinned on purpose; upgrade by hand.
    exclude: ['aws-cdk-lib', '@aws-cdk/integ-tests-alpha', 'typescript', 'jsii', 'jsii-rosetta'],
  },

  gitignore: [
    '*.js',
    '*.d.ts',
    'cdk.out/',
    '.DS_Store',
    '.idea/',
    // Scratch space for agent-generated research and drafts. Local only.
    'docs/ai-output/',
    'cdk-integ.out.*',
    // Integ snapshots are committed, bundled assets included.
    '!/test/*.snapshot/**',
    '.claude/worktrees/',
    '.claude/review/.state/',
  ],
  githubOptions: {
    // The Mergify app is not installed, and its rules need a review a sole maintainer cannot give.
    mergify: false,
    pullRequestLintOptions: {
      semanticTitleOptions: {
        types: ['feat', 'fix', 'chore', 'docs', 'test', 'refactor', 'ci'],
      },
    },
  },

  // Enable once the distribution story (npm only vs. multi-language via jsii) is settled.
  release: false,
});

// Bundled at build time so consumers never run esbuild or Docker at synth time.
project.bundler.addBundle('src/handler/secret-watcher.ts', {
  target: 'node24',
  platform: 'node',
  externals: ['@aws-sdk/*'],
  tsconfigPath: project.tsconfigDev.fileName,
});

project.testTask.reset('vp test run');
project.testTask.exec('vp check');

const integ = project.addTask('integ', {
  description:
    'Deploy test/integ.*.ts to AWS, run the assertions, compare against the committed snapshots, then destroy',
});
integ.spawn(project.tasks.tryFind('bundle')!);
// --force deploys even when the snapshot is unchanged; the PR gate relies on a real run.
integ.exec(
  'integ-runner --force --parallel-regions ap-northeast-1 --language typescript --app "tsx {filePath}"',
);
project.addTask('integ:destroy', {
  description: 'Destroy the stacks left behind by integ',
  exec: 'for d in test/integ.*.snapshot; do [ -d "$d" ] || continue; cdk destroy --app "$d" --all --force; done',
});

new TomlFile(project, 'mise.toml', {
  obj: {
    tools: {
      node: nodeVersion,
      pnpm: project.package.pnpmVersion,
    },
  },
});

// Actions projen references by tag, pinned to the commit the tag pointed at.
// v2.1.0
const pnpmSetup = 'pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b';
// v7.0.0
project.github?.actions.set(
  'actions/setup-node',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
);
// v8.1.1; the upgrade workflow hands it PROJEN_GITHUB_TOKEN.
project.github?.actions.set(
  'peter-evans/create-pull-request',
  'peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1',
);

// pnpm/action-setup installs pnpm from npm; pnpm 12 ships as a native binary through pnpm/setup.
class NativePnpmSetup extends Component {
  public preSynthesize(): void {
    for (const workflow of GitHub.of(this.project)?.workflows ?? []) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        if (!('steps' in job)) continue;
        // projen renders some jobs' steps lazily at synth time.
        const original = job.steps as JobStep[] | (() => JobStep[]);
        const steps = () =>
          (typeof original === 'function' ? original() : original).map((step) =>
            step.uses?.startsWith('pnpm/action-setup@')
              ? { ...step, uses: pnpmSetup, with: { ...step.with, install: false } }
              : step,
          );
        workflow.updateJob(id, { ...job, steps: steps as unknown as JobStep[] });
      }
    }
  }
}
new NativePnpmSetup(project);

project.addPackageIgnore('/vite.config.ts');
project.addPackageIgnore('/mise.toml');
project.addPackageIgnore('/.claude/');

project.synth();
