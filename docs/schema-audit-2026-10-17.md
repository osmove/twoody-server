# Audit du schéma : base locale et base du compte, depuis le 3 octobre 2026

Audit du 17/10/2026, demandé par Jimmy (« garder la base SQLite locale et le Postgres du compte aussi proches que
possible, au cas où des offres cloud viendraient »). **Appliqué le 17/10/2026** (feu vert de Jimmy) : contrat v2,
renommages des n° 2, 4, 5 et 9, valeurs de `projects.source` (n° 13), règle 14 de l'AGENTS.md racine — voir
`docs/schema-convergence.md` « Contrat v2 et renommages de l'audit » ; n° 4 a pris `archived_at`. Restent ouverts
les n° 7 (références UUID, `organizations.uuid`) et 13 (étape 5). Le texte ci-dessous est celui de l'audit. Il compare tout ce
qui a été ajouté depuis la convergence du 03/10/2026 (`docs/schema-convergence.md`) aux règles de cette
convergence.

Sources lues :
- **Mac** : `src/migrations/0003` à `0012` (dont `0011_file_actions.ts` et `0012_people_removed.ts`, encore non
  committés dans l'arbre de travail au moment de l'audit) ; `src/db.ts` ; les tables créées hors migration ; le
  schéma réel obtenu en jouant toutes les migrations sur une base vide (60 tables).
- **Compte** : `twoody-backend/db/schema.rb` (version 2026_10_16_120000, 134 tables) et les migrations du
  `20261003…` au `20261016…`.
- **Contrat** : `schema/contract.json` (v1, 11 tables), `test/schemaContract.test.ts` (Mac) et
  `twoody-backend/test/schema_contract_test.rb` (compte). Les deux copies du contrat sont identiques.

Rappel des règles du 03/10 : un même nom pour une même notion (celui du Mac quand les deux se valent) ; id UUID créé
par l'appareil (Rails : `id uuid` pour une table nouvelle, colonne `uuid` sur une table existante) ; dates en ms UTC
(INTEGER) sur le Mac, `datetime` sur le compte ; JSON sans suffixe (TEXT / `jsonb`), listes en tableau JSON /
`text[]` ; colonnes de synchronisation `created_at`, `updated_at`, `deleted_at`, `hlc`, `origin_device_id` (les trois
dernières reportées à l'étape 5) ; un contrat écrit et testé des deux côtés.

## 1. Ce que les tests du contrat voient, et ce qu'ils ne voient pas

- Ils vérifient que chaque table et colonne **listée** existe des deux côtés avec un type compatible, et (côté Rails
  seulement, et seulement quand le modèle a une validation `inclusion`) que les valeurs permises sont acceptées.
- Ils ne voient pas :
  1. **une table de même nom des deux côtés hors du contrat** : 13 aujourd'hui — `folder_shares`, `emails`,
     `email_sources`, `bank_accounts`, `bank_transactions`, `users`, `devices`, `auth_sessions`,
     `account_computers`, `members`, `face_embeddings`, `voice_profiles`, `wake_word_samples`. Seule
     `folder_shares` est nouvelle et désigne vraiment la même chose (§2, n° 2) ;
  2. **une colonne ajoutée d'un seul côté à une table du contrat** : `projects.isolated`, `projects.reference`
     (Mac), `discussions.cloud_models` (compte) sont passées sans bruit ;
  3. **les valeurs côté Mac** : `test/schemaContract.test.ts` ne lit jamais `values` (rôles, statuts et tailles des
     projets, `relation_type`, `message_traces.kind`, `memories.kind`) ;
  4. **les références** : `messages.discussion_id`, `tasks.project_id`, `discussions.project_id` sont des UUID sur
     le Mac et des bigint (vers `id`, pas vers `uuid`) sur le compte ; le contrat ne dit rien des clés étrangères ;
  5. **une table créée hors des migrations** : `peer_document_audit` est encore créée et complétée au chargement de
     `src/peerDocuments/audit.ts`, en double de la migration 8 ; `file_actions` l'était jusqu'à la migration 11
     (en cours).

## 2. Les écarts, par importance pour une future synchronisation

| # | Sujet | Mac (SQLite) | Compte (Postgres) | Écart | Proposition |
|---|---|---|---|---|---|
| 1 | Le contrat lui-même | 11 tables, types vérifiés, valeurs non | idem, valeurs vérifiées si validation | Tables et colonnes non classées invisibles (§1) | Contrat v2 (§4) : chaque table et chaque colonne hors contrat classée `local_only` / `account_only` avec sa raison ; valeurs vérifiées aussi côté Mac ; références déclarées |
| 2 | Partage de dossiers (migration 8 / `20261010120000`) | `folder_shares` : `id` (= l'UUID du partage), `"right"`, `label`, `revoked_by` (= une raison : owner, grantee, organization, eligibility), `grantee_user_id`, `organization_id` (ids du compte en texte), `revoked_at`, dates ms | `folder_shares` : `id` bigint + `share_uuid`, `access_right`, `folder_label`, `revoked_by_id` (un utilisateur) + `revoked_reason` (+ `host`), `grantee_id`, `organization_id`, `status`, `revoked_at` | Même notion, même nom de table, colonnes nommées autrement ; `revoked_by` veut dire deux choses différentes ; table Rails nouvelle sans `id uuid` ; hors contrat | Mac (migration) : `"right"` → `access_right` (plus de mot-clé SQL à citer), `label` → `folder_label`, `revoked_by` → `revoked_reason` (valeurs du compte, `host` compris). Compte : `share_uuid` → `uuid` (comme les autres tables partagées ; le passage à `id uuid` coûterait la clé de `bridge_tasks.folder_share_id`). Contrat : `folder_shares` avec `id`/`uuid`, `kind`, `access_right` (ask, read), `folder_label`, `expires_at`, `revision`, `revoked_at`, `revoked_reason`, `created_at`, `updated_at` ; le reste classé (Mac : `folder_id`, `grantee_name`, `organization_name`, `published_at` ; compte : `host_device_id`, `owner_id`, `status`, `revoked_by_id`). Les ids de personnes et d'organisations : voir n° 7 |
| 3 | Projets cloisonnés (migrations 6, 7) | `projects.isolated` (0/1), `projects.reference`, `project_notes`, `document_folders.project_id` ; les conversations, tâches, rappels et événements d'un projet cloisonné sont des lignes de tables **partagées** | rien (Rails a `projects.visibility` private/shared, autre chose) | Des lignes de tables du contrat ne doivent jamais partir, et rien dans le contrat ne le dit | **Local seulement, exprès** (décision de Jimmy du 14/10 : rien d'un projet cloisonné ne quitte l'ordinateur). Ne pas créer `isolated` côté Rails. Contrat v2 : `projects.isolated`, `projects.reference` en colonnes `local_only` avec la règle « une ligne d'un projet cloisonné ne quitte jamais l'ordinateur » (projects, discussions, messages, tasks, reminders, events, message_traces) ; `project_notes` et `document_folders` en tables `local_only`. Un test de la future synchronisation devra le prouver, comme pour l'historique chiffré aujourd'hui |
| 4 | « Retirer de vos proches » (migration 12, **non committée**) | `entities.removed_at` (ms) | pas d'`entities` (étape 4) | Le principe 5 nomme `deleted_at` l'effacement logique qu'une synchronisation propage ; ce serait le premier `removed_at` des deux bases | Renommer en `deleted_at` **avant le commit** (aucune version publiée n'a la migration 12 ; « Rétablir » = remettre `NULL` avec un nouveau `hlc`). Si Jimmy veut distinguer « caché, rétablissable » : `archived_at`, le nom que le compte utilise déjà (`projects.archived_at`) |
| 5 | « Proches » (migration 10) | `entity_relations` + `kind` (41 sortes), `source` (manual, learned, contact) ; clé primaire (`from_id`, `to_id`, `label`), ni `id` ni dates ; `entity_contacts` (`entity_id`, `contact_id`, `how` : auto, confirmed, manual, refused, `created_at`) | rien (graphe prévu à l'étape 4) | Pas de mot de la convention pour une table de liens : pas d'`id`, pas d'`updated_at` alors que `how` change (« À confirmer » → confirmed), le libellé libre fait partie de la clé | Avant l'étape 4 (une migration Mac qui reconstruit la table) : `entity_relations` + `id` UUID, `created_at`, `updated_at` ; `entity_contacts` + `updated_at`. Le jour où Rails crée le graphe : `kind` dans le contrat avec ses 41 valeurs (`RELATION_KINDS`), `source` et `how` avec les leurs. Le lien avec `contacts.relation_type` (famille → `relative`, sinon même mot : `people.ts contactRelation`) est déjà cohérent : à garder |
| 6 | Conversations avec un modèle du cloud (`20261011210000`) | rien : le Desktop lit ces conversations sur le compte | `discussions.cloud_models` (booléen) | Première colonne d'une table du contrat liée au cloud, d'un seul côté | Compte seulement pour l'instant (les conversations cloud n'existent que sur le compte). À ajouter au contrat, avec `discussions.cloud_models` sur le Mac, le jour où le Mac en garde une copie. Règle à écrire dans le contrat : une conversation d'un projet cloisonné n'est jamais `cloud_models` |
| 7 | Références entre les deux bases | ids du compte en texte (`folder_shares.grantee_user_id`, `organization_id`, `account_computers.computer_id`) ; clés vers des tables partagées en UUID (`project_id`, `discussion_id`) | bigint vers `id` partout, y compris `messages.discussion_id` alors que `messages.id` est UUID | Une ligne synchronisée ne peut pas être recopiée telle quelle : chaque clé doit être traduite | Règle : d'une base à l'autre, une ligne en nomme une autre par son UUID. Contrat v2 : type `ref` (`{"type": "ref", "to": "projects"}`), le test Rails vérifiant que la table visée a `uuid` ; les tables Rails créées désormais en `id: :uuid` (leurs clés le sont alors aussi). Pour les personnes et organisations du compte : `users.uuid` existe, `organizations` n'en a pas (à ajouter avant qu'une organisation soit synchronisée) |
| 8 | Agir dans vos dossiers (migration 11, non committée) | `file_actions` : id UUID, dates ms, `plan` et `result` en JSON sans suffixe, `language`, `asker_app` | rien | Conforme ; `language` là où le compte dit `locale` (`feedback_messages`, `installations`) ; pas d'`updated_at` (`decided_at`, `done_at` en tiennent lieu) | **Local seulement, exprès** : le plan nomme des fichiers de cet ordinateur et n'agit que sur lui. Pour une prochaine colonne de langue : `locale`, comme le compte. La migration 11 met fin à la table créée « à la première utilisation » : à committer telle quelle |
| 9 | Audit des documents (migration 8) | `peer_document_audit` : id entier, `at` ; aussi créée et complétée dans `src/peerDocuments/audit.ts` | rien | DDL en deux endroits ; `at` là où la convergence a choisi `occurred_at` (`model_calls`, `message_traces`) | **Local seulement, exprès** (journal de ce que les autres ordinateurs ont lu ici). Retirer le `CREATE TABLE`/`ALTER` de `audit.ts` (la migration 8 fait déjà tout) ; `at` → `occurred_at` à la prochaine migration qui touche la table. Un id entier reste acceptable pour une table qui ne part jamais (`share_guest_devices`, `usage_samples`) |
| 10 | Fonctions réservées (`20261011200000`, `20261016120000`) | aucune colonne : le Desktop garde la réponse de `/me` dans `reserved-features.json` et la dit au serveur (`TWOODY_RESERVED_FEATURES`, message) | `users.cloud_models`, `users.email_capability`, `users.google_data` (booléens) | Conforme : le compte décide, le Mac ne fait que suivre. Petit écart de noms : la colonne `email_capability`, la clé `email` dans `TWOODY_RESERVED_FEATURES` | **Compte seulement, exprès** (droits décidés par Osmove). Si les offres cloud multiplient ces droits : une table `user_entitlements` (ou `text[]`) plutôt qu'un booléen de plus sur `users` ; garder alors une seule clé par droit des deux côtés |
| 11 | Tables nouvelles du compte | — | `feedback_messages` (+ `kind`, `report_category`, `reported_model`, `reported_text`), `ip_retention_records`, `ip_retention_lookups`, `installations`, `download_stats`, `download_stat_runs`, colonnes de `diagnostic_reports`, `app_events`, `textos`, `download_clicks`, `organizations.sharing_policy`, `bridge_tasks.folder_share_id`/`share_revision` | Conformes à la convention du compte (`datetime`, `jsonb`, pas de `_json`) ; ids bigint | **Compte seulement, exprès** (messages à Osmove, obligations légales, statistiques, relais, règles d'une organisation). Le bigint convient à une table qui ne sera jamais synchronisée : la règle UUID ne vaut que pour une table partageable |
| 12 | E-mails et banque (migrations 4, 5) | `email_sources`, `emails`, `bank_accounts`, `bank_transactions` : noms du compte repris, ms, JSON sans suffixe | mêmes noms (code de l'assistant cloud, éteint), sans colonne `uuid`, montants flottants, `date` | Déjà dit « local seulement » dans `schema-convergence.md`, mais invisible aux tests | Les classer `local_only` dans le contrat v2 avec la mention « même nom sur le compte, code ancien éteint ». Le jour où une boîte ou un relevé vivra sur le compte : `uuid` côté Rails, montants en centimes (`amount_cents`, `balance_cents`) |
| 13 | Ce que l'étape 2 avait prévu et qui n'est pas fait | `projects` sans `slug` ni `archived_at` ; `discussions` sans `updated_at` | `events` sans `source`, `external_id`, `calendar`, `location` ; `discussions` sans `memory_mode` ni `summary` ; `memory_candidates` aux colonnes du compte (`raw_content`, `proposed_*`) et non du Mac (`content`, `kind`, `confidence`…) ; `projects.source` : user, proactive, flow, import (Mac : manual, learned, account) | Restes du 03/10, pas nouveaux, mais une synchronisation les rencontrera en premier | À traiter avec l'étape 5 ; en attendant, mettre `values` sur `projects.source` dans le contrat (le test dira l'écart) |
| 14 | Petits écarts sans conséquence | `document_grams` (index dérivé, migration 9) ; `walled-code.json` du Desktop (« Autoriser Twoody Code dans ce projet », date ISO) ; `share_guest_devices` | — | — | **Local seulement, exprès** : données dérivées, ou réglages de sécurité de cet ordinateur que Code ne peut pas lire. Hors base, la date ISO ne gêne rien ; si elle entrait un jour dans `local.db` : ms |

Rien de ce qui a été ajouté depuis le 03/10 ne remet en cause les dates (ms partout sur le Mac, `datetime` partout sur
le compte), ni le JSON sans suffixe, ni les ids UUID côté Mac : les écarts sont de noms, de classement et de clés.

## 3. Par où commencer

1. **Tout de suite, sans toucher au code livré** : nommer `deleted_at` (ou `archived_at`) la colonne de la
   migration 12 avant son commit (n° 4).
2. **Contrat v2 et ses deux tests** (n° 1), en commençant par classer ce qui existe : c'est ce qui empêchera la
   dérive suivante.
3. **Partage de dossiers** (n° 2) : une migration Mac de trois renommages et `share_uuid` → `uuid` côté compte,
   puis la table dans le contrat. Pendant la bêta privée, c'est le moment le moins coûteux.
4. Les références (n° 7) et le graphe (n° 5) avec l'étape 4.

## 4. Contrat v2 (proposition)

```jsonc
{
  "version": 2,
  "tables": {
    "projects": {
      "id": { "type": "uuid", "rails": "uuid" },
      "source": { "type": "text", "values": ["manual", "learned", "account"] },
      "…": "…"
    },
    "messages": { "discussion_id": { "type": "ref", "to": "discussions" }, "…": "…" }
  },
  // Colonnes d'une table partagée qui n'existent que d'un côté, avec la raison.
  "local_columns": {
    "projects": { "isolated": "walled-off: rows with isolated = 1 never leave this computer", "reference": "walled-off" }
  },
  "account_columns": { "discussions": { "cloud_models": "cloud conversations live on the account only (for now)" } },
  // Lignes d'une table partagée qui ne partent jamais.
  "never_leave": { "discussions": "project_id of a project with isolated = 1", "…": "…" },
  // Tables d'un seul côté, avec la raison ; un même nom des deux côtés doit être déclaré.
  "local_only": { "project_notes": "walled-off project notes", "file_actions": "acts on this computer's files", "…": "…" },
  "account_only": { "feedback_messages": "messages to Osmove", "ip_retention_records": "legal retention", "…": "…" },
  "same_name": { "emails": "local IMAP copy; the account's is the switched-off cloud assistant", "…": "…" }
}
```

Tests :
- **Mac** (`test/schemaContract.test.ts`) : chaque table de la base migrée (hors tables internes des FTS5) est dans
  `tables` ou `local_only` ; chaque colonne d'une table de `tables` est dans le contrat ou dans `local_columns` ; les
  `values` sont comparées aux constantes du code (`PROJECT_STATUSES`, `RELATION_KINDS`…) ; une `ref` est une colonne
  TEXT.
- **Compte** (`test/schema_contract_test.rb`) : chaque table de `schema.rb` est dans `tables` ou `account_only` (une
  liste longue à écrire une fois, ~120 tables, puis chaque nouvelle table la complète) ; chaque colonne d'une table
  de `tables` est dans le contrat ou dans `account_columns` ; une `ref` vise une table qui a `uuid` ; aucun nom de
  `local_only` n'existe sur le compte sans être dans `same_name`.

## 5. Règle à ajouter aux AGENTS.md

Pour `~/Dev/twoody/AGENTS.md` (§4, règle 14) :

> **Schéma local ↔ compte** (`twoody-server/docs/schema-convergence.md`, `schema/contract.json`). Toute table ou
> colonne nouvelle, sur le Mac ou sur le compte, suit la convention : id UUID créé par l'appareil (Rails : `id:
> :uuid` pour une table partageable qu'on crée, colonne `uuid` sur une table existante) ; dates `*_at` en ms UTC
> (INTEGER) sur le Mac, `datetime` sur le compte ; durées `*_ms` ; JSON sans suffixe (TEXT / `jsonb`), listes en
> tableau JSON / `text[]` ; booléens 0/1 / `boolean` ; `created_at` et `updated_at` ; effacement logique `deleted_at`
> (révocation `revoked_at`), jamais un autre nom ; valeurs d'énumération en anglais, les mêmes des deux côtés ;
> une même notion porte le même nom de table et de colonnes des deux côtés (celui du Mac quand les deux se valent),
> un même nom ne désigne jamais deux notions ; une ligne nomme une ligne de l'autre base par son UUID. Jamais de
> table créée hors d'une migration numérotée (Mac) ou Rails (compte). Dans le même commit, la table ou la colonne
> est classée dans `schema/contract.json` — partagée, ou « local seulement » / « compte seulement » avec sa raison
> (« cloisonné : ne quitte jamais l'ordinateur », « droit décidé par Osmove »…) — et le contrat est recopié dans
> `twoody-backend/config/schema_contract.json` ; les tests de contrat des deux dépôts échouent sur ce qui n'est pas
> classé. Tant que le contrat v2 n'existe pas, le classement s'écrit dans `docs/schema-convergence.md`.

Pour `twoody-server/AGENTS.md` et `twoody-backend/AGENTS.md`, la même règle en anglais, en une ligne qui renvoie à
celle-ci.
