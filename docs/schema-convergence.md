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
