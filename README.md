# Composal Docker builder action

Connect a Linux GitHub Actions runner to an existing Composal organization builder. Docker layers and `RUN --mount=type=cache` data stay on its persistent remote disk. Images push from the builder to your registry; deployment hosts pull the published digest.

Use `ComposalAI/docker-builder@1` (also available as `@v1`), or pin a release commit for reproducibility. Remote builders are in preview.

```yaml
concurrency:
  group: remote-builder-acme-ci
  cancel-in-progress: false
  queue: max
steps:
  - uses: actions/checkout@v7
  - uses: docker/login-action@v3
    with:
      registry: registry.example.com
      username: ${{ secrets.REGISTRY_USERNAME }}
      password: ${{ secrets.REGISTRY_PASSWORD }}
  - uses: ComposalAI/docker-builder@1
    id: remote
    with:
      token: ${{ secrets.COMPOSAL_API_TOKEN }}
      org: acme
      builder: ci
  - uses: docker/build-push-action@v6
    with:
      context: .
      push: true
      tags: registry.example.com/acme/app:${{ github.sha }}
      provenance: false
```

Authenticate to your registry before selecting the remote context: the gateway does not expose the daemon registry-login endpoint. For the Composal registry, `com registry login --write-config` can instead write client credentials after setup without using that endpoint. BuildKit receives registry authentication through the normal Docker client session.

An organization admin must provision the builder first with `com docker-builder create ci --org acme`. The token needs membership in that organization. Setup fails if the builder is missing, unavailable, or refused; it never falls back to a local build or creates a cache accidentally.

Inputs are `token` and `org` (required), `builder` (default `main`), `wake-timeout` (default `900` seconds, range `30`–`3600`), `use` (default `true`), `api-url` (default `https://composal.ai`), and `install-cli` (default `true`). The installed CLI is added to the job PATH. Set `install-cli: 'false'` to use an already installed released `com` supporting background Docker builder setup. Docker and Buildx must be installed on the runner. Outputs are `builder`, `context`, and `driver` (`docker`). Each job isolates CLI supervisor state in its temporary directory. Setup logs the CLI version, checks gateway health and waits for the shared builder to become ready before opening native Docker connections. Cold starts can take several minutes; `wake-timeout` controls this wait. Progress includes the builder state and generation. Setup requests a retry when it finds a builder already starting, so a failed earlier wake can resume. Canceling a job disconnects only that job; it does not cancel the shared wake. It retries transient status-read server errors, then checks the remote daemon with bounded, retryable probes and verifies Buildx readiness before selecting the context and builder for subsequent job steps using `DOCKER_CONTEXT` and `BUILDX_BUILDER`. It leaves Docker's saved defaults unchanged and restores the previous job environment during cleanup.

Setup also disables Buildx metadata provenance and Docker build-record uploads/summaries: the scoped gateway does not expose BuildKit content-record downloads. Image digest metadata is retained. Previous values are restored during cleanup. In explicit selection mode, set `BUILDX_METADATA_PROVENANCE=disabled`, `DOCKER_BUILD_RECORD_UPLOAD=false` and `DOCKER_BUILD_SUMMARY=false` on the build step yourself.

The normal setup works with `docker/build-push-action`, `docker buildx build`, and native Docker commands. For explicit selection only, set `use: 'false'`, then set `DOCKER_CONTEXT` to the context output and pass the builder output on every build step. The embedded Docker driver refuses a builder belonging to a different active context. Do not create a separate `docker-container` builder, add GHA/registry cache exporters, or run cache-dance: this embedded Docker driver uses its retained native cache. The current classic image store does not support those external exporters or attestations; the example disables provenance. Explicit local exports still transfer image data to CI.

Use one connection per job. Post-job cleanup disconnects the local proxy and removes its context, including after build failure. It keeps the remote builder and cache; organization idle policy sleeps compute. Runner termination can prevent cleanup. Disconnecting does not prove a remote operation has stopped: uncertain operations retain their slot until the service reconciles them or an administrator recovers the builder.

One builder can serve multiple native builds on the same daemon and retained cache. Organization concurrency defaults to one across all its builders; an admin can raise it with `com docker-builder settings --org acme --max-concurrency 4`. New VMs receive 2 CPUs and 4 GiB RAM per configured concurrent operation, with a 256 GiB cache disk. Changing the policy does not resize an already running VM: drain its builds, sleep it to checkpoint the cache, then wake it. Qualify image size, cold build memory and warm performance before switching production builds.

Coordinate CI jobs to fit the organization's configured capacity. The single concurrency group in the example serializes jobs; multiple groups can admit more jobs when capacity has been increased. GitHub concurrency only coordinates workflows in the same repository, and concurrent work outside those groups can still be refused. Use `queue: max` to retain pending builds (up to 100); without it GitHub replaces the previous pending build. Use separate builders when workloads need independent caches. Remote builders are in preview.

Run `node --test builder.test.mjs` to check the action locally. The integration qualification also exercises cache-mount reuse across real Buildx solves, a direct registry push, digest inspection and post-job cleanup.
