# Changelog

## 0.3.5

- Point preview bridge token prompts at the matching `pr-<N>.zcouncil.pages.dev` chat URL when `--bridge` targets a `zcouncil-worker-preview-pr-<N>` Worker.
- Prevent preview bridge users from accidentally creating production API tokens that cannot authenticate against the preview Convex deployment.

## 0.3.4

- Save zcouncil CLI tokens per bridge URL under `~/.zcouncil/tokens/`.
- Keep production, localhost, and preview/debug bridge tokens separate.
- Migrate the legacy production token from `~/.zcouncil/token` after successful validation.
- Make `logout` clear the saved token for the selected bridge URL.
