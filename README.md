# secret-watcher

An AWS CDK construct that checks, at deploy time, whether an SSM parameter or a Secrets Manager secret has a new version, and updates a resource that depends on it only when it does.

## Why

A resource that uses a secret often needs to be updated when the secret changes: a Lambda function that caches it at cold start, a custom resource that pushes it to a third-party service, a task definition that bakes it in. When the secret is managed outside CDK (rotated, or edited in the console), CloudFormation cannot see the change, so the next `cdk deploy` leaves the resource as it is.

The usual workarounds each give something up. Reading the value into the template exposes it. Forcing an update on every deployment updates the resource even when nothing changed.

`SecretWatcher` reads only the version of the parameter or secret during deployment and exposes a hash of it. Pass that hash to a property of the resource, and CloudFormation updates the resource only when the version has changed.

## Usage

```ts
import { SecretWatcher, WatchTarget } from 'secret-watcher';

const secret = secretsmanager.Secret.fromSecretNameV2(this, 'ApiKey', 'prod/api-key');
const watcher = new SecretWatcher(this, 'ApiKeyWatcher', {
  target: WatchTarget.fromSecret(secret),
});
```

For an SSM parameter, use `WatchTarget.fromParameter(parameter)`.

### A Lambda function

Put the hash in the description or an environment variable. A new version updates the function, which starts new execution environments that read the new value.

```ts
new lambda.Function(this, 'Api', {
  // ...
  description: `api-key:${watcher.hash()}`,
  // or
  environment: { API_KEY_VERSION: watcher.hash() },
});
```

### A custom resource

Pass the hash as a property. A new version sends an `Update` event to the handler, which can then read the value and act on it.

```ts
new CustomResource(this, 'PushApiKey', {
  serviceToken: provider.serviceToken,
  properties: {
    SecretArn: secret.secretArn,
    SecretVersionHash: watcher.hash(),
  },
});
```

## How it works

1. The watcher is a custom resource with a `Nonce` property that defaults to `Date.now()`. The nonce changes on every synth, so CloudFormation updates the watcher on every deployment.
2. On each update, the watcher's Lambda function reads the current version and returns `Hash`, the first 32 hex characters of `sha256("<parameter name or secret ARN>:<version>")`. For a parameter the version is `Version` from `GetParameter` (without decryption); for a secret it is the version ID staged as `AWSCURRENT`, from `DescribeSecret`. The value is never read.
3. `hash()` returns an `Fn::GetAtt` on that attribute. CloudFormation resolves it and compares the resolved value with the previous one. The consumer is updated only when the hash differs, which happens only when the version changed.

The watcher keeps the same physical ID (the parameter name or secret ARN) across updates, so it is never replaced.

## IAM permissions

The watcher's Lambda function is granted one action on the one target:

| Target                 | Action                          |
| ---------------------- | ------------------------------- |
| SSM parameter          | `ssm:GetParameter`              |
| Secrets Manager secret | `secretsmanager:DescribeSecret` |

`DescribeSecret` cannot read the secret value. `GetParameter` can read a `String` parameter's value, but the function calls it without decryption and uses only the version. The function returns only the hash.

## Caveats

- **Put the watcher in the same stack as the consumer.** A cross-stack reference becomes an export, and CloudFormation does not allow an export to change while another stack imports it. The first new version would fail the deployment.
- **`cdk diff` always shows the watcher's `Nonce`, and never shows the consumer.** The hash is resolved during deployment, so whether the consumer will be updated is not known beforehand.
- **Token values skip synth-time checks.** L2 constructs cannot validate a value that contains a token. For example, `lambda.Function` does not check the description length (256 characters) when it contains `hash()`; an overlong value fails at deploy time instead.
- **Pick a property whose change updates the resource, not one that replaces it, and that has the effect you want.** A property that forces replacement recreates the resource on every new version. A property that is stored but never read may update the resource without changing anything it does.
- **Changes are detected only at deploy time.** A new version does nothing until the next deployment. If the resource must react when the secret changes, use an EventBridge rule on the Secrets Manager or Parameter Store event instead.
- **Each watcher creates its own Lambda function and custom resource provider.** Many watchers mean many functions.

## Development

This project is managed by [projen](https://github.com/projen/projen). Project configuration lives in `.projenrc.ts`; generated files (`package.json`, `tsconfig.json`, `.github/workflows/`, and so on) are overwritten on the next synth, so edit `.projenrc.ts` instead.

```sh
mise install              # install Node.js and pnpm
pnpm install              # install dependencies
npx projen                # synthesize generated files from .projenrc.ts
npx projen build          # bundle the handler -> compile (jsii) -> docgen -> test -> package
npx projen test           # vp test run, then vp check (format, lint, type check)
npx projen integ          # deploy test/integ.*.ts to AWS (needs credentials), then destroy it
```

The handler in `src/handler/` is bundled with esbuild at build time into `assets/`, which ships in the package. Consumers do not need esbuild or Docker to synthesize. The AWS SDK is not bundled; the Lambda Node.js runtime provides it.

Formatting, linting, type checking and tests run through [Vite+](https://viteplus.dev/) (`vp`): Oxfmt, Oxlint with [oxlint-plugin-awscdk](https://awscdk-lint.dev/), and Vitest, all configured in `vite.config.ts`.

## License

Apache-2.0
