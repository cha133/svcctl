# Publishing is intentionally CI-only so release binaries always come from
# the reproducible GitHub Actions build.
throw "Local npm publish is disabled. Commit the version bump and push tag v<version> to run .github/workflows/publish.yml."
