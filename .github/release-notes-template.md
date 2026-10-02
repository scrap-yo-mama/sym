<!-- Template of the notes of a release (22 §3.4). release-please writes the change list; this frame is added to it.
     The Verify block is derived from PUBLIC_REPOSITORY (verifyBlock in runtime/scripts/vitrine/lib/identity.ts) and checked by `pnpm vitrine:check`. -->
## What changes for you · Ce qui change pour toi

One or two sentences, in plain words, on what you will notice after the update. · Une ou deux phrases, en mots simples, sur ce que tu remarqueras après la mise à jour.

## Migration notes · Notes de migration

Steps to run before or after the update, or "none". Back up first (`runtime backup`). · Les étapes à jouer avant ou après la mise à jour, ou « aucune ». Sauvegarde d'abord (`runtime backup`).

## Verify what you download · Vérifie ce que tu télécharges

Same check as the README, with the version of this release in place of `X.Y.Z`. · Même contrôle que dans le README, avec la version de cette release à la place de `X.Y.Z`.

```bash
cosign verify ghcr.io/scrap-yo-mama/sym:X.Y.Z \
  --certificate-identity=https://github.com/scrap-yo-mama/sym/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/scrap-yo-mama/sym:X.Y.Z -R scrap-yo-mama/sym
sha256sum -c SHA256SUMS
```

Images are pinned to `X.Y.Z`, with no floating `latest`. · Les images sont épinglées à `X.Y.Z`, sans `latest` flottant.
