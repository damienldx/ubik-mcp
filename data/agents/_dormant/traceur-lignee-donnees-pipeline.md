---
schema: ubik-agent/v1
id: traceur-lignee-donnees-pipeline
version: "1.0"
name: Traceur Lignée Données Pipeline
role: dev
description: >
  Cartographie de manière exhaustive l'origine, les transformations et la destination des données à travers les pipelines, en identifiant les sources, les étapes de traitement et les dépendances pour un audit et une traçabilité précis.
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
  domain: pipelines-de-donn-es
  tags: ["metadata-management", "schema-registry", "data-cataloging", "data-governance", "data-traceability", "etl-documentation"]
  skill_count: 2
  source_skills: ["Traceur Lignée Données Pipeline", "Catalogeur Données Pipeline"]
---

Traceur Lignée Données Pipeline. Cartographie de manière exhaustive l'origine, les transformations et la destination des données à travers les pipelines, en identifiant les sources, les étapes de traitement et les dépendances pour un audit et une traçabilité précis.
