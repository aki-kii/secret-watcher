import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite-plus';

// The next synth would revert any change vp makes to these.
const projenGenerated = readFileSync('.gitattributes', 'utf8')
  .split('\n')
  .filter((line) => line.includes('linguist-generated'))
  .map((line) => line.split(/\s+/)[0].replace(/^\//, ''));

const buildOutput = ['lib/**', 'dist/**', '.jsii', 'tsconfig.tsbuildinfo', 'coverage/**'];
const integSnapshots = ['test/*.snapshot/**'];
const worktrees = ['.claude/worktrees/**'];

export default defineConfig({
  fmt: {
    singleQuote: true,
    trailingComma: 'all',
    semi: true,
    printWidth: 100,
    ignorePatterns: [...projenGenerated, ...buildOutput, ...integSnapshots, ...worktrees],
  },
  lint: {
    plugins: ['typescript', 'unicorn', 'oxc', 'import'],
    ignorePatterns: [...projenGenerated, ...buildOutput, ...integSnapshots, ...worktrees],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        // The plugin crashes on files outside a tsconfig, such as .projenrc.ts.
        files: ['src/**/*.ts', 'test/**/*.ts'],
        jsPlugins: ['oxlint-plugin-awscdk'],
        // The `strict` preset. Importing it fails because this config loads as CommonJS.
        rules: {
          'awscdk/construct-constructor-property': 'error',
          'awscdk/no-construct-in-interface': 'error',
          'awscdk/no-construct-in-public-property-of-construct': 'error',
          'awscdk/no-construct-stack-suffix': 'error',
          'awscdk/no-import-private': 'error',
          'awscdk/no-mutable-property-of-props-interface': 'error',
          'awscdk/no-mutable-public-property-of-construct': 'error',
          'awscdk/no-parent-name-construct-id-match': [
            'error',
            { disallowContainingParentName: true },
          ],
          'awscdk/no-unused-props': 'error',
          'awscdk/no-variable-construct-id': 'error',
          'awscdk/pascal-case-construct-id': 'error',
          'awscdk/prefer-grants-property': 'error',
          'awscdk/prevent-construct-id-collision': 'error',
          'awscdk/props-name-convention': 'error',
          'awscdk/require-jsdoc': 'error',
          'awscdk/require-passing-this': 'error',
          'awscdk/require-props-default-doc': 'error',
        },
      },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/cdk.out/**', 'test/*.snapshot/**'],
  },
});
