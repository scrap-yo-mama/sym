// SPDX-License-Identifier: AGPL-3.0-only
// Rôles fixes de l'instance (13 § 2), tels que les nomme l'API. Aucune matrice de droits ici : les permissions viennent du serveur
// (`GET /api/me`, voir `can()` dans `composables/useSession.ts`).
import type { components } from '@runtime/client';

export type Role = components['schemas']['Role'];
