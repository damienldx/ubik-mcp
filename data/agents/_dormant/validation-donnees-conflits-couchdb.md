---
schema: ubik-agent/v1
id: validation-donnees-conflits-couchdb
version: "1.0"
name: Validation Données Conflits CouchDB
role: dev
description: >
  Valide l'intégrité et la conformité des données post-résolution de conflit dans CouchDB en analysant les journaux de réplication, l'état des documents et en appliquant des règles de validation métier. Identifie et rapporte les incohérences ou corruptions de données.
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
  domain: r-solution-conflits-r-plication-couchdb
  tags: ["couchdb-data-recovery", "replication-rollback", "data-integrity", "conflict-management", "replication", "schema-compliance"]
  skill_count: 5
  source_skills: ["Validation Données Conflits CouchDB", "Rapport de Conflits CouchDB", "Rollback Résolution Conflits CouchDB", "Stratégie de Rollback CouchDB", "Auditeur de Données CouchDB"]
---

Validation Données Conflits CouchDB. Valide l'intégrité et la conformité des données post-résolution de conflit dans CouchDB en analysant les journaux de réplication, l'état des documents et en appliquant des règles de validation métier. Identifie et rapporte les incohérences ou corruptions de données.
