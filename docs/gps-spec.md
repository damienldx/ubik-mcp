# GPS Fleet — Pull-based opt-in design

> Spec author: 2683a72c-agent-0
> Branche: `gps-2683a72c-agent-0`
> Date: 2026-05-10

## TL;DR

Au lieu d'enrichir le payload de `relay_read` avec persona + tools (piste claude-main), j'expose **un endpoint séparé `/gps/lookup`** que l'agent peut interroger volontairement, avec **un signal léger dans la wakeup notification** pour pousser l'usage. Trois bénéfices nets :

1. **Zéro breaking change** sur le schéma `relay_read` existant.
2. **Cache HTTP** côté serveur — un message lu N fois = 1 lookup payé.
3. **Découplage logique** — la composition (skills_recall + skills_search_tools) vit dans un endpoint dédié, pas dans le hot-path du relay.

## Problème

Aujourd'hui un agent fleet doit faire (en bonne discipline) :

```
relay_read(agent_id="X")           → "Mission Y"
skills_recall("Mission Y")          → suggested persona
skills_search_tools("Mission Y")    → suggested tools
adopt persona + tools               → travailler
```

Trois call MCP avant la première action utile. Conséquences :
- Discipline non auto-appliquée → la majorité des agents skip.
- Coût de latence cumulé sur chaque message reçu.
- Re-calcul à chaque lecture du même message (pas de cache).

## Piste claude-main (rappel)

Enrichir directement à l'intérieur de `relay_read`. Le retour devient :

```json
{
  "message": "...",
  "persona": "...",
  "system_prompt": "...",
  "recommended_tools": ["...", "..."]
}
```

Forces : zéro discipline. Faiblesse : breaking change pour les agents qui parsent le retour, latence forcée sur chaque lecture, couplage skills↔relay.

## Ma piste — pull-based opt-in via `/gps/lookup`

### 1. Nouveau MCP tool `gps_lookup`

Standalone (un fichier `src/servers/gps.ts`), expose un tool unique qui prend un texte de message et retourne une recommandation typée :

```ts
gps_lookup({
  message: string,
  agent_id?: string,
  top_k?: number,
}) → {
  persona: { id, name, system_prompt, confidence } | null,
  recommended_tools: Array<{ name, server, score }>,
  cache_key: string,
}
```

En interne, `gps_lookup` appelle `skills_recall` + `skills_search_tools` du gateway et compose le résultat. **Cache LRU 5 minutes** par `(message_hash, agent_id, top_k)` — réduit le coût quand un agent re-lit le même message.

### 2. `relay_read` reste inchangé

Pas de modification du schéma. Le seul ajout *optionnel* est un champ `gps_hint: "/gps/lookup?msg=<id>"` dans la réponse — backward-compatible (les agents qui ignorent le champ continuent de marcher).

### 3. Wakeup notification enrichi (côté relay/server.py)

Quand le relay envoie le wakeup hint à l'agent (le message `tmux send-keys` qui dit "Tu as un message"), ajouter une ligne :

```
You have a new message. relay_read(agent_id=…). 🧭 GPS: gps_lookup(<message_id>).
```

Ça incite l'agent à fetcher la GPS *avant* de commencer à travailler, sans le forcer.

### 4. CLAUDE.md fleet — instruction ajoutée

Une ligne dans le protocole agent :

> Si tu reçois un message non-trivial (>200 chars OU contient un mot-clé technique), appelle `gps_lookup` avant d'agir. Le tool est cacheable, sans coût sur appels répétés.

## Comparaison

| Critère | Piste claude-main (enrich-in-relay_read) | Ma piste (pull-based opt-in) |
|---|---|---|
| Discipline agent | ✅ Zéro (auto) | 🟡 Light (1 line CLAUDE.md) |
| Breaking change | ⚠️ Schéma `relay_read` change | ✅ Aucun |
| Cache | ❌ Difficile (relay = stateful) | ✅ LRU 5min trivial |
| Coût latence par lecture | ❌ Forcé +200-500ms | ✅ Payé seulement si fetch |
| Couplage skills↔relay | ⚠️ Fort | ✅ Découplé |
| Migration progressive | ❌ Tous-ou-rien | ✅ Agent par agent |
| Testabilité | ⚠️ relay_read devient lourd | ✅ Tool isolé |
| Pollution contexte multi-msg | ⚠️ Persona X×N inonde | ✅ 1 persona par session |

## Évolution future

Si on observe que les agents ne fetchent pas assez (telemetry sur ratio `relay_read / gps_lookup`), on peut ajouter un mode **push** :

- Quand le relay envoie le wakeup, il pré-calcule le GPS et inclut un *résumé* (`persona_id`, `tools_count`) dans le hint
- L'agent peut alors décider de fetcher le full ou agir directement avec le résumé

Cette évolution est *additive*, pas un rewrite.

## Risques + mitigations

| Risque | Mitigation |
|---|---|
| Agents non updatés ignorent gps_lookup | Wakeup hint visible, doc CLAUDE.md, telemetry pour scorer adoption |
| Cache stale si skill library change | Invalidation manuelle via `gps_invalidate(message_id)` ou TTL court (5min) |
| `skills_recall` lent → `gps_lookup` aussi | Cache LRU + retours partiels (persona seul si tools timeout) |
| Charge cumulée si beaucoup d'agents fetchent même msg | Cache partagé serveur-side dédup la charge |

## Implémentation livrée dans cette PR

- `src/servers/gps.ts` — nouveau MCP server stdio standalone (~150 LOC). Un seul tool `gps_lookup`.
- `docs/gps-spec.md` — ce document.

Non livré ici (autre repo / autre PR) :
- Modif `relay/server.py` pour ajouter `gps_hint` au wakeup hint
- Update `CLAUDE.md` fleet pour le pattern d'usage

## Distinctif vs autres agents fleet

Je ne sais pas encore ce que les autres slots vont produire. Mon angle de différenciation :
1. **Pull > push** — l'agent garde le choix, ce qui est cohérent avec le pattern "discipline opt-in" qu'on a vu marcher en sidecar review.
2. **Cache first-class** — la plupart des designs MCP oublient le cache. Un `gps_lookup` cacheable est gratuit en répétition.
3. **Standalone server** — pas de modif du gateway, pas de couplage avec `skills.ts`. Si demain le composant skills est remplacé, on touche un fichier.

— 2683a72c-agent-0
