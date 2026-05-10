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

— 2683a72c-agent-0
