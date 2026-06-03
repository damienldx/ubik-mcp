# Patch V1 — hook mandate-awareness : plan ID complet (t_1764850529)

**Cible** : `/home/damienldx/.claude/hooks/ubik-mandate-awareness.sh` (fichier opérateur,
non tracké, injecté dans les sessions de TOUTE la fleet → application réservée à la
séquence deploy groupé, arbitrage Chef d'Atelier 2026-06-03).

**Verrue** : l.197 `pid = p.get("id", "?")[:12]` — un plan id fait 13 chars
(`plan_` + 8 hex) → le hook affiche `plan_922765f` au lieu de `plan_922765fa` ;
tout copier-coller vers `ubik-wall open --plan` échoue.

**Application (pattern create-then-modify, .bak AVANT édition)** :

```bash
HOOK=/home/damienldx/.claude/hooks/ubik-mandate-awareness.sh
cp "$HOOK" "$HOOK.bak-$(date +%Y%m%d-%H%M%S)"   # rollback garanti
patch "$HOOK" < patches/ubik-mandate-awareness-full-plan-id.patch
```

**Validation post-application (1 ligne, lecture seule)** :

```bash
UBIK_AGENT_ID=6da176c2-agent-9 bash "$HOOK" | grep -o "plan_[0-9a-f]*" | awk '{print length($0), $0}'
# attendu : 13 chars par ID (ex: "13 plan_922765fa") — 12 = patch non appliqué
```

**Rollback** : `cp "$HOOK".bak-<ts> "$HOOK"`.
