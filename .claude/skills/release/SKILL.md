---
name: release
description: Cut an airc release. Use when the user runs /release with a bump level (patch, minor, or major). Computes the next version from the latest git tag, drags package.json along, pushes master, and creates the v-prefixed GitHub release with an oldest-first changelog.
argument-hint: patch | minor | major
---

# /release — cut an airc release

Invoked as `/release <level>`, where `<level>` is exactly `patch`, `minor`, or `major`.
If the argument is missing or anything else, stop and ask which level.

## airc release conventions (don't deviate)

- The **git tag is the source of truth** for the release number, and tags/titles are **`v`-prefixed** (`v1.4.1`).
- The next version is computed by bumping the **latest tag**, NOT `package.json` — package.json may already be bumped ahead of the latest tag, so trusting it would skip a number.
- `package.json` `version` is the **bare** number (`1.4.1`) and is dragged along to match the tag.
- Android `versionName`/`versionCode` in `android-app/app/build.gradle.kts` are intentionally **static** — never bump them.
- `gh release create` makes a **lightweight** tag; no APK is attached.
- `gh release create` creates the tag on the **remote only** — fetch it back afterward so the local tree has it, otherwise `git describe` (which both the server and the Android build use to report their build) keeps reporting the *previous* tag plus a commit count.
- Changelog = `git log --reverse` subjects (oldest first) over `<latestTag>..HEAD`, with the `Update version from package.json` bump commit filtered out.

## Steps

**1. Pre-flight.** Stop and report if any fails:
- On `master`: `git rev-parse --abbrev-ref HEAD`
- Clean tree: `git status --porcelain` is empty
- Sync tags from the remote: `git fetch --tags origin` — the latest tag is the source of truth, so a stale local tag list would otherwise compute a version that already exists on the remote.
- `npm run check` passes

**2. Compute the next version from the latest tag:**
```bash
level="$1"   # patch | minor | major
latest=$(git tag --list 'v*' --sort=-v:refname | head -1)   # e.g. v1.4.0
IFS=. read -r MA MI PA <<< "${latest#v}"
case "$level" in
  major) MA=$((MA+1)); MI=0; PA=0 ;;
  minor) MI=$((MI+1)); PA=0 ;;
  patch) PA=$((PA+1)) ;;
  *) echo "bad level: $level"; exit 1 ;;
esac
next="$MA.$MI.$PA"        # bare, for package.json
tag="v$next"             # v-prefixed, for the tag/release
echo "$latest -> $tag"
```
Sanity-check the computed tag is free (it should be, after the pre-flight fetch). If it already exists, stop — the local list was stale or `$latest` is wrong:
```bash
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "tag $tag already exists"; exit 1; }
```

**3. Drag package.json along.** Read `package.json` `version`. If it does NOT already equal `$next`, set it to `$next` and commit exactly:
```bash
git commit -am "Update version from package.json"
```
If it already equals `$next` (it may be pre-bumped), skip this commit — don't create an empty one.

**4. Preview & confirm — this step is outward-facing, so pause here.** Show the user `$latest -> $tag` and the changelog preview:
```bash
git log --reverse --pretty='- %s' "$latest"..HEAD | grep -v '^- Update version from package.json$'
```
Wait for the user's go-ahead before pushing/releasing.

**5. Push & create the release:**
```bash
git push origin master
notes=$(git log --reverse --pretty='- %s' "$latest"..HEAD | grep -v '^- Update version from package.json$')
gh release create "$tag" --target master --title "$tag" --notes "$notes"
```

**6. Fetch the new tag back.** `gh release create` made the tag on the remote only, so pull it down so `git describe` resolves to the just-cut tag (not the previous one + commit count):
```bash
git fetch --tags origin
git describe --tags    # should print exactly "$tag"
```

**7. Report** the release URL that `gh` prints.
