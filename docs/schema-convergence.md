# Converger la base locale (SQLite) et la base du compte (Postgres)

Proposition du 3 octobre 2026, **approuvée et appliquée le même jour**
(« applique tout »). Voir « Ce qui est fait » à la fin. Sources : `src/db.ts`
(env. 50 tables) et `twoody-backend/db/schema.rb` (129 tables).

## Pourquoi maintenant

Le jour où on proposera des offres cloud, une même conversation, un même
souvenir ou un même projet devra pouvoir vivre sur le Mac **et** sur le
compte, et passer de l'un à l'autre sans traduction. Aujourd'hui, seul Jimmy
a des données. On peut donc tout renommer, changer les types et réécrire les
lignes sans migration délicate pour qui que ce soit.

## Ce qui diverge aujourd'hui (résumé)

| Sujet | Mac (SQLite) | Compte (Postgres) |
|---|---|---|
| Migrations | aucune : `CREATE IF NOT EXISTS` + `ALTER` au démarrage | migrations Rails, `strong_migrations` |
| Identifiants | texte : 32 hex, UUID ou `macos-…`, parfois mélangés dans une même table | bigint (UUID pour 7 tables) |
| `user_id` | l'utilisateur **local** (32 hex), pas le compte | l'utilisateur du compte (bigint) |
| Dates | secondes pour la moitié des tables, millisecondes pour l'autre | `datetime` |
| JSON | TEXT, suffixe `_json` (sauf `members.enrollment_state`) | `jsonb` sans suffixe, tableaux `text[]` |
| Clés étrangères | sur les tables d'origine seulement ; aucune sur les colonnes ajoutées ensuite | partout |
| Suppression | ligne effacée (ou `status`) | `status`, `archived_at`, `revoked_at`… pas de règle commune |

Les mêmes noms désignent aussi des choses différentes :
- `messages` : les tours de chat sur le Mac ; sur le compte, les messages
  **entrants** reçus par Vonage (WhatsApp, Messenger, SMS), chacun créant
  une `query` (les SMS envoyés sont dans `textos`) ;
- `providers` : les adresses de modèles configurées sur le Mac, le catalogue
  des fournisseurs sur le compte ;
- `usage_events` : un appel de modèle (tokens) sur le Mac, un décompte de
  quota sur le compte.

Et une même chose porte des noms différents :

| Chose | Mac | Compte |
|---|---|---|
| Titre d'une conversation | `discussions.title` | `discussions.name` |
| Échéance d'un projet | `due_at` | `deadline_at` |
| Fin d'un projet | `done_at` | `completed_at` |
| Budget d'un projet | `budget_cents` + `currency` | `budget_amount_cents` + `budget_currency` |
| Souvenirs proposés | `memory_candidates` | `memory_imports` |
| Étiquettes d'un souvenir | `tags_json` | `tags text[]` |
| Téléphones d'un contact | `phones_json` | `phone_number_1…5` (+ label, formatted) |
| Trace d'une réponse | `turn_traces` + `turn_prompts` | `steps` (cloud), `desktop_traces` (Mac) |

## Principes proposés

1. **Un seul vocabulaire.** Pour chaque notion partagée : même nom de table,
   mêmes colonnes, mêmes valeurs d'énumération des deux côtés. Quand les
   deux noms se valent, on prend celui du Mac : c'est le modèle le plus
   récent et le plus propre. Rails garde ses noms quand ils sont meilleurs.
2. **Un identifiant UUID créé par l'appareil**, le même des deux côtés.
   - Une ligne naît où on l'écrit (souvent sur le Mac, hors ligne) et garde
     son id partout.
   - Côté Rails : un vrai `id uuid` pour les tables qu'on crée ; une colonne
     `uuid` unique ajoutée aux tables existantes (discussions, memories,
     projects, tasks, reminders, notes, contacts, events). Leurs bigint
     restent pour les vieilles clés étrangères (queries → discussions…).
3. **Les dates en millisecondes UTC sur le Mac**, colonnes `*_at` en
   INTEGER ; `datetime(6)` côté Rails. Les durées en `*_ms` partout. Fin des
   secondes.
4. **Le JSON sans suffixe.**
   - SQLite : colonne TEXT, mode `json` de drizzle.
   - Postgres : `jsonb`.
   - Les listes simples (étiquettes) sont un tableau JSON sur le Mac et
     `text[]` sur le compte.
5. **Les colonnes de synchronisation**, identiques sur toute table
   partageable :
   - `created_at`, `updated_at` ;
   - `deleted_at` : effacement logique, nécessaire pour propager une
     suppression, cohérent avec « on garde tout » ;
   - `hlc` : horloge hybride, qui existe déjà pour souvenirs, entités et
     projets ;
   - `origin_device_id`.
6. **Un vrai système de migrations sur le Mac** : `PRAGMA user_version` plus
   des fichiers numérotés `src/migrations/NNNN_nom.ts` joués dans l'ordre,
   dans une transaction. C'est le préalable à tout renommage.
7. **Un contrat écrit et testé.** `schema/contract.json` (dans
   twoody-server, copié dans twoody-backend comme les modules partagés)
   décrit chaque table partagée : colonnes, types logiques, valeurs
   permises. Un test de chaque côté vérifie que la base réelle le respecte.
   Une divergence casse donc les tests au lieu de passer inaperçue.

## Table par table : la cible

**Légende :** = déjà pareil · ✎ renommage · ＋ ajout · ⇄ changement de forme

### Identité et appareils
- **`users`.**
  - Mac : une ligne, plus `account_user_uuid` (＋), renseigné quand
    l'ordinateur est relié.
  - Rails : `users.uuid` (＋). On ne touche pas aux ~150 colonnes de réglages
    du compte.
- **`account_peers`** (Mac) ↔ **`account_computers`** (compte), la même
  chose : ✎ le Mac passe à `account_computers` (id = UUID du compte, déjà
  le cas). `token` en clair sur le Mac → empreinte ou trousseau (sécurité).
- **`devices`, `auth_sessions`, `pairing_codes`, `tunnel_peers`** : ce sont
  des mécanismes locaux d'accès au Mac. Ils restent locaux et ne sont pas
  partagés ; on harmonise seulement les dates (ms).

### Conversations (le plus gros morceau)
- **`discussions`.**
  - ✎ Rails `name` → `title`.
  - ＋ `memory_mode`, `summary`, `project_id` des deux côtés.
  - Mac : `channel` reste.
- **`messages` : un message par rôle.** On garde le modèle du Mac : `role`
  (user / assistant / tool), `content`, `reasoning`, `model`,
  `prompt_tokens`, `completion_tokens`, `cached_tokens`, `sources` (⇄ sans
  `_json`), `memory`, `answered_by`, `client`.
  - Rails : ✎ l'actuelle `messages` (messages entrants Vonage) devient
    `vonage_messages`, comme les autres tables `vonage_*` ;
    une nouvelle `messages` identique à celle du Mac est créée.
  - `queries`/`responses` (110 et 60 colonnes, beaucoup d'héritage) sont
    figées : le pipeline cloud écrira dans `messages` et elles ne seront plus
    que de l'historique.
- **Traces d'une réponse.**
  - ⇄ Mac : `turn_traces` + `turn_prompts` → **`message_traces`** (`trace`,
    `prompt`, `outcome`, `total_ms`, `kind`).
  - ✎ Rails : `desktop_traces` → `message_traces`. Les `steps` du cloud
    deviennent les étapes du `trace`, au même format.
- **Pièces jointes** : `message_attachments` des deux côtés (Rails :
  Active Storage derrière). Le Mac n'en a pas encore en table ; c'est à
  créer.

### Mémoire
- **`memories`.**
  - ⇄ Mac : `tags_json` → `tags`.
  - ＋ `importance` (low / normal / high / essential) en vraie colonne des
    deux côtés, au lieu des étiquettes `minor` / `important` / `pinned`.
  - ＋ `confidence` sur le Mac.
  - Valeurs de `source` communes : `manual | learned | import`, avec
    `source_ref` = chatgpt, claude, account… (Rails a aujourd'hui
    chatgpt / claude_ai… dans `source`).
  - `embedding` reste propre à chaque côté : sqlite-vec en BLOB, pgvector.
- ✎ Rails `memory_imports` → **`memory_candidates`**, mêmes colonnes que le
  Mac : `content`, `kind`, `category`, `confidence`, `sensitive`, `status`,
  `candidate_type`, `payload`, `memory_id`.
- **`entities`, `entity_aliases`, `entity_relations`, `memory_entities`**
  (le graphe du Mac) : ＋ à créer côté Rails. L'`entity` polymorphe de Rails
  (Contact / Project / Address) devient un lien vers `entities`.

### Projets, tâches, rappels, notes, agenda
- **`projects`.**
  - ✎ Rails `deadline_at` → `due_at`, `completed_at` → `done_at`,
    `budget_amount_cents` → `budget_cents`, `metadata_json` → `metadata`.
  - Statuts communs : `idea | active | paused | blocked | done | dropped`,
    plus `archived_at`.
  - `size` (small / medium / large / critical) remplace `priority` côté
    Rails.
  - ＋ `slug` sur le Mac.
- **`tasks`** : =, sauf la priorité, ramenée à 0-3 des deux côtés, et la
  clé étrangère `project_id` à ajouter sur le Mac.
- **`reminders`** : = (＋ `origin` sur le Mac).
- **`notes`** : =.
- **`events`** (agenda).
  - ✎ Mac `calendarEvents` (nom drizzle) → `events`, déjà le nom de la
    table.
  - Rails : les colonnes d'adresse en ligne (`address1…zipcode`) passent en
    `location` + `address_id`.
  - ＋ `source`, `external_id`, `calendar` côté Rails.

### Contacts
- ⇄ Rails : les colonnes numérotées (`phone_number_1…5`,
  `email_address_1…3`, labels, formatted) → `phones`, `emails`,
  `addresses` en jsonb `[{label, value}]`, comme sur le Mac.
- ＋ Rails : `birthday`, `organization`, `source`, `external_id`.
- Les valeurs de `relation_type` sont déjà communes.

### Usage et modèles
- ✎ Mac `usage_events` → **`model_calls`** (un appel de modèle : tokens,
  ms, cache). Rails garde `usage_events` (quotas) : le conflit de nom
  disparaît.
- ✎ Mac `providers` → **`llm_endpoints`** (les adresses de modèles de ce
  Mac). Rails garde `providers` + `llm_models` (catalogue).
- `usage_samples` et `usage_machines` restent locales.

### Documents (pour les offres cloud)
- Mac : `document_folders`, `documents`, `document_chunks`,
  `document_embeddings`, `document_labels`.
- Rails : rien aujourd'hui (le texte des documents part en ligne dans la
  question). ＋ mêmes tables le jour où le cloud lira des documents ; pas
  avant.

### Ce qui reste d'un seul côté
- **Mac seulement** : FTS, files de synchronisation du coffre, état de
  préchauffage, audit des accès aux documents, échantillons machine.
- **Compte seulement** : facturation, quotas, e-mail, Vonage, organisations,
  foyers, plugins, analytics.

## Le chemin, par étapes

Chaque étape se livre seule, avec ses tests, sans casser la précédente.

**Étape 0 : les fondations (Mac, sans changement visible).**
- Système de migrations versionnées dans twoody-server, avec une migration
  « 0001 » qui constate l'état actuel.
- `schema/contract.json` et un test de conformité, côté serveur d'abord.
- Une sauvegarde automatique de `local.db` avant chaque migration (copie
  datée dans `DATA_DIR/backups/`, jamais supprimée).

**Étape 1 : nettoyer le Mac.** Dans des migrations, sur les données réelles
de Jimmy :
- **dates** : tout en millisecondes ;
- **identifiants** :
  - un id de 32 hex devient un UUID simplement en ajoutant les tirets ;
  - c'est déterministe, et les références sont réécrites dans la même
    transaction ;
  - les `macos-…` deviennent des UUID v5 ;
  - toutes les nouvelles lignes reçoivent un `randomUUID()` ;
- **noms** :
  - suffixes `_json` retirés ;
  - `usage_events` → `model_calls` ;
  - `providers` → `llm_endpoints` ;
  - `account_peers` → `account_computers` ;
  - `turn_traces` + `turn_prompts` → `message_traces` ;
- **colonnes** : `importance` et `confidence` sur memories, `slug` sur
  projects, `deleted_at` / `hlc` / `origin_device_id` sur les tables
  partageables ;
- **clés étrangères** manquantes (`project_id`, `message_id`, `memory_id`…).

L'API du serveur local garde la même forme JSON : le Mac, l'iPhone et le Pi
ne voient aucune différence.

**Étape 2 : nettoyer le compte (Rails).**
- `messages` → `vonage_messages` ;
- `discussions.name` → `title` ;
- colonnes des projets renommées ;
- `memory_imports` → `memory_candidates` ;
- contacts en jsonb ;
- `importance` sur memories ;
- `uuid` ajouté aux tables partagées ;
- `desktop_traces` → `message_traces`.

Tables mortes (`pre_pairings`, `email_addresses`, `webhook_calls`,
`phone_call_campaigns`, `phone_call_message_chunks`, `badges`) : compter
leurs lignes en production. Celles qui sont vides sont supprimées ; celles
qui ont des lignes sont exportées avant (on garde tout).

**Étape 3 : les conversations du cloud dans `messages`.**
- La nouvelle table `messages` côté Rails ;
- `ChatCompletionService` y écrit, en plus de `queries` / `responses`
  pendant une transition courte, puis seulement là ;
- reprise de l'historique de Jimmy depuis `queries` / `responses`.

C'est l'étape la plus coûteuse : environ 80 fichiers touchent `Query`.

**Étape 4 : le graphe et les documents côté compte**, quand une offre cloud
en aura besoin.
- `entities` et les tables qui vont avec.
- Les tables de documents avec pgvector.

**Étape 5 : la synchronisation en clair** pour les comptes qui choisiront
le cloud. Elle utilise les mêmes tables, `hlc` et `deleted_at`. Le coffre
chiffré (vault) reste le chemin par défaut. Voir la décision 3.

## Décisions à prendre

1. **Identifiants côté Rails.**
   - Option A (recommandée) : une colonne `uuid` ajoutée aux tables
     existantes, avec un vrai `id uuid` pour les nouvelles tables.
   - Option B : tout passer en `id uuid`. C'est plus pur, mais il faut
     réécrire des dizaines de clés étrangères dans des tables qu'on va figer.
2. **Le modèle des conversations.**
   - Recommandé : `discussions` + `messages` (un message par rôle) + 
     `message_traces`.
   - Cela fige `queries` / `responses` / `steps` côté cloud.
3. **Le cloud et le chiffrement.** Pour faire répondre un modèle du cloud, le
   serveur doit lire la conversation.
   - Option a : un compte « cloud » synchronise en clair dans ces tables.
   - Option b : le cloud ne voit que ce qu'on lui envoie à chaque question,
     et l'historique reste chiffré dans le coffre.

   Cela décide de l'étape 5, pas des étapes 0 à 4.
4. **L'ordre.** Je propose de commencer par les étapes 0 et 1 (le Mac). Elles
   sont sans risque pour le compte et donnent le vocabulaire cible. Ensuite
   l'étape 2.

## Ce qui est fait (3 octobre 2026)

### Le Mac (twoody-server 3c93684)
- **Migrations versionnées.**
  - `src/migrations/` : `baseline.ts` contient l'ancien DDL, joué seulement à
    la version 0 ; `0002_convergence.ts` ; `index.ts` est l'exécuteur
    (`PRAGMA user_version`).
  - Une copie `backups/local-v<N>-<date>.db` est faite avant de migrer une
    base qui a des données ; elle n'est jamais effacée.
  - Une base plus récente que le serveur est refusée.
  - L'index plein texte est vérifié à chaque démarrage.
- **Renommages.**
  - `usage_events` → `model_calls` (`at` → `occurred_at`) ;
  - `providers` → `llm_endpoints` ;
  - `account_peers` → `account_computers` ;
  - `turn_traces` + `turn_prompts` → `message_traces` (`trace`, `prompt`,
    `occurred_at`) ;
  - suffixes `_json` retirés de 15 colonnes.
- **Dates en millisecondes** partout : 44 colonnes converties.
- **Contacts** : `phones`, `emails` et `addresses` en `[{label, value}]`.
- **Identifiants** : les `macos-<hex>` deviennent l'UUID de ce même hex, et
  la synchro du Mac produit désormais ce même UUID. `generateId()` rend un
  UUID.
- **`memories.confidence`**, comme sur le compte.
- **Contrat** `schema/contract.json` + `test/schemaContract.test.ts` ;
  `test/migrations.test.ts`.
- **Essai sur une copie de la vraie base de Jimmy** (480 Mo) : 4,8 s,
  toutes les lignes gardées, `foreign_key_check` vide, `integrity_check`
  OK. Tests : 716/716.

### Ce qui a été tranché autrement que dans le plan, et pourquoi
- **Les anciens ids de 32 hex ne sont pas réécrits.** Ils sont déjà des
  UUID valides pour Postgres (sans tirets). Les réécrire casserait les
  `document_id` des citations dans l'historique chiffré des autres
  appareils, et les ids en cache sur l'iPhone. La synchronisation les
  comparera sous forme canonique.
- **L'importance des souvenirs reste dans les étiquettes** (`minor`,
  `important`, `pinned`). C'est le format du coffre chiffré (contrat
  `memory`) ; une colonne dupliquerait la même information.
- **`deleted_at`, `hlc` et `origin_device_id`** sur toutes les tables, et
  les clés étrangères manquantes (qui demandent de reconstruire des tables
  SQLite) : reportés à l'étape 5. Ils n'ont de sens qu'avec la
  synchronisation qui les lit ; les ajouter avant obligerait à filtrer
  toutes les lectures pour rien.

### Le compte (twoody-backend)
Voir le compte rendu de l'étape 2-3 dans le dépôt du backend (commits du 3
octobre).

## Migration 3 : d'où vient le titre (4 octobre 2026)

Les titres des conversations sont désormais écrits par le modèle après la
première réponse (`src/discussionTitles.ts`), comme ChatGPT et Claude.
`src/migrations/0003_title_source.ts` ajoute `discussions.title_source` :

- `question` : les ~60 premiers caractères de la première question, montrés
  tout de suite ; le modèle peut les remplacer ;
- `model` : écrit par le modèle ;
- `given` : donné exprès (le titre qu'un autre appareil a scellé dans
  l'historique chiffré, un futur renommage) ; jamais remplacé par le modèle ;
- `NULL` : conversations d'avant la migration.

Colonne **propre au Mac** : elle n'est pas dans `schema/contract.json`, le
compte n'écrivant pas de titres. À y ajouter (avec `title_source` côté
Rails) le jour où le cloud en générera.

## Migration 4 : les e-mails (4 octobre 2026)

La capacité « E-mails » (Jimmy : « IMAP d'abord ») garde sur l'ordinateur
une copie de la boîte mail lue en IMAP (`src/email/`).
`src/migrations/0004_emails.ts` crée :

- `email_sources` : la boîte réglée (adresse, serveur IMAP, état de la
  synchronisation), comme la table `email_sources` du compte (Gmail) ; le mot
  de passe n'y est jamais (`email-credentials.json`, 0600, hors de la base et
  de ses sauvegardes) ;
- `email_folders` : INBOX, Envoyés et Brouillons, avec UIDVALIDITY et le
  dernier UID lu ;
- `emails` : les messages, avec les noms de la table `emails` du compte
  (`from_email`, `to_email`, `text_body`, `body_format`, `is_read`,
  `is_replied`, `provider_message_id`, `provider_thread_id`,
  `provider_label_ids`, `provider_internal_date`, `attachment_metadata`,
  `metadata`, `trashed_at`) ; dates en millisecondes, JSON sans suffixe,
  identifiants UUID ; `recipients`, `people`, `uid`, `sent_at` en plus ;
- `email_fts` : l'index plein texte (objet, personnes, texte), à contenu
  externe, tenu par des déclencheurs.

Tables **propres au Mac** : pas dans `schema/contract.json`, le compte lisant
Gmail lui-même. À y ajouter le jour où une boîte IMAP vivra aussi sur le
compte.

Une boîte Outlook.com ou Microsoft 365 lue par Microsoft Graph
(`src/email/graphMailbox.ts`, `auth: "graph"` dans `email_sources.metadata`)
n'a demandé aucune migration : un message n'y a pas d'UID (`uid` vide),
son identifiant Graph est dans `emails.metadata.graph_id`, et où en est la
synchronisation de chaque dossier (le lien `@odata.deltaLink` de Graph) dans
`email_sources.metadata.graph_folders`.

## Migration 5 : la banque (4 octobre 2026)

La capacité « Banque » (Jimmy : « import de relevés pour la banque », sans
connexion directe à la banque pour l'instant) garde sur l'ordinateur les
relevés que la personne importe (CSV, OFX/QFX, QIF ; `src/bank/`).
`src/migrations/0005_bank.ts` crée :

- `bank_accounts` : un compte par compte trouvé dans les relevés, avec les
  noms de la table `bank_accounts` du compte (`name`, `iban`, `ref`,
  `currency`, `product`, `status`, `balance_at`) ; le solde en centimes
  (`balance_cents`, le compte garde un flottant `balance`), le dernier qu'un
  relevé a donné ; `bank_name` (le compte le tient de `bank_authorizations`)
  et `number_tail` (les derniers chiffres d'un numéro masqué, « ****4521 »)
  en plus ;
- `bank_imports` : un import par relevé (nom du fichier, format, période,
  nombres d'opérations lues, ajoutées, déjà présentes, le solde qu'il donne,
  la disposition des colonnes d'un CSV) ;
- `bank_transactions` : les opérations, avec les noms de la table
  `bank_transactions` du compte (`booking_date`, `value_date`, `info` pour le
  libellé, `creditor_name` / `debtor_name` pour le tiers, `code`, `ref`,
  `comment`) ; montants en centimes (`amount_cents`), jours en millisecondes
  (00:00 UTC) ; `category`, `category_source` (`rule` ou `person`) et
  `fingerprint` (jour, montant, libellé, rang parmi les lignes identiques du
  même fichier : unique par compte, un relevé qui en recoupe un autre n'ajoute
  que le nouveau) en plus ;
- `bank_transaction_imports` : quels imports contenaient chaque opération,
  pour que supprimer un import garde ce qu'un autre contient aussi ;
- `bank_category_rules` : les catégories choisies par la personne pour un
  tiers, appliquées aux imports suivants.

Tables **propres au Mac** : pas dans `schema/contract.json`, rien de la
banque n'allant au compte, et les tables du compte n'ayant pas la même forme
(montants flottants, `bank_authorization_id` obligatoire, dates en `date`).
Le contrat étant copié tel quel dans twoody-backend, y ajouter ces tables
demandera la même modification côté Rails.

## Contrat v2 et renommages de l'audit (17 octobre 2026)

Audit du jour : `docs/schema-audit-2026-10-17.md` (13 écarts). Feu vert de Jimmy le même jour (« applique l'audit »).

### Le contrat v2 (`schema/contract.json`, recopié dans `twoody-backend/config/schema_contract.json`)
- **Tout est classé.** Chaque table des deux bases est dans `tables` (partagée), `local_only`, `account_only` ou
  `same_name` (le même nom pour deux choses : local seulement ici, compte seulement là-bas), avec sa raison ; chaque
  colonne d'une table partagée est dans le contrat ou dans `local_columns` / `account_columns`, avec sa raison. Les
  raisons communes sont dans `reasons` (`@local_user`, `@legacy`…). 12 tables partagées (`folder_shares` en plus),
  36 locales seulement, 110 du compte seulement, 12 `same_name`.
- **Valeurs vérifiées des deux côtés.** Le Mac compare `values` aux constantes du code (`MESSAGE_ROLES`, `TRACE_KINDS`,
  `MEMORY_KINDS`, `PROJECT_SIZES`, `PROJECT_STATUSES`, `PROJECT_SOURCES`, `CONTACT_RELATION_TYPES`, `SHARE_KINDS`,
  `SHARE_RIGHTS`, `REVOKED_REASONS`), le compte à la validation `inclusion` du modèle, à l'égalité. Un écart connu
  s'écrit `local_values` / `rails_values` + `gap` ; le test échoue quand l'écart se referme, pour que la note parte.
- **Références.** Type `ref` (`{"type": "ref", "to": "projects"}`) : TEXT sur le Mac ; `uuid` sur le compte, la table
  visée ayant son UUID. `rails_bigint` (une raison) tant que le compte pointe encore par son id bigint : le test du
  compte vérifie qu'il est toujours bigint, la note part quand c'est corrigé.
- **Projets cloisonnés** (`never_leave.walled_projects`) : un projet `isolated = 1` et chaque ligne qui lui appartient
  (conversations, messages, traces, propositions de mémoire, tâches, rappels, événements, partages de son dossier) ne
  quittent jamais l'ordinateur ; une conversation d'un projet cloisonné n'est jamais `cloud_models`. Le crochet de la
  future synchronisation : `src/sync/walls.ts` (`leavingWhere(table)` à ajouter à sa lecture, `mayLeave(db, table,
  id)`, seulement les tables partagées) ; son test appelle `test/helpers/walls.ts` `assertWallsHold` avec ce qu'elle
  enverrait (aucune ligne cloisonnée, toutes les autres). Le test du contrat vérifie que la règle du code est celle du
  contrat et que toute table partagée qui peut tenir une ligne d'un projet est nommée (ou dite `not_concerned`) ; celui
  du compte qu'il n'y a ni `projects.isolated` ni `project_notes`.
- **Tests** : `test/schemaContract.test.ts` (Mac) et `test/schema_contract_test.rb` (compte) échouent sur ce qui n'est
  pas classé, ce qui est listé et n'existe plus, un type, une valeur ou une référence qui dérive.

### Les renommages (migrations 13 à 15 du Mac, `20261017100000` du compte)
- **Migration 13** (`0013_folder_share_names.ts`) : `folder_shares."right"` → `access_right`, `label` →
  `folder_label`, `revoked_by` → `revoked_reason` (les mots du compte, `host` compris : il était rangé en `owner`,
  il est gardé tel quel). L'API `/local_shares` garde `label`, `right` et `revoked_by`, que les apps lisent.
- **Compte, `20261017100000`** : `folder_shares.share_uuid` → `uuid` (et son index unique). Le JSON disait déjà
  `uuid` ; la clé `share_uuid` du `principal` des tâches du relais et des événements d'audit des organisations ne
  change pas (contrat de fil, lu par les ordinateurs). L'id bigint reste (`bridge_tasks.folder_share_id`).
- **Migration 14** (`0014_people_rows.ts`) : `entities.removed_at` → `archived_at` (caché mais rétablissable, le mot
  du compte) ; l'API de `/people` dit `archived_at`, et `removed_at` aussi pendant une version (aucune app ne le lit) ;
  `entity_relations` reconstruite avec `id` (UUID), `created_at`, `updated_at` (unicité de la paire et du libellé
  gardée, ordre des lignes gardé, une relation d'avant datée du plus tard des deux personnes) ; une relation récrite
  telle quelle garde son id et ses dates (`putRelation`) ; `entity_contacts.updated_at` (= `created_at` au départ).
- **Migration 15** (`0015_peer_document_audit.ts`) : `peer_document_audit.at` → `occurred_at` ; la table n'est plus
  créée ni complétée par `src/peerDocuments/audit.ts` (la migration 8 fait tout). L'API garde `at`.
- Chaque migration regarde avant d'agir : rejouée, elle ne change rien. Essais : base de version 12 fabriquée avec des
  lignes dans chaque table touchée (`test/migrations.test.ts`) ; copie lue seule de la base du Pi (version 12, 79
  tables, 1 646 lignes d'audit, aucun partage ni proche) : migrée en 22 ms, aucun nombre de lignes changé,
  `integrity_check` ok, `foreign_key_check` vide, rejouée sans effet ; copie mise à la Corbeille. Côté compte : sur
  la base de test, deux partages insérés, `up`, `up` encore, `down`, `down` encore, `up` : lignes et valeurs gardées,
  index renommé, le tout annulé ensuite. La base chiffrée du Mac de Jimmy n'a pas été copiée (il faut son accord au
  trousseau).

### Ordre de publication
1. **Compte** (indépendant des versions des apps : l'API ne change pas) : `maintenance:on`, push, `db:migrate`,
   `ps:restart`, `maintenance:off` — le code qui lit `uuid` et la migration partent ensemble (entre les deux, les
   routes des dossiers partagés échoueraient). Aucune version du Desktop, de l'iPhone ou du Pi n'en dépend.
2. **Desktop** (0.13.104, avec ce serveur) : la base de chacun passe de la version 12 à 15 au premier lancement, après
   la copie de sauvegarde habituelle. Une version d'avant (0.13.103) refuse ensuite cette base (« newer than this
   server »), comme à chaque migration.
3. **iPhone** : rien à publier (aucun appel changé ; il lit `removed`, pas `removed_at`).
4. **Pi** : le même serveur, après le Desktop.
5. Une version plus tard : retirer `removed_at` de l'API de `/people`.

### Points ouverts (à faire plus tard)
- **Références par UUID côté compte** : `discussions.project_id`, `messages.discussion_id`, `memories.superseded_by_id`,
  `tasks.project_id`, `reminders.project_id` sont des bigint vers `id` (`rails_bigint` dans le contrat) ; les passer en
  UUID (colonnes `*_id` uuid vers `uuid`, ou tables nouvelles en `id: :uuid`), et les ids de personnes du Mac
  (`folder_shares.grantee_user_id`) par `users.uuid`.
- **`organizations.uuid`** : à ajouter avant qu'une organisation soit synchronisée (`folder_shares.organization_id`
  est l'id du compte en texte sur le Mac).
- **Étape 5, alignements restants** : `events` (`location` contre `address1…zipcode`/`address_id` ; `source`,
  `external_id`, `calendar` sur le compte ; `project_id` sur le compte), `memory_candidates` (les colonnes du Mac
  contre celles de l'ancien `memory_imports`), `discussions` (`updated_at` / `last_activity_at`, `memory_mode`,
  `summary`), `projects` (`slug`, `archived_at` sur le Mac ; `source` : les mots du compte user, proactive, flow,
  import contre manual, learned, account ; `status` « blocked » absent du Mac), `reminders.origin` sur le Mac,
  `memories.entity_id` (polymorphe des deux côtés, pas la même chose), `hlc`, `deleted_at`, `origin_device_id`.
- **Le graphe** (étape 4) : `entity_relations.kind` (41 sortes), `source` et `how` entrent dans le contrat le jour où
  le compte crée `entities`.
- **Noms de l'API locale** : `/local_shares` dit encore `label`, `right`, `revoked_by` (les colonnes ont les noms du
  compte) ; l'API du compte dit `folder_label` et `right`. À rapprocher avec une version des apps qui lit les deux.
