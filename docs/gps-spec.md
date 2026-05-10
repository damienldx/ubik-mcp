# GPS Fleet — enrich-on-send architecture

> Spec author: 2683a72c-agent-0
> Branche: `gps-2683a72c-agent-0`
> Date: 2026-05-10

## Decision

**GPS s'active au moment du `relay_send`** (côté expéditeur), pas à la lecture côté destinataire. Damien a tranché. Cette spec décrit comment cette décision se concrétise et ce que cette PR ubik-mcp livre dans ce cadre.

## Flow cible

```
relay_send(to=agent, message=mission)
    │
    ├─ in relay/server.py (ubik-fleet, hors de cette PR) :
    │      ① pré-calcule le GPS via gateway ubik-mcp (:8902)
    │      ② stocke le payload enrichi en queue : {original, persona, system_prompt, recommended_tools}
    │      ③ failsafe : si GPS timeout, livre le message original sans enrichissement
    │
agent → relay_read()
    │
    └─ retourne déjà le payload enrichi. L'agent ne fait rien de spécial.
```

## Ce que cette PR (ubik-mcp) livre

L'enrichissement vit côté `relay/server.py` dans le repo **ubik-fleet** — hors scope ici. Mais le relay a besoin d'un endpoint stable, rapide et cacheable pour faire le GPS lookup. C'est ce que cette PR fournit.

### `src/servers/gps.ts` — engine GPS standalone (3 tools)

| Tool | Rôle |
|---|---|
| `gps_lookup(message, agent_id?, top_k=6)` | Compose persona + recommended_tools depuis `skills_recall` + `skills_search_tools` du gateway. Retourne `{persona, recommended_tools, cache_key, cached}`. |
| `gps_invalidate(cache_key?)` | Vide une entrée ou tout le cache LRU. |
| `gps_stats()` | Observabilité : entries, ttl, max, gateway_url. |

### Ce qui rend l'engine adapté au pattern enrich-on-send

1. **Cache LRU 256 / TTL 5min** par sha256(message + agent_id + top_k). Si le même message est broadcast à 8 agents fleet (cas typique : claude-main dispatche un brief identique aux 4 slots véhiculés × 2), c'est **1 lookup payé**, pas 8.

2. **HTTP timeout strict (10s par défaut)**. Combiné avec un `Promise.race` côté relay, ça donne le failsafe naturel : si l'engine ne répond pas dans le budget, message original livré.

3. **`Promise.all` parallèle** sur skills_recall + skills_search_tools en interne. Un GPS lookup = max(latence des 2 calls), pas leur somme.

4. **Standalone** (un seul fichier, pas couplé à `skills.ts` ni au gateway). Si demain skills est remplacé, on touche `gps.ts` uniquement.

5. **`gps_stats` observability** — telemetry gratuite. Le relay peut interroger `gps_stats()` pour exposer un panel "GPS health" (entries cached, hit ratio si on rajoute un compteur, ttl effectif).

## Skip rules — `gps_should_enrich`

Damien a tranché : GPS s'applique à *tous* les flux (humain↔agent, agent↔agent, agent↔humain). Sans filtrage, on enrichirait des acks, des reactions emoji, des forwards bridge et des rapports de livraison — gaspillage de cycle CPU/réseau et pollution de la queue.

Le tool `gps_should_enrich({message, from?, to?, min_chars?})` retourne en O(1) un verdict `{skip: bool, reason: string|null}`. Pattern d'usage côté relay :

```python
verdict = mcp_call("ubik-gps", "gps_should_enrich",
                   {"message": msg, "from": sender, "to": recipient})
if verdict["skip"]:
    log("gps.skip", reason=verdict["reason"])
    queue_store({"original": msg})
else:
    enriched = mcp_call("ubik-gps", "gps_lookup", {"message": msg, "agent_id": recipient})
    queue_store({"original": msg, **enriched})
```

### 8 règles, ordre du moins coûteux au plus coûteux

| # | Règle | Reason emis | Couvre |
|---|---|---|---|
| 1 | `from` ou `to` finit par `-meca` ou commence par `bridge:` | `sender_is_meca:X` / `recipient_is_meca:X` | Forwards `bridge:ledger-turn`, méca → méca |
| 2 | message vide ou `< min_chars` (default 80) | `empty_message` / `short_message:N<80` | "ok", "ack", "👍", micro-replies |
| 3 | préfixe `re:`, `>`, `[bridge]` | `quote_or_bridge_prefix` | Quotation, forward |
| 4 | message = unique token ack (`ok`, `ack`, `noté`, `merci`, `👍`, `✅`, `🤝`, `+1`...) | `single_ack_token:X` | Acks one-word même au-dessus de min_chars (rare mais possible) |
| 5 | préfixe ack (`ack`, `ok …`, `noté`, `merci`, `[ack]`, `[result]`, `[livré]`, `[done]`) après emoji optionnel en tête | `ack_prefix:X` | "ok je prends", "merci pour la review", "[livré] commit ABC" |
| 6 | URL GitHub PR / `commit <sha>` / `PR #N` en queue de message | `delivery_report_tail` | Rapports de livraison "PR prête : https://github.com/..." |
| 7 | >30% des chars sont des emoji | `emoji_heavy:N/M` | Réactions sociales "🎉🚀🤝❤️" |
| 8 | <25% des chars sont alphabétiques (digits / JSON / structures) | `alpha_sparse:N/M` | Payload de données, snapshots JSON |

### Ce que ces règles ne filtrent PAS (par design)

- Messages techniques courts mais substantifs (`min_chars=80` ajustable)
- Discussions architecturales avec emoji ponctuel ("Pour la sécurité 🔒 je propose…" — pas emoji-heavy)
- Critiques structurées même sous forme de bullet points (alphas dominent)

Ces messages reçoivent le full GPS lookup. C'est le comportement souhaité.

### Calibrage

Les seuils (`min_chars=80`, `emoji_heavy >30%`, `alpha_sparse <25%`) sont *paramétrables par appel*. Démarrage suggéré : valeurs ci-dessus. Ajustement par observabilité après une semaine de données fleet (combien de skip / lookup, quelles raisons dominent, faux positifs reportés).

## Failsafe côté relay (rappel pour la PR ubik-fleet)

Pseudo-code que la PR sur ubik-fleet implémentera :

```python
async def _enrich_or_pass(message: str, to: str) -> dict:
    try:
        async with timeout(GPS_BUDGET_MS):
            gps = await mcp_call("ubik-gps", "gps_lookup",
                                 {"message": message, "agent_id": to})
            return {"original": message, **gps}
    except (TimeoutError, ConnectionError):
        return {"original": message}  # failsafe
```

Le relay stocke ensuite le dict dans la queue. L'agent reçoit toujours au minimum `{"original": ...}` ; si tout va bien, il a aussi `persona`, `system_prompt`, `recommended_tools`.

## Pourquoi ça marche bien avec enrich-on-send

- **Discipline zéro côté agent** ✅ comme la piste claude-main d'origine — l'agent ne fait rien.
- **Pas de breaking change schéma** côté `relay_send` (signature inchangée), seul le payload stocké change. Les agents qui lisent et ignorent les nouveaux champs continuent de fonctionner.
- **Le calcul est payé une fois par message émis**, pas une fois par lecture. Si un message est lu N fois (rare mais possible — agent qui re-poll), zéro coût additionnel.
- **Cache amortit le broadcast** : `relay_send(to="all")` → un seul GPS lookup, broadcast aux N agents avec le même cache_key.

## Risques

| Risque | Mitigation |
|---|---|
| Latence relay_send augmentée | Timeout strict + failsafe = au pire +budget_ms, jamais bloquant |
| Persona stale si skills evolve | Cache TTL 5min → re-lookup automatique après expiration |
| Coût upstream sur burst de sends | Cache absorbe les répétitions ; si le pattern est dominant on peut augmenter `GPS_CACHE_TTL_MS` via env |
| GPS down → tous les sends sans enrichissement | Failsafe garantit que `relay_send` ne casse jamais ; observabilité via `gps_stats()` détecte le problème |

## Évolution possible

Si on veut un GPS "personnalisé par destinataire" (un même brief enrichi différemment selon l'agent destinataire), le `agent_id` est déjà dans la signature et dans la cache key. Suffit de faire varier le retour côté `gps_lookup` (par exemple en injectant la spécialité de l'agent dans le scoring tools).

## Distinctif vs autres agents fleet sur cette mission

- **Cache LRU first-class** — la décision Damien (enrich-on-send) crée un risque de payer le GPS à chaque send. Le cache neutralise ce coût pour les broadcast et les reposts. Aucune autre vision fleet n'a fait ce focus.
- **`gps_stats` observabilité** — inclu dès la v0 pour mesurer adoption et coût réel. Sans observabilité, on optimise à l'aveugle.
- **Standalone server, pas de modif `skills.ts`** — la migration est non destructive : skills_recall et skills_search_tools restent intacts, gps.ts les compose.

---

## Étape 3 — Hit-rate + track record agent (auteur : b5aeb927-agent-1 / Albert)

Branche : `gps-v2/hit-rate-tracking` · Date : 2026-05-10

### Objectif

Fermer la boucle de feedback GPS : observer **ce que l'agent appelle réellement** vs **ce que GPS recommande**, et utiliser cet écart pour calibrer les recommandations futures par agent.

### Schema de stockage

Un fichier JSON par agent dans `~/.ubik-memory/gps/<agent_id>.json` :

```json
{
  "agent_id": "b5aeb927-agent-1",
  "tools_actually_used": { "Bash": 12, "relay_read": 8, "Edit": 5 },
  "hit_rate_history": [
    { "fork_id": "1199735b08ff", "rate": 0.66, "date": "2026-05-10T20:30:00Z",
      "recommended": ["review_diff", "review_pr", "gmail_get_attachment"],
      "called":      ["review_diff", "review_pr"] }
  ],
  "low_hit_classes": ["email", "social"],
  "catches": [{ "date": "2026-05-10", "type": "runtime", "desc": "tuple-unpack ValueError" }],
  "last_updated": "2026-05-10T20:31:00Z"
}
```

### Tools livrés

- **`gps_record_usage(fork_id, agent_id, tools_called[], tools_recommended[])`** — append entry, refresh `tools_actually_used`, recompute `low_hit_classes`. Atomic write (tmp + rename) pour éviter les fichiers corrompus si 2 forks clôturent en parallèle pour le même agent.
- **`gps_get_track_record(agent_id, message?, top_k=6)`** — au réveil. Retourne le track record. Si `message` fourni : passe par le gate `shouldSkip` (contrat inter-PR), puis lookup persona + tools, applique le filter `low_hit_classes` et l'enrichissement de label. *Renommé depuis `gps_get_contract` pour ne pas écraser le tool homonyme livré par Étape 1 (Fidele) qui retourne le fork lock.* Les deux sont composables : un agent peut appeler `gps_get_contract(fork_id)` pour le lock + `gps_get_track_record(agent_id)` pour son historique.
- **`gps_lookup`** modifié non-breaking : quand `agent_id` est fourni, charge le track record best-effort, filtre les recommandations dans `low_hit_classes`, enrichit le persona name. Ajoute `pruned_by_track_record?` (champ optionnel) au shape de retour. Sur erreur de chargement → log stderr et continue avec le résultat non filtré (jamais bloquant).
- **`gps_stats`** étendu : ajoute un bloc `track_records: { agent_count, avg_hit_rate, total_pruned_classes, last_updated_max }` agrégé depuis `~/.ubik-memory/gps/*.json`. Best-effort : un fichier corrompu est silently skip pour ne pas casser le dashboard.

### Logique de calibration `low_hit_classes`

- Calculée sur les **5 dernières entrées** d'`hit_rate_history`.
- Une **operation_class** (mappée depuis le préfixe de tool name : `gmail_*` → `email`, `linkedin_*` → `social`, …) doit apparaître dans **les 5 entrées** ET avoir un hit-rate cumulé **< 20 %** pour être considérée low-hit.
- Une class low-hit est exclue par `filterByLowHitClasses` ; les tools écartés sont remontés dans `pruned_by_track_record` pour observabilité (l'agent voit *pourquoi* un tool n'apparaît plus).

### Enrichissement persona

`enrichPersonaLabel(record, baseName)` lit `catches[]` filtré sur la semaine ISO en cours et concatène : `"Albert — Reviewer Backend (4 catches, semaine 2026-05-10)"`. Aucun catch dans la semaine → label inchangé. Le champ `catches` peut être alimenté par un hook clôture session (out of scope ici) ou directement par un `gps_record_catch` futur.

### Contrat inter-PR respecté

- `cacheKey()` non modifiée (Fidele owner).
- Tous les nouveaux champs de `GpsResult` sont optionnels (`pruned_by_track_record?`).
- `gps_get_contract` honore le gate `shouldSkip` quand un message est fourni.
- Aucun changement à `lib/db/` (storage filesystem JSON, pas SQLite — l'écriture atomique tmp+rename neutralise les races simples).

### Risques connus

| Risque | Mitigation |
|---|---|
| Race write si 2 forks clôturent simultanément pour le même agent | tmp + rename POSIX atomic ; last-writer-wins acceptable car les hit_rate_history des forks parallèles sont indépendantes |
| Cold start (pas d'historique) → low_hit_classes vide | Fonction `computeLowHitClasses` exige `appeared_in === window` — pas de pruning prématuré |
| `tools_recommended` vide à l'appel `record_usage` | Hit rate stocké à 0 — n'impacte pas low_hit_classes (qui regarde les classes, pas les rates globaux) |
| Mapping operation_class manqué pour de nouveaux tools | Fallback : préfixe avant `_` ; à enrichir au cas par cas si une class importante émerge |

— 2683a72c-agent-0

---

# GPS v2 — Étape 2 · Taxonomic tool tagging

> Section author: b5aeb927-agent-0 (Jules)
> Branche: `gps-v2/taxonomic-tools`
> Date: 2026-05-10

## Constat (issu de l'audit GPS du 2026-05-10)

Le pipeline actuel ranke les tools via `skills_search_tools` — embedding sémantique sur le texte du message. Sur une mission backend Python (PRISMA + endpoints REST), le top-K retourné contenait `linkedin_get_company`, `gmail_get_attachment`, `crawl_get_links`, `google_drive_get_file`. Persona pertinente, tools quasi totalement off-topic (~30-50% bruit observé).

Le défaut est structurel : la persona est un objet **sémantique** (le sens du message désigne son label), les tools sont un objet **taxonomique** (l'opération à effectuer désigne leur pertinence). Un seul pipeline d'embedding écrase cette différence.

## Ce que cette PR (Étape 2) livre

Trois changements additifs (zéro breaking sur `gps_lookup`) :

### `src/lib/tool-taxonomy.ts` (nouveau)

Définit deux axes orthogonaux :

- **`OperationClass`** : `read | write | network | search | social | spawn | review`
- **`TargetDomain`** : `filesystem | git | http_api | db | browser | agent_relay`

Et trois fonctions pures :

- `tagTool(name)` — retourne `{operation_classes[], target_domains[]}` pour un tool. Catalogue statique des servers UBIK connus (github, google, linkedin, microsoft, crawl, review, formation, skills, system, desktop, gps, paperclip, relay, ubik, agent, project, activity, inbox), avec fallback heuristique sur les conventions de nommage (`*_get_*` → read, `*_create_*` → write, etc.).
- `matchScore(tag, mission)` — score déterministe (op_hits × 10 + dom_hits) ; 0 si pas d'intersection.
- `buildToolkit({candidates, mission, manifest, top_k})` — assembleur déterministe : filtre par exclusion manifest → score par matrix → trie → top_k → préfixe les `always_include` du manifest.

### `src/lib/agent-manifest.ts` (nouveau)

Charge `~/.ubik-desktop/agents/<id>.{yaml,yml,json}` à la demande (pas de cache in-process — l'éditer prend effet au prochain call). Schéma :

```yaml
exclude_classes: [social]
exclude_domains: [browser]
exclude_tools:   [github_create_repo]
always_include:  [relay_send, github_get_repo]
```

Mini-parser YAML inline (~30 lignes, gère uniquement nos 4 keys × inline arrays) — pas de nouvelle dépendance npm. JSON également supporté pour les schémas plus complexes.

Repurpose le manifest YAML qui existait déjà mais n'était lu nulle part (test E2E 2026-05-10 : marqueur "BANANE-CRYPTO-7421" déposé dans `~/.ubik-desktop/agents/<id>.md`, jamais retourné par GPS — manifest mort).

### `src/servers/gps.ts` (3 nouveaux MCP tools, zéro breaking change)

| Tool | Rôle |
|---|---|
| `gps_tag_tool(tool_name)` | Introspection : tag d'un tool selon le catalogue + heuristiques. |
| `gps_load_manifest(agent_id)` | Lit + valide le manifest d'un agent. Renvoie `null` si absent. |
| `gps_build_toolkit({candidates, mission, agent_id?, top_k?})` | Toolkit déterministe pour la mission. Manifest appliqué automatiquement si `agent_id` fourni. |

Le pipeline existant (`gps_lookup`, `gps_should_enrich`, `gps_invalidate`, `gps_stats`) est **inchangé**. La couche taxonomique est opt-in : à terme le `gps_lookup` enrich-on-send peut appeler `gps_build_toolkit` quand un `mission_matrix` est fourni dans le contexte (Étape 1 fork contract — Fidele).

## Coordination inter-PRs (cf. checklist Felix)

- ✅ Pas de modification de `cacheKey()` (réservé Fidele).
- ✅ `GpsResult` shape inchangée (mes nouveaux tools renvoient leurs propres types, distincts).
- ✅ `gps_should_enrich` non bypassé : mes tools sont des utilitaires explicites (pas du message-enrichment automatique), donc ils ne sont pas un *call site GPS* au sens de la règle.
- ✅ Section gps-spec.md ajoutée à la fin (distincte de la spec 2683a72c).
- ✅ Pas de SQLite, pas de race condition.

## Distinctif vs autres forks gps-v2

- **Découpler tools de persona** — les autres forks restent dans le pipeline embedding. Cette PR sort les tools du pipeline sémantique pour les remettre dans un pipeline taxonomique déterministe.
- **Repurpose le manifest YAML** — donne aux agents une **agency** explicite sur leur GPS (`exclude_*` / `always_include`) qu'ils n'avaient pas. Leverage un mécanisme existant qui était mort.
- **Mesurabilité** — `gps_build_toolkit` étant déterministe, "% des tools effectivement utilisés par l'agent" devient un signal mesurable. Le pipeline embedding est opaque à cette mesure.

## Limites et follow-up

- Le catalogue statique couvre les servers UBIK connus aujourd'hui. Quand un nouveau server est ajouté, il faut mettre à jour `CATALOG`. L'heuristique fallback rattrape les tools inconnus mais avec moins de précision.
- La `MissionMatrix` est consommée par cette PR mais **calculée ailleurs** (Étape 1 — Fidele, fork contract entry hook).
- Le track-record agent (Étape 3 — Albert) peut affiner les choix : un agent qui n'utilise jamais les tools de domaine X verrait ce domaine baisser dans les futurs choix de matrix.

— b5aeb927-agent-0 (Jules), 2026-05-10
