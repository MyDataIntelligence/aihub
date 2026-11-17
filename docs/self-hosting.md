# Self-hosting

A team can run aihub entirely inside its own Azure DevOps: its own copy of the repository, its own npm feed, its own
package name. Nothing in the CLI points at npmjs.com or GitHub:

- `aihub update` asks the registry from your npm configuration (`.npmrc`, `npm config get registry`) for the newest
  version of the package it was installed as (the `name` in `package.json`, so `@org/aihub` after a rename).
- `aihub skills install|update` copy from the pack bundled in the installed package; no network.
- Skills are plain files, so `npx skills add <your repo URL> -g -a opencode -a github-copilot -a codex` works from your
  own repository too.

## Option A: mirror and keep GitHub as upstream

1. In Azure DevOps create a repository `aihub` and import `https://github.com/MyDataIntelligence/aihub`.
2. Locally: `git remote add upstream https://github.com/MyDataIntelligence/aihub.git`.
3. Pull updates when you want them: `git fetch upstream && git merge upstream/staging` on a branch, then a pull request into
   your `staging`. Your own changes (renamed package, `azure-pipelines.yml` variables) are the only conflicts you can get.
4. Keep team-specific skills out of the mirror (see [customize](customize.md)); then the merge stays trivial.

## Option B: own the fork

Do the import once and never merge from upstream. Improvements to the generic pack still go back to the aihub
repository as a pull request, so everybody benefits.

## Publish to an Azure Artifacts feed

1. Create a feed (for example `aihub`) with the npmjs upstream enabled, so `npm ci` can still fetch dependencies. Make
   the project build service a Contributor.
2. Add a pipeline from `azure-pipelines.yml` in the repository root and set the variable `FeedRegistry` to
   `https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/npm/registry/`.
3. The pipeline builds and tests, then publishes with `npmAuthenticate`: every push to `staging` becomes
   `<version>-next.<build id>` on the dist-tag `next`; a tag `vX.Y.Z` becomes `X.Y.Z` on `latest`.
4. Colleagues point npm at the feed once (user `.npmrc`):

```
@org:registry=https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/npm/registry/
always-auth=true
```

   Sign-in uses `vsts-npm-auth` (Windows) or the feed's "Connect to feed" instructions; after that
   `npm i -g @org/aihub`, `aihub update` and `aihub update --check` work against the feed.

## Rename the package scope

```sh
cd cli
npm pkg set name=@org/aihub
```

`aihub` stays the command name. The name is read at runtime, so `aihub update` updates `@org/aihub`. Search the docs for
`@ferronhooi/aihub` and replace it where you want your own scope, and run `npm install` to refresh the lock file.

## Check

`aihub update --check` prints the package name, the registry it used and the newest version there. If it reports that it
cannot read the latest version, the `.npmrc` of the colleague is wrong or the sign-in expired.