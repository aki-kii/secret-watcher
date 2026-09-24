# API Reference <a name="API Reference" id="api-reference"></a>

## Constructs <a name="Constructs" id="Constructs"></a>

### SecretWatcher <a name="SecretWatcher" id="secret-watcher.SecretWatcher"></a>

Exposes a hash of the current version of an SSM parameter or Secrets Manager secret, read at deploy time.

Pass `hash()` to a property of another resource in the same stack. CloudFormation updates that
resource only when the target has a new version since the last deployment, including a version
created outside CDK.

**Note**: the watcher itself runs on every deployment, so `cdk diff` always shows a change to it.

#### Initializers <a name="Initializers" id="secret-watcher.SecretWatcher.Initializer"></a>

```typescript
import { SecretWatcher } from 'secret-watcher'

new SecretWatcher(scope: Construct, id: string, props: SecretWatcherProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#secret-watcher.SecretWatcher.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#secret-watcher.SecretWatcher.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#secret-watcher.SecretWatcher.Initializer.parameter.props">props</a></code> | <code><a href="#secret-watcher.SecretWatcherProps">SecretWatcherProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="secret-watcher.SecretWatcher.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="secret-watcher.SecretWatcher.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="secret-watcher.SecretWatcher.Initializer.parameter.props"></a>

- *Type:* <a href="#secret-watcher.SecretWatcherProps">SecretWatcherProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#secret-watcher.SecretWatcher.toString">toString</a></code> | Returns a string representation of this construct. |
| <code><a href="#secret-watcher.SecretWatcher.with">with</a></code> | Applies one or more mixins to this construct. |
| <code><a href="#secret-watcher.SecretWatcher.hash">hash</a></code> | A hash of the target's current version: the first 32 hex characters of sha256(`<parameter name or secret ARN>:<version>`). |

---

##### `toString` <a name="toString" id="secret-watcher.SecretWatcher.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

##### `with` <a name="with" id="secret-watcher.SecretWatcher.with"></a>

```typescript
public with(mixins: ...IMixin[]): IConstruct
```

Applies one or more mixins to this construct.

Mixins are applied in order. The list of constructs is captured at the
start of the call, so constructs added by a mixin will not be visited.
Use multiple `with()` calls if subsequent mixins should apply to added
constructs.

###### `mixins`<sup>Required</sup> <a name="mixins" id="secret-watcher.SecretWatcher.with.parameter.mixins"></a>

- *Type:* ...constructs.IMixin[]

The mixins to apply.

---

##### `hash` <a name="hash" id="secret-watcher.SecretWatcher.hash"></a>

```typescript
public hash(): string
```

A hash of the target's current version: the first 32 hex characters of sha256(`<parameter name or secret ARN>:<version>`).

It changes only when the target has a new version.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#secret-watcher.SecretWatcher.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### `isConstruct` <a name="isConstruct" id="secret-watcher.SecretWatcher.isConstruct"></a>

```typescript
import { SecretWatcher } from 'secret-watcher'

SecretWatcher.isConstruct(x: any)
```

Checks if `x` is a construct.

Use this method instead of `instanceof` to properly detect `Construct`
instances, even when the construct library is symlinked.

Explanation: in JavaScript, multiple copies of the `constructs` library on
disk are seen as independent, completely different libraries. As a
consequence, the class `Construct` in each copy of the `constructs` library
is seen as a different class, and an instance of one class will not test as
`instanceof` the other class. `npm install` will not create installations
like this, but users may manually symlink construct libraries together or
use a monorepo tool: in those cases, multiple copies of the `constructs`
library can be accidentally installed, and `instanceof` will behave
unpredictably. It is safest to avoid using `instanceof`, and using
this type-testing method instead.

###### `x`<sup>Required</sup> <a name="x" id="secret-watcher.SecretWatcher.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#secret-watcher.SecretWatcher.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |

---

##### `node`<sup>Required</sup> <a name="node" id="secret-watcher.SecretWatcher.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---


## Structs <a name="Structs" id="Structs"></a>

### SecretWatcherProps <a name="SecretWatcherProps" id="secret-watcher.SecretWatcherProps"></a>

Properties for `SecretWatcher`.

#### Initializer <a name="Initializer" id="secret-watcher.SecretWatcherProps.Initializer"></a>

```typescript
import { SecretWatcherProps } from 'secret-watcher'

const secretWatcherProps: SecretWatcherProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#secret-watcher.SecretWatcherProps.property.target">target</a></code> | <code><a href="#secret-watcher.WatchTarget">WatchTarget</a></code> | The parameter or secret to watch. |
| <code><a href="#secret-watcher.SecretWatcherProps.property.nonce">nonce</a></code> | <code>string</code> | A value that changes on every deployment, so that CloudFormation runs the watcher each time. |

---

##### `target`<sup>Required</sup> <a name="target" id="secret-watcher.SecretWatcherProps.property.target"></a>

```typescript
public readonly target: WatchTarget;
```

- *Type:* <a href="#secret-watcher.WatchTarget">WatchTarget</a>

The parameter or secret to watch.

---

##### `nonce`<sup>Optional</sup> <a name="nonce" id="secret-watcher.SecretWatcherProps.property.nonce"></a>

```typescript
public readonly nonce: string;
```

- *Type:* string
- *Default:* Date.now().toString()

A value that changes on every deployment, so that CloudFormation runs the watcher each time.

Set a fixed value only where a stable template matters, such as a snapshot test.

---

## Classes <a name="Classes" id="Classes"></a>

### WatchTarget <a name="WatchTarget" id="secret-watcher.WatchTarget"></a>

The SSM parameter or Secrets Manager secret a `SecretWatcher` watches.

#### Initializers <a name="Initializers" id="secret-watcher.WatchTarget.Initializer"></a>

```typescript
import { WatchTarget } from 'secret-watcher'

new WatchTarget()
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |

---


#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#secret-watcher.WatchTarget.fromParameter">fromParameter</a></code> | Watch an SSM parameter. |
| <code><a href="#secret-watcher.WatchTarget.fromSecret">fromSecret</a></code> | Watch a Secrets Manager secret. |

---

##### `fromParameter` <a name="fromParameter" id="secret-watcher.WatchTarget.fromParameter"></a>

```typescript
import { WatchTarget } from 'secret-watcher'

WatchTarget.fromParameter(parameter: IParameter)
```

Watch an SSM parameter.

The watcher is granted `ssm:GetParameter` on the parameter and reads only its version.

###### `parameter`<sup>Required</sup> <a name="parameter" id="secret-watcher.WatchTarget.fromParameter.parameter.parameter"></a>

- *Type:* aws-cdk-lib.aws_ssm.IParameter

---

##### `fromSecret` <a name="fromSecret" id="secret-watcher.WatchTarget.fromSecret"></a>

```typescript
import { WatchTarget } from 'secret-watcher'

WatchTarget.fromSecret(secret: ISecret)
```

Watch a Secrets Manager secret.

The watcher is granted `secretsmanager:DescribeSecret` on the secret, which cannot read the secret value.

###### `secret`<sup>Required</sup> <a name="secret" id="secret-watcher.WatchTarget.fromSecret.parameter.secret"></a>

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

---




