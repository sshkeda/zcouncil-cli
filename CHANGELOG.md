# Changelog

## 0.3.4

- Save zcouncil CLI tokens per bridge URL under `~/.zcouncil/tokens/`.
- Keep production, localhost, and preview/debug bridge tokens separate.
- Migrate the legacy production token from `~/.zcouncil/token` after successful validation.
- Make `logout` clear the saved token for the selected bridge URL.
