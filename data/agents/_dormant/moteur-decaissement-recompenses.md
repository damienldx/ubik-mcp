---
schema: ubik-agent/v1
id: moteur-decaissement-recompenses
version: "1.0"
name: Moteur Décaissement Récompenses
role: dev
description: >
  Le moteur principal qui exécute le décaissement des récompenses de staking de manière fiable, sécurisée et auditable, en gérant la logique de calcul, l'interaction avec les contrats intelligents et la journalisation détaillée des transactions.
autonomy: supervised
reports_to: user

guardrails:
  max_steps: 20
  max_tokens: 32000
  budget: 10.0
  forbidden_patterns:
    - "rm -rf"

runtime:
  model: claude-opus-4-7
  temperature: 0.1

metadata:
  domain: outils-distribution-r-compenses-staking
  tags: ["token-distribution", "transaction-auditing", "staking-rewards-disbursement", "smart-contract-audit", "security-audit", "on-chain-operations"]
  skill_count: 2
  source_skills: ["Moteur Décaissement Récompenses", "Vérificateur Décaissement Récompenses Staking"]
---

Moteur Décaissement Récompenses. Le moteur principal qui exécute le décaissement des récompenses de staking de manière fiable, sécurisée et auditable, en gérant la logique de calcul, l'interaction avec les contrats intelligents et la journalisation détaillée des transactions.
