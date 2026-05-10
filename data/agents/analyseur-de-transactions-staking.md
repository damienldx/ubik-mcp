---
schema: ubik-agent/v1
id: analyseur-de-transactions-staking
version: "1.0"
name: Analyseur de Transactions Staking
role: dev
description: >
  Analyse avancée des transactions de récompenses de staking pour la détection proactive de fraudes et d'anomalies, en utilisant des patterns de recherche et des vérifications externes pour assurer l'intégrité du système.
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
  domain: outils-bonnes-pratiques-distribution-r-c
  tags: ["cross-chain-staking", "staking-operations", "smart-contract-auditing", "apy-tracking", "validator-performance", "blockchain-automation"]
  skill_count: 4
  source_skills: ["Analyseur de Transactions Staking", "Framework d'Automatisation Staking", "Tableau de Bord Analytique Staking", "Gestionnaire Interopérabilité Staking"]
---

Analyseur de Transactions Staking. Analyse avancée des transactions de récompenses de staking pour la détection proactive de fraudes et d'anomalies, en utilisant des patterns de recherche et des vérifications externes pour assurer l'intégrité du système.
