---
description: "The shared per-call sandbox policy resolver and current model context for users and maintainers composing, configuring, or debugging file-effect policy across enforcing capabilities."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-policy

English | [中文](README.zh.md)

## Summary

Use this package to apply one file-effect policy to every confined bash, filesystem, and terminal call. Deployments choose a default mode and fallback workspace root, while each session can switch modes independently. Session choices survive restart, and all enforcing capabilities use the same mode and workspace for a call. Before each model request, the model receives the effective policy and workspace without an inventory of mounted capabilities.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in any composition where sandbox-enforcing capabilities run: it owns the deployment default and the per-session overrides those capabilities consume, and it contributes the current policy to the model's runtime-context snapshot.

### When to choose it

Choose it for every composition with confined capabilities (bash, filesystem, terminal) so one policy home keeps them from drifting into different modes or workspace roots. Skip it only when nothing enforces sandbox policy — with no consumers, the resolved policy has no effect.

### Minimal configuration

Load the package with a default mode; the fail-safe default is `read-only`, and a deployment that wants a workspace-writable agent opts into `workspace-write` explicitly.

```yaml
- name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: /absolute/path/to/workspace
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `read-only` | The deployment default mode a session starts from, validated at load |
| `workspaceRoot` | `process.cwd()` | Absolute fallback root for agentless calls or sessions without a cwd; relative values fail at load. Normal agent calls use the session's immutable cwd |
| `network` | `on` | Network for confined commands: `on`, `off` or `allowlist` (see `SandboxNetwork` in `@deepseek-ai/dsh-sandbox`) |
| `allowedHosts` | `[]` | Hosts `allowlist` admits; entries are lower-cased, stripped of scheme, path and port, and invalid ones dropped. `*.example.com` admits subdomains |
| `networkFile` | none | Absolute path of a JSON file `{ "network": …, "allowedHosts": [...] }` that replaces the two fields above when it holds a valid `network`; re-read when it changes, so a settings page can switch the policy without a restart |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sandbox-policy) is the exhaustive source for every accepted field and its JSDoc.

### Switching a session's mode

A session's mode can be switched at runtime through a UI policy control or an explicit switch; the switch is recorded in the session log and takes effect on the session's next confined call. The switch survives restart through replay, and each session keeps its own mode — two sessions never see each other's state. A switched session keeps its immutable workspace cwd as the writable boundary.

### Holding a session at a narrower mode

Another plugin can hold sessions at or below a mode with `limit(source)`, where the source reports `{ mode, reason }` for a session or nothing. Plan mode uses it to keep a planning session read-only. The narrowest reported ceiling caps the resolved mode, including an approved explicit mode, so an escalation cannot lift it. Register through `ctx.effect` so the source is removed when the registering plugin unloads; `ceilingOf(session)` reports the ceiling in force. A ceiling reported for a session also holds every session started from it: the policy walks each session's `parentSession` through the agents service, so subagents and workflow children of a planning session, and theirs, stay read-only too.

### Failures and recovery

An invalid configured mode is rejected when the plugin loads, so a typo fails loud instead of silently changing policy. A session without a cwd, and agentless calls, fall back to the configured workspace root; a call with an approved explicit mode uses that mode for exactly that call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains policy resolution, the per-session store, and the model-visible contribution; the observable behavior is fully covered in [Use this package](#use-this-package).

### Resolution precedence

`resolve({ session, mode })` returns one complete per-call policy: an approved explicit mode outranks the session's last `sandbox/mode` event, which outranks the deployment default, and the narrowest registered ceiling for the session then caps the result. The session's immutable `cwd` supplies the workspace root; otherwise the configured fallback applies. Absolute execution-world spelling is preserved. Enforcing providers canonicalize the root on their own filesystem, so remote `symlink/..` paths are never resolved on the Harness host.

### The per-session store

A runtime switch is one log-only `sandbox/mode` event on the session it applies to — the switch IS its event, and nothing mutates mode state out of band. `effective = explicit grant ?? fold(events) ?? deployment default`, so an override survives restart by replay and two sessions never see each other's state. Workspace identity needs no event: the immutable `SessionHeader.cwd` recorded at creation is the root for every call in that session. The event stays log-only; before each request, the owner contributes the current fact to the full runtime-context snapshot, and the agent loop logs that snapshot as a sourced `user/message`.

### Model-visible text

The `sandbox:policy` contribution states the mode's capability-neutral file-effect contract and the recorded session workspace under `workspace-write`. It does not enumerate mounted capabilities; tool plugins retain operation-specific denial and escalation guidance, approval policy contributes separately to the same snapshot, and plan guidance remains `dsh-plan-mode`'s system section.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SandboxPolicyService`, `Config` schema, policy resolution and context contribution |
| [`src/session-mode.ts`](src/session-mode.ts) | The `sandbox/mode` event, its fold, and the write path |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the subsystem reference for the shared vocabulary, then the seam contract and the cross-family decision.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and enforcement semantics.
- [Sandbox seam package](../sandbox/README.md) — the confinement contract every enforcing capability implements.
- [historical Cross-family file sandbox decision](../../../.agents/notes/archived/feature/2026-07-14-cross-family-fs-sandbox.md) — why one shared policy home exists.

-----

<a id="model-experience"></a>
## Model Experience

### Current file sandbox policy

#### What the model sees

One `sandbox:policy` contribution in the current runtime-context snapshot for every agent session. It does not enumerate mounted capabilities. Tool plugins retain operation and escalation guidance, approval policy contributes separately to the same snapshot, and plan guidance remains `dsh-plan-mode`'s system section.

##### Read-only

```markdown
Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.
```

##### Workspace-write

```markdown
Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "<workspace root>". Some platform temporary areas may also be writable.
```

##### Danger-full-access

```markdown
Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.
```

##### Held by a ceiling

When a ceiling narrows the mode, the text names the reason instead:

```markdown
Current DSH file policy: read-only because plan mode is on, and file changes wait until the user approves the plan. Operations enforced by the DSH file sandbox cannot widen past read-only until that changes, and a sandbox escalation cannot lift it, so do not request one.
```

##### Network limits

When `network` is `off` or `allowlist` and the mode is not `danger-full-access`, a few sentences follow the file policy, for example on macOS:

```markdown
Network for commands: off. Direct connections to other computers are blocked, so downloads, package installs and git fetches normally fail. This is not a complete barrier: programs on this computer that forward traffic, such as local proxies and SSH tunnels listening on its loopback interface, can still be reached, and system services (opening a URL with open, launchd jobs) can make requests outside the sandbox. Do not use them to get around this setting. A command that needs more network access can be retried once with sandbox_permissions danger-full-access, which the user must approve.
```

Under `allowlist` it names the hosts and the proxy variables instead. The middle sentence depends on the platform (`NETWORK_LEAKS`): on Linux it names Unix sockets, a local proxy or tunnel listening on one, the Docker socket, and D-Bus with systemd-run. The retry sentence is left out while a ceiling holds the session.

#### Token effect

One concise durable context message on the first request and each effective policy change; unchanged requests add nothing. `workspace-write` carries only the recorded session workspace path; platform-specific temporary paths are summarized without adding host-dependent bytes.

#### KV Cache effect

The stable system prompt remains byte-identical across mode changes. A changed full context snapshot is appended after retained history, preserving the prior cached prefix; subsequent unchanged requests reuse that retained snapshot.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the policy surface this package provides. They are current package constraints, not a general sandbox comparison or a task backlog.

- **One primary workspace root per session** — policy resolves `SessionHeader.cwd`; extra writable roots are not part of `SandboxExecutionPolicy`.
- **Network limits are not a complete barrier** — loopback stays reachable so local dev servers and databases keep working, so a local proxy or SSH tunnel (Clash on `127.0.0.1:7890`, `ssh -D`, a corporate proxy) still carries traffic out on macOS, and Unix sockets (the Docker socket, D-Bus and `systemd-run`, a proxy listening on one) do on Linux; macOS `open URL` and launchd also act outside the sandbox. The model is told so rather than told that commands cannot connect.
- **Network policy is per deployment, not per session** — `network` and `networkFile` apply to every session; there is no per-session network override or escalation narrower than `danger-full-access`.
- **Process policy is outside the vocabulary** — no knob here restricts which processes a command may see or signal beyond what the backend does.
- **Temporary areas are deliberately summarized** — enforcing backends grant different platform temporary areas, which are selected after policy resolution and therefore cannot be enumerated truthfully in the current context.

Policy-context replacements must be counter-tested on denied-then-escalatable tasks to verify that the model still attempts the initial tool call. The [historical five-of-twelve zero-tool-call measurement](../../../.agents/notes/archived/feature/2026-07-06-sandbox.md) records the failure this check prevents.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
